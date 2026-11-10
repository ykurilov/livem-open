import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { bots, enqueueOutbound, outboundMessages, outboundPartsOf, type ChannelKind } from "../channels";
import type { OutboundKind, OutboundStatus } from "../channels/schema";
import { ATTACHMENT_LABELS } from "../conversations/person-message";
import { inboundMessages, passages } from "../conversations/schema";
import { entryLinks } from "../lead-magnets/schema";
import { getPerson, people } from "../people";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import type { ShownVideoLink } from "../videos";
import { inboundImage, inboxImageFilesFromEnv, outboundImage, type InboxImage, type InboxImageFiles } from "./images";
import { inboxThreads } from "./schema";
import { isStartMessage, startNote } from "./start-note";

/** Сколько последних сообщений показывает переписка. */
const THREAD_MESSAGES_LIMIT = 200;

export class InboxReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxReplyError";
  }
}

/** Повтор отправки уже с другим текстом: человеку ушёл прежний вариант, новый не отправлен. */
export class EarlierReplySentError extends InboxReplyError {
  constructor() {
    super("Человеку уже ушёл прежний вариант ответа, а новый текст не отправлен. Нужен и он — нажмите «Отправить» ещё раз.");
    this.name = "EarlierReplySentError";
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
  /** Последний ответ эксперта не ушёл человеку. */
  replyUndelivered: boolean;
}

export interface InboxMessage {
  id: string;
  direction: "in" | "out";
  text: string;
  at: Date;
  /** Для исходящих — чьё сообщение: консультант, автоответ, ответ эксперта… `start` — человек запустил бота, текст — по какой ссылке. */
  kind: OutboundKind | "person" | "start";
  /** Исходящее не ушло. */
  failed: boolean;
  /** Почему не ушло; `null` — ушло или ещё в пути. */
  failureReason: string | null;
  /** Ролик, который прислал консультант; `null` — обычное сообщение. */
  video: ShownVideoLink | null;
  /** Фото клиента или картинка, которую отправил бот; `null` — сообщение без картинки. */
  image: InboxImage | null;
  /** Сообщение ушло, но не целиком — например, без картинки: у бота нет права «Фотографии». Не сбой. */
  warning: string | null;
}

export interface InboxThread extends Omit<InboxThreadSummary, "lastText"> {
  person: { id: string; displayName: string | null; channel: ChannelKind; botTitle: string };
  messages: InboxMessage[];
  /**
   * «Прочитано до» для ответа (`InboxReply.seenUpTo`): время последнего входящего, которое эксперт видит в переписке,
   * в том числе ещё идущего консультанту — его могут передать во «Входящие», пока открыта форма. Исходящие не в счёт.
   */
  seenUpTo: Date;
  /** Последний ответ эксперта не ушёл — почему; `null` — ушёл, в пути или ответа не было. */
  undeliveredReply: string | null;
  /** Ответить нельзя совсем — почему: бот удалён или человек заблокировал бота. */
  cannotReply: string | null;
}

const UNDELIVERED_STATUSES: OutboundStatus[] = ["failed", "blocked", "awaiting_repair"];

function failureReasonOf(row: { status: OutboundStatus; error: string | null }): string | null {
  if (!UNDELIVERED_STATUSES.includes(row.status)) return null;
  if (row.status === "blocked") return "Человек заблокировал бота";
  return row.error ?? "Сообщение не ушло";
}

function cannotReplyReason(head: { botTitle: string; botDeletedAt: Date | null; blockedAt: Date | null }): string | null {
  if (head.botDeletedAt) return `Бот «${head.botTitle}» удалён — ответить через него нельзя.`;
  if (head.blockedAt) return "Человек заблокировал бота — ответ не дойдёт. Когда он напишет снова, переписка вернётся сюда.";
  return null;
}

/** Ответить можно: бот не удалён, человек его не заблокировал. Остальные переписки «Входящие» не показывают и не считают. */
const answerable = and(isNull(bots.deletedAt), isNull(people.blockedAt));

/** Последний ответ эксперта человеку не ушёл. */
const replyUndeliveredSql = sql<boolean>`coalesce((
  select ${outboundMessages.status} in ('failed', 'blocked', 'awaiting_repair') from ${outboundMessages}
  where ${outboundMessages.personId} = ${inboxThreads.personId} and ${outboundMessages.kind} = 'manual_reply'
  order by ${outboundMessages.createdAt} desc limit 1
), false)`;

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
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inboxThreads)
    .innerJoin(people, eq(people.id, inboxThreads.personId))
    .innerJoin(bots, eq(bots.id, people.botId))
    .where(and(gt(inboxThreads.unansweredCount, 0), answerable));
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
      replyUndelivered: replyUndeliveredSql,
    })
    .from(inboxThreads)
    .innerJoin(people, eq(people.id, inboxThreads.personId))
    .innerJoin(bots, eq(bots.id, people.botId))
    .leftJoinLateral(lastInbox, sql`true`)
    .where(and(gt(inboxThreads.unansweredCount, 0), answerable))
    .orderBy(desc(inboxThreads.lastMessageAt));

  return rows.map(({ text, attachmentKind, ...row }) => ({ ...row, lastText: messageText({ text: text ?? "", attachmentKind }) }));
}

