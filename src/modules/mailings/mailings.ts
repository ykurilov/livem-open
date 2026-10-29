import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { bots, enqueueOutbound, outboundMessages, type ChannelKind } from "../channels";
import { inboundMessages } from "../conversations/schema";
import { InvalidPeopleFilterError, getPerson, parsePeopleFilter, people, type PeopleFilter } from "../people";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { isUuid } from "../platform/uuid";
import { mailingRecipients, mailings, type MailingStatus } from "./schema";

export type Mailing = typeof mailings.$inferSelect;

/** Что эксперт сделал не так: текст ошибки показывается в форме. */
export class MailingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailingError";
  }
}

export interface MailingServiceDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
}

export interface MailingDraft {
  text: string;
  imagePath?: string | null;
  filter: unknown;
  testPersonId?: string | null;
}

/** Длиннее мессенджеры режут на части; столько хватит любому письму. */
export const MAILING_TEXT_LIMIT = 4000;
/** Ответ в течение стольких дней после отправки считается ответом на рассылку. */
export const REPLY_WINDOW_DAYS = 7;

const MSK_OFFSET_MS = 3 * 60 * 60_000;

/** «2026-10-01T18:00» по Москве → момент времени. Так приходит поле `datetime-local` из формы. */
export function parseMskDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new MailingError("Укажите дату и время");
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) throw new MailingError("Такой даты нет");
  return new Date(utc - MSK_OFFSET_MS);
}

function checkedDraft(draft: MailingDraft): { text: string; imagePath: string | null; filter: PeopleFilter; testPersonId: string | null } {
  const text = draft.text.trim();
  if (!text) throw new MailingError("Напишите текст рассылки");
  if (text.length > MAILING_TEXT_LIMIT) throw new MailingError(`Текст длиннее ${MAILING_TEXT_LIMIT} знаков`);
  let filter: PeopleFilter;
  try {
    filter = parsePeopleFilter(draft.filter);
  } catch (error) {
    if (error instanceof InvalidPeopleFilterError) throw new MailingError(error.message);
    throw error;
  }
  const testPersonId = draft.testPersonId && isUuid(draft.testPersonId) ? draft.testPersonId : null;
  return { text, imagePath: draft.imagePath ?? null, filter, testPersonId };
}

export async function createMailing(db: DatabaseExecutor, draft: MailingDraft): Promise<Mailing> {
  const [row] = await db.insert(mailings).values(checkedDraft(draft)).returning();
  if (!row) throw new Error("Рассылка не сохранилась");
  return row;
}

/** Правка черновика. Запущенную рассылку менять нельзя. */
export async function updateMailingDraft(db: DatabaseExecutor, id: string, draft: MailingDraft): Promise<Mailing> {
  const values = checkedDraft(draft);
  const [row] = isUuid(id)
    ? await db.update(mailings).set(values).where(and(eq(mailings.id, id), eq(mailings.status, "draft"))).returning()
    : [];
  if (!row) throw new MailingError("Рассылка уже запущена или не найдена — обновите страницу");
  return row;
}

export async function getMailing(db: DatabaseExecutor, id: string): Promise<Mailing | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(mailings).where(eq(mailings.id, id));
  return row ?? null;
}

export interface MailingListItem {
  id: string;
  text: string;
  status: MailingStatus;
  scheduledAt: Date | null;
  recipientCount: number;
  createdAt: Date;
}

export async function listMailings(db: DatabaseExecutor): Promise<MailingListItem[]> {
  return db
    .select({
      id: mailings.id,
      text: mailings.text,
      status: mailings.status,
      scheduledAt: mailings.scheduledAt,
      recipientCount: mailings.recipientCount,
      createdAt: mailings.createdAt,
    })
    .from(mailings)
    .orderBy(desc(mailings.createdAt));
}

/**
 * Запуск черновика: сразу или в момент `at`. Получатели фиксируются задачей `mailing-start`,
 * до неё рассылку можно отменить.
 */
