import { and, desc, eq, gt, sql } from "drizzle-orm";
import { bots, enqueueOutbound, outboundMessages, outboundPartsOf, type ChannelKind } from "../channels";
import type { OutboundKind } from "../channels/schema";
import { ATTACHMENT_LABELS } from "../conversations/person-message";
import { inboundMessages, passages } from "../conversations/schema";
import { getPerson, people } from "../people";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import type { ShownVideoLink } from "../videos";
import { inboxThreads } from "./schema";

/** Сколько последних сообщений показывает переписка. */
const THREAD_MESSAGES_LIMIT = 200;

export class InboxReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxReplyError";
  }
}

export interface InboxThreadSummary {
  personId: string;
  displayName: string | null;
  channel: ChannelKind;
  botTitle: string;
  unansweredCount: number;
  lastMessageAt: Date | null;
  lastText: string;
  /** Консультант не смог ответить и передал разговор эксперту; пока эксперт не ответил — причина. */
  handoverReason: string | null;
}

export interface InboxMessage {
  id: string;
  direction: "in" | "out";
  text: string;
  at: Date;
  /** Для исходящих — чьё сообщение: консультант, автоответ, ответ эксперта… */
  kind: OutboundKind | "person";
  /** Исходящее не ушло. */
  failed: boolean;
  /** Ролик, который прислал консультант; `null` — обычное сообщение. */
  video: ShownVideoLink | null;
}

export interface InboxThread extends Omit<InboxThreadSummary, "lastText"> {
  person: { id: string; displayName: string | null; channel: ChannelKind; botTitle: string };
  messages: InboxMessage[];
  /**
   * «Прочитано до» для ответа (`InboxReply.seenUpTo`): время последнего входящего, которое эксперт видит в переписке,
   * в том числе ещё идущего консультанту — его могут передать во «Входящие», пока открыта форма. Исходящие не в счёт.
   */
  seenUpTo: Date;
}

const messageText = (row: { text: string; attachmentKind: keyof typeof ATTACHMENT_LABELS | null }) =>
  [row.text.trim(), row.attachmentKind ? `[${ATTACHMENT_LABELS[row.attachmentKind]}]` : ""].filter(Boolean).join(" ");

/** Причина передачи эксперту: разговор передан после последнего ответа эксперта. */
const handoverReasonSql = sql<string | null>`(
  select ${passages.handoverReason} from ${passages}
  where ${passages.personId} = ${inboxThreads.personId}
    and ${passages.handedToExpertAt} is not null
    and ${passages.handedToExpertAt} > coalesce(${inboxThreads.lastReplyAt}, '-infinity'::timestamptz)
  order by ${passages.handedToExpertAt} desc limit 1
)`;

/** Сколько людей ждут ответа — счётчик в меню. */
export async function countUnansweredThreads(db: DatabaseExecutor): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(inboxThreads).where(gt(inboxThreads.unansweredCount, 0));
  return row?.count ?? 0;
}

/** Переписки с неотвеченными сообщениями, свежие сверху. */
export async function listUnansweredThreads(db: DatabaseExecutor): Promise<InboxThreadSummary[]> {
  const lastInbox = db
    .select({ text: inboundMessages.text, attachmentKind: inboundMessages.attachmentKind })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.personId, inboxThreads.personId), eq(inboundMessages.route, "inbox")))
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(1)
    .as("last_inbox");

  const rows = await db
    .select({
      personId: inboxThreads.personId,
      displayName: people.displayName,
      channel: people.channel,
      botTitle: bots.title,
      unansweredCount: inboxThreads.unansweredCount,
      lastMessageAt: inboxThreads.lastMessageAt,
      text: lastInbox.text,
      attachmentKind: lastInbox.attachmentKind,
      handoverReason: handoverReasonSql,
    })
    .from(inboxThreads)
    .innerJoin(people, eq(people.id, inboxThreads.personId))
    .innerJoin(bots, eq(bots.id, people.botId))
    .leftJoinLateral(lastInbox, sql`true`)
    .where(gt(inboxThreads.unansweredCount, 0))
    .orderBy(desc(inboxThreads.lastMessageAt));

  return rows.map(({ text, attachmentKind, ...row }) => ({ ...row, lastText: messageText({ text: text ?? "", attachmentKind }) }));
}