/**
 * Переписка с человеком: что он писал боту и что бот ему отвечал, по времени, с картинками, как их видел человек.
 * `null` — человека нет.
 */
export async function loadInboxThread(
  db: DatabaseExecutor,
  personId: string,
  files: InboxImageFiles = inboxImageFilesFromEnv(),
): Promise<InboxThread | null> {
  const [head] = await db
    .select({
      id: people.id,
      displayName: people.displayName,
      channel: people.channel,
      botTitle: bots.title,
      unansweredCount: sql<number>`coalesce(${inboxThreads.unansweredCount}, 0)`,
      lastMessageAt: inboxThreads.lastMessageAt,
      handoverReason: handoverReasonSql,
      replyUndelivered: replyUndeliveredSql,
      botDeletedAt: bots.deletedAt,
      blockedAt: people.blockedAt,
    })
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .leftJoin(inboxThreads, eq(inboxThreads.personId, people.id))
    .where(eq(people.id, personId));
  if (!head) return null;

  const [incoming, outgoing] = await Promise.all([
    db
      .select({
        id: inboundMessages.id,
        text: inboundMessages.text,
        attachmentKind: inboundMessages.attachmentKind,
        imageRef: inboundMessages.imageRef,
        imageAttachmentId: inboundMessages.imageAttachmentId,
        startCode: inboundMessages.startCode,
        at: inboundMessages.receivedAt,
      })
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
        error: outboundMessages.error,
        video: outboundMessages.video,
        imagePath: outboundMessages.imagePath,
        imageNotSent: outboundMessages.imageNotSent,
        followUps: outboundMessages.followUps,
        at: outboundMessages.createdAt,
      })
      .from(outboundMessages)
      .where(eq(outboundMessages.personId, personId))
      .orderBy(desc(outboundMessages.createdAt))
      .limit(THREAD_MESSAGES_LIMIT),
  ]);

  const startCodes = [...new Set(incoming.flatMap((row) => (row.startCode ? [row.startCode] : [])))];
  const [incomingImages, outgoingImages, startLinks] = await Promise.all([
    Promise.all(incoming.map((row) => inboundImage(files, row))),
    Promise.all(outgoing.map((row) => outboundImage(files, row))),
    startCodes.length === 0
      ? []
      : db.select({ code: entryLinks.code, label: entryLinks.label }).from(entryLinks).where(inArray(entryLinks.code, startCodes)),
  ]);
  const linkLabels = new Map(startLinks.map((link) => [link.code, link.label]));
  const messages: InboxMessage[] = [
    ...incoming.map((row, index) => {
      // Старт бота — служебная команда с кодом ссылки: показываем, по какой ссылке пришёл человек
      if (isStartMessage(row))
        return { id: row.id, direction: "in" as const, text: startNote(row.startCode, linkLabels), at: row.at, kind: "start" as const, failed: false, failureReason: null, video: null, image: null, warning: null };
      const image = incomingImages[index]!;
      // Фото показано картинкой — пометка «[картинка]» в тексте не нужна
      const text = image ? row.text.trim() : messageText(row);
      return { id: row.id, direction: "in" as const, text, at: row.at, kind: "person" as const, failed: false, failureReason: null, video: null, image, warning: null };
    }),
    // Ответ с роликом и прощанием — одно исходящее, а человек видит их отдельными сообщениями: так и показываем.
    // Картинка уходит с первой частью, подписью к тексту
    ...outgoing.flatMap((row, rowIndex) =>
      outboundPartsOf(row).map((part, index) => ({
        id: index === 0 ? row.id : `${row.id}:${index}`,
        direction: "out" as const,
        text: part.text,
        at: row.at,
        kind: row.kind,
        failed: UNDELIVERED_STATUSES.includes(row.status),
        failureReason: failureReasonOf(row),
        video: part.video,
        image: index === 0 ? outgoingImages[rowIndex]! : null,
        // Без картинки ушла первая часть — у неё и предупреждение; не ушло всё сообщение — это уже сбой
        warning: index === 0 && !UNDELIVERED_STATUSES.includes(row.status) ? row.imageNotSent : null,
      })),
    ),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-THREAD_MESSAGES_LIMIT);

  const lastShownIncoming = messages.findLast((message) => message.direction === "in");
  const lastReply = outgoing.find((row) => row.kind === "manual_reply");
  const { id, displayName, channel, botTitle, botDeletedAt, blockedAt, ...thread } = head;
  return {
    ...thread,
    seenUpTo: lastShownIncoming?.at ?? new Date(0),
    undeliveredReply: lastReply ? failureReasonOf(lastReply) : null,
    cannotReply: cannotReplyReason({ botTitle, botDeletedAt, blockedAt }),
    personId: id,
    displayName,
    channel,
    botTitle,
    person: { id, displayName, channel, botTitle },
    messages,
  };
}