export async function launchMailing(deps: MailingServiceDependencies, id: string, options: { at?: Date } = {}): Promise<Mailing> {
  const now = deps.clock.now();
  if (options.at && options.at.getTime() <= now.getTime()) throw new MailingError("Это время уже прошло");
  const scheduledAt = options.at ?? now;
  const [row] = isUuid(id)
    ? await deps.db
        .update(mailings)
        .set({ status: "scheduled", scheduledAt })
        .where(and(eq(mailings.id, id), eq(mailings.status, "draft")))
        .returning()
    : [];
  if (!row) throw new MailingError("Рассылка уже запущена или не найдена — обновите страницу");

  const delaySeconds = Math.ceil((scheduledAt.getTime() - now.getTime()) / 1000);
  try {
    await deps.queue.enqueue("mailing-start", { mailingId: id }, delaySeconds > 0 ? { delaySeconds } : undefined);
  } catch (error) {
    // Без задачи рассылка не стартует никогда: возвращаем черновик, эксперт повторит
    await deps.db.update(mailings).set({ status: "draft", scheduledAt: null }).where(eq(mailings.id, id));
    throw error;
  }
  return row;
}

/** Отмена запланированной рассылки до старта: никто её не получит. */
export async function cancelMailing(deps: Pick<MailingServiceDependencies, "db">, id: string): Promise<void> {
  const [row] = isUuid(id)
    ? await deps.db
        .update(mailings)
        .set({ status: "cancelled" })
        .where(and(eq(mailings.id, id), eq(mailings.status, "scheduled")))
        .returning({ id: mailings.id })
    : [];
  if (!row) throw new MailingError("Отменить можно только рассылку, которая ещё не началась");
}

/**
 * «Отправить себе»: проба уходит выбранному человеку из базы — эксперту в его мессенджере.
 * В отчёт рассылки проба не входит. Выбор запоминается для следующего раза.
 */
export async function sendMailingTest(deps: MailingServiceDependencies, id: string, personId: string, requestId: string): Promise<void> {
  const mailing = await getMailing(deps.db, id);
  if (!mailing) throw new MailingError("Рассылка не найдена");
  const person = isUuid(personId) ? await getPerson(deps.db, personId) : null;
  if (!person) throw new MailingError("Выберите, кому прислать пробу");
  if (person.blockedAt) throw new MailingError("Этот человек заблокировал бота — проба до него не дойдёт");
  const [bot] = await deps.db.select({ deletedAt: bots.deletedAt }).from(bots).where(eq(bots.id, person.botId));
  if (!bot || bot.deletedAt) throw new MailingError("Бот этого человека удалён — выберите другого");
  await enqueueOutbound(deps, {
    botId: person.botId,
    personId: person.id,
    kind: "mailing",
    text: mailing.text,
    ...(mailing.imagePath && { imagePath: mailing.imagePath }),
    idempotencyKey: `mailing-test:${requestId}`,
  });
  await deps.db.update(mailings).set({ testPersonId: person.id }).where(eq(mailings.id, id));
}

/** Сколько человек показывать в выборе «Кому прислать пробу»; остальных находит поиск по имени. */
export const TEST_RECIPIENTS_LIMIT = 20;

export interface TestRecipient {
  id: string;
  displayName: string | null;
  botTitle: string;
  channel: ChannelKind;
}

/**
 * Кому можно прислать пробу: люди из базы с живым ботом, не заблокировавшие его, по имени.
 * `query` — часть имени; `includeId` — кого показать в любом случае (последний, кому слали пробу).
 */
export async function listTestRecipients(
  db: DatabaseExecutor,
  { query = "", includeId }: { query?: string; includeId?: string | null } = {},
): Promise<TestRecipient[]> {
  const pattern = query.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  const reachable = and(isNull(bots.deletedAt), isNull(people.blockedAt));
  const columns = { id: people.id, displayName: people.displayName, botTitle: bots.title, channel: people.channel };
  const found = await db
    .select(columns)
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .where(and(reachable, pattern ? ilike(people.displayName, `%${pattern}%`) : undefined))
    .orderBy(asc(people.displayName), asc(people.id))
    .limit(TEST_RECIPIENTS_LIMIT);
  if (!includeId || !isUuid(includeId) || found.some((person) => person.id === includeId)) return found;
  const [included] = await db
    .select(columns)
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .where(and(reachable, eq(people.id, includeId)));
  return included ? [included, ...found] : found;
}