/** Переписка с человеком: что он писал боту и что бот ему отвечал, по времени. `null` — человека нет. */
export async function loadInboxThread(db: DatabaseExecutor, personId: string): Promise<InboxThread | null> {
  const [head] = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      channel: people.channel,
      botTitle: bots.title,
      unansweredCount: sql<number>`coalesce(${inboxThreads.unansweredCount}, 0)`,
      lastMessageAt: inboxThreads.lastMessageAt,
      handoverReason: handoverReasonSql,
    })
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .leftJoin(inboxThreads, eq(inboxThreads.personId, people.id))
    .where(eq(people.id, personId));
  if (!head) return null;

  const [incoming, outgoing] = await Promise.all([
    db
      .select({ id: inboundMessages.id, text: inboundMessages.text, attachmentKind: inboundMessages.attachmentKind, at: inboundMessages.receivedAt })
      .from(inboundMessages)
      .where(and(eq(inboundMessages.personId, personId), eq(inboundMessages.kind, "message")))
      .orderBy(desc(inboundMessages.receivedAt))
      .limit(THREAD_MESSAGES_LIMIT),
    db
      .select({
        id: outboundMessages.id,
        text: outboundMessages.text,
        kind: outboundMessages.kind,
        status: outboundMessages.status,
        video: outboundMessages.video,
        followUps: outboundMessages.followUps,
        at: outboundMessages.createdAt,
      })
      .from(outboundMessages)
      .where(eq(outboundMessages.personId, personId))
      .orderBy(desc(outboundMessages.createdAt))
      .limit(THREAD_MESSAGES_LIMIT),
  ]);

  const messages: InboxMessage[] = [
    ...incoming.map((row) => ({ id: row.id, direction: "in" as const, text: messageText(row), at: row.at, kind: "person" as const, failed: false, video: null })),
    // Ответ с роликом и прощанием — одно исходящее, а человек видит их отдельными сообщениями: так и показываем
    ...outgoing.flatMap((row) =>
      outboundPartsOf(row).map((part, index) => ({
        id: index === 0 ? row.id : `${row.id}:${index}`,
        direction: "out" as const,
        text: part.text,
        at: row.at,
        kind: row.kind,
        failed: row.status === "failed" || row.status === "blocked" || row.status === "awaiting_repair",
        video: part.video,
      })),
    ),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-THREAD_MESSAGES_LIMIT);

  const lastShownIncoming = messages.findLast((message) => message.direction === "in");
  const { id, displayName, channel, botTitle, ...thread } = head;
  return {
    ...thread,
    seenUpTo: lastShownIncoming?.at ?? new Date(0),
    personId: id,
    displayName,
    channel,
    botTitle,
    person: { id, displayName, channel, botTitle },
    messages,
  };
}

export interface InboxReplyDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
}

export interface InboxReply {
  personId: string;
  text: string;
  /** Время последнего сообщения, которое эксперт видел: пришедшие позже остаются неотвеченными. */
  seenUpTo: Date;
  /** Ключ отправки формы: повторная отправка той же формы не уходит второй раз. */
  requestId: string;
  /** Имя эксперта: консультант увидит, кто ответил вместо него. Нет — просто «сотрудник». */
  staffName?: string;
}

/**
 * Ответ эксперта из «Входящих»: уходит от имени бота, в котором написал человек (`kind = manual_reply`).
 * В этот день человеку больше нет автоответа. Неотвеченными остаются только сообщения, пришедшие после `seenUpTo`.
 */
export async function replyFromInbox(deps: InboxReplyDependencies, reply: InboxReply): Promise<void> {
  const text = reply.text.trim();
  if (!text) throw new InboxReplyError("Напишите ответ");
  const person = await getPerson(deps.db, reply.personId);
  if (!person) throw new InboxReplyError("Человек не найден");

  await enqueueOutbound(deps, {
    botId: person.botId,
    personId: person.id,
    kind: "manual_reply",
    text,
    ...(reply.staffName?.trim() && { staffName: reply.staffName.trim() }),
    idempotencyKey: `manual:${reply.requestId}`,
  });
  // Посреди живого разговора консультант замолкает, пока отвечает эксперт (пауза сценария)
  await deps.queue.enqueue("staff-reply", { personId: person.id }, { singletonKey: `staff-reply:${reply.requestId}` });

  const now = deps.clock.now();
  // Время из формы — до миллисекунд, а база хранит микросекунды
  const stillUnanswered = sql<number>`(
    select count(*)::int from ${inboundMessages}
    where ${inboundMessages.personId} = ${person.id} and ${inboundMessages.route} = 'inbox'
      and date_trunc('milliseconds', ${inboundMessages.receivedAt}) > ${reply.seenUpTo.toISOString()}::timestamptz
  )`;
  await deps.db.transaction(async (tx) => {
    await tx.update(people).set({ lastManualReplyOn: deps.clock.mskDate(now) }).where(eq(people.id, person.id));
    // Сначала замок на строку: новое входящее (триггер тоже пишет в эту строку) либо уже закоммичено и попадёт в подсчёт, либо подождёт
    await tx.insert(inboxThreads).values({ personId: person.id }).onConflictDoNothing();
    await tx.select({ personId: inboxThreads.personId }).from(inboxThreads).where(eq(inboxThreads.personId, person.id)).for("update");
    await tx.update(inboxThreads).set({ unansweredCount: stillUnanswered, lastReplyAt: now }).where(eq(inboxThreads.personId, person.id));
  });
}