/** Длиннее мессенджер разрезал бы ответ на поток сообщений подряд (как предел рассылки). */
export const INBOX_REPLY_LIMIT = 4000;

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
  if (text.length > INBOX_REPLY_LIMIT) throw new InboxReplyError(`Ответ длиннее ${INBOX_REPLY_LIMIT} знаков: сократите его или разбейте на несколько`);
  const person = await getPerson(deps.db, reply.personId);
  if (!person) throw new InboxReplyError("Человек не найден");
  const [bot] = await deps.db.select({ title: bots.title, deletedAt: bots.deletedAt }).from(bots).where(eq(bots.id, person.botId));
  if (!bot) throw new InboxReplyError("Человек не найден");
  const refusal = cannotReplyReason({ botTitle: bot.title, botDeletedAt: bot.deletedAt, blockedAt: person.blockedAt });
  if (refusal) throw new InboxReplyError(refusal);

  const recorded = await enqueueOutbound(deps, {
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
    // Ответ уже успел не уйти: отправка сама вернула переписку в неотвеченные
    const [sent] = await tx.select({ status: outboundMessages.status }).from(outboundMessages).where(eq(outboundMessages.id, recorded.id));
    if (sent && UNDELIVERED_STATUSES.includes(sent.status)) return;
    await tx.update(inboxThreads).set({ unansweredCount: stillUnanswered, lastReplyAt: now }).where(eq(inboxThreads.personId, person.id));
  });
  // Повтор после обрыва связи, а эксперт тем временем поправил текст: ключ тот же, и ушёл бы прежний вариант под видом нового
  if (!recorded.created) {
    const [earlier] = await deps.db.select({ text: outboundMessages.text }).from(outboundMessages).where(eq(outboundMessages.id, recorded.id));
    if (earlier && earlier.text !== text) throw new EarlierReplySentError();
  }
}