/** Последний, кому эксперт присылал пробу, — чтобы не выбирать себя каждый раз. */
export async function lastTestPersonId(db: DatabaseExecutor): Promise<string | null> {
  const [row] = await db
    .select({ id: mailings.testPersonId })
    .from(mailings)
    .where(sql`${mailings.testPersonId} is not null`)
    .orderBy(desc(mailings.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export type RecipientOutcome = "sent" | "failed" | "blocked" | "waiting";

export interface MailingReportRow {
  personId: string;
  displayName: string | null;
  botTitle: string | null;
  channel: ChannelKind | null;
  outcome: RecipientOutcome;
  error: string | null;
  replied: boolean;
}

export interface MailingReport {
  recipients: number;
  sent: number;
  /** Не доставлено, включая заблокировавших. */
  failed: number;
  blocked: number;
  replied: number;
  waiting: number;
  /** Не доставленные сверху. */
  people: MailingReportRow[];
}

const OUTCOME_ORDER: Record<RecipientOutcome, number> = { blocked: 0, failed: 1, waiting: 2, sent: 3 };

/** Отчёт рассылки: ушло, не доставлено (с пометкой «заблокировал»), ответили в течение 7 дней. */
export async function loadMailingReport(db: DatabaseExecutor, id: string): Promise<MailingReport | null> {
  if (!(await getMailing(db, id))) return null;
  const replied = sql<boolean>`exists (
    select 1 from ${inboundMessages}
    where ${inboundMessages.personId} = ${mailingRecipients.personId}
      and ${inboundMessages.kind} = 'message'
      and ${outboundMessages.sentAt} is not null
      and ${inboundMessages.receivedAt} > ${outboundMessages.sentAt}
      and ${inboundMessages.receivedAt} <= ${outboundMessages.sentAt} + make_interval(days => ${REPLY_WINDOW_DAYS})
  )`;
  const rows = await db
    .select({
      personId: mailingRecipients.personId,
      displayName: people.displayName,
      botTitle: bots.title,
      channel: people.channel,
      recipientError: mailingRecipients.error,
      status: outboundMessages.status,
      sendError: outboundMessages.error,
      replied,
    })
    .from(mailingRecipients)
    .leftJoin(outboundMessages, eq(outboundMessages.id, mailingRecipients.outboundMessageId))
    .leftJoin(people, eq(people.id, mailingRecipients.personId))
    .leftJoin(bots, eq(bots.id, mailingRecipients.botId))
    .where(eq(mailingRecipients.mailingId, id));

  const report: MailingReport = { recipients: rows.length, sent: 0, failed: 0, blocked: 0, replied: 0, waiting: 0, people: [] };
  for (const row of rows) {
    const outcome: RecipientOutcome = row.recipientError
      ? "failed"
      : row.status === "sent"
        ? "sent"
        : row.status === "blocked"
          ? "blocked"
          : row.status === "failed"
            ? "failed"
            : "waiting";
    if (outcome === "sent") report.sent += 1;
    if (outcome === "failed" || outcome === "blocked") report.failed += 1;
    if (outcome === "blocked") report.blocked += 1;
    if (outcome === "waiting") report.waiting += 1;
    if (row.replied) report.replied += 1;
    report.people.push({
      personId: row.personId,
      displayName: row.displayName,
      botTitle: row.botTitle,
      channel: row.channel,
      outcome,
      error: row.recipientError ?? (outcome === "failed" ? row.sendError : null),
      replied: row.replied,
    });
  }
  report.people.sort(
    (a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome] || (a.displayName ?? "").localeCompare(b.displayName ?? "", "ru"),
  );
  return report;
}
