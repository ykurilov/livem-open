import { randomInt } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import type { ChannelAdapters } from "../channels/channel";
import { findBotWithCredentials } from "../channels/bots";
import { enqueueOutbound } from "../channels/outbound";
import { bots } from "../channels/schema";
import type { TokenCipher } from "../platform/crypto";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { leadMagnets } from "../lead-magnets/schema";
import { people } from "../people/schema";
import { callReminderKey } from "./bookings";
import { readCallCalendar } from "./calendar";
import type { CallBookingChange } from "./port";
import { callBookings, callNotices, callNotifyBots, type CallBookingRow, type CallNoticeKind } from "./schema";
import { clockLabel, slotLabel, timeZoneOffsetLabel, dayLabel } from "./slots";

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 24;
/** Напоминание человеку — за столько минут до созвона. */
export const CALL_REMINDER_MINUTES = 60;
const MINUTE_MS = 60_000;
/** Ближе этого к созвону напоминание уже ни к чему. */
export const REMINDER_TOO_LATE_MINUTES = 10;

const newConnectCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export type CallNoticeBotState = "connected" | "waiting" | "off";

/** Бот эксперта в блоке «Уведомлять о записи». */
export interface CallNoticeBot {
  botId: string;
  channel: string;
  title: string;
  username: string;
  state: CallNoticeBotState;
  /** Последнее уведомление не дошло насовсем: что делать эксперту. */
  failure: string | null;
}

/** Боты мессенджеров (не веб-чат) и их подключение к уведомлениям. Удалённых нет: их уведомления не шлются. */
export async function listCallNoticeBots(db: DatabaseExecutor): Promise<CallNoticeBot[]> {
  const rows = await db
    .select({ bot: bots, notify: callNotifyBots })
    .from(bots)
    .leftJoin(callNotifyBots, eq(callNotifyBots.botId, bots.id))
    .where(and(isNull(bots.deletedAt), ne(bots.channel, "web")))
    .orderBy(asc(bots.createdAt));
  return rows.map(({ bot, notify }) => ({
    botId: bot.id,
    channel: bot.channel,
    title: bot.title,
    username: bot.username,
    state: notify?.chatId ? "connected" : notify?.connectCode ? "waiting" : "off",
    failure: notify?.failure ?? null,
  }));
}

/**
 * «Подключить»: одноразовая ссылка на бота. Эксперт нажимает «Старт» — бот запоминает его аккаунт и дальше пишет туда.
 * Повторное «Подключить» выдаёт новый код (прежняя ссылка гаснет); уже подключённый аккаунт остаётся до нового «Старта».
 */
export async function startCallNoticeConnect(db: Database, adapters: ChannelAdapters, botId: string): Promise<{ link: string }> {
  const [bot] = await db.select().from(bots).where(and(eq(bots.id, botId), isNull(bots.deletedAt)));
  if (!bot || bot.channel === "web") throw new Error("Такого бота нет");
  const adapter = adapters[bot.channel];
  if (!adapter) throw new Error(`Мессенджер ${bot.channel} не подключён в приложении`);
  const code = newConnectCode();
  await db
    .insert(callNotifyBots)
    .values({ botId, connectCode: code })
    .onConflictDoUpdate({ target: callNotifyBots.botId, set: { connectCode: code } });
  return { link: adapter.entryLink(bot, code) };
}

/** Входящее со «Стартом» по коду подключения: аккаунт эксперта записан, код погашен. Чужой код — `false`. */
export async function claimCallNoticeConnect(tx: DatabaseExecutor, input: { botId: string; code: string; chatId: string; now: Date }): Promise<boolean> {
  const [claimed] = await tx
    .update(callNotifyBots)
    .set({ chatId: input.chatId, connectedAt: input.now, connectCode: null, failure: null })
    .where(and(eq(callNotifyBots.botId, input.botId), eq(callNotifyBots.connectCode, input.code)))
    .returning({ botId: callNotifyBots.botId });
  return Boolean(claimed);
}

/** «Отключить»: бот больше не шлёт уведомлений. */
export async function disconnectCallNoticeBot(db: DatabaseExecutor, botId: string): Promise<void> {
  await db.delete(callNotifyBots).where(eq(callNotifyBots.botId, botId));
}

export const CALL_NOTICE_CONNECTED_TEXT = "Готово: сюда будут приходить новые записи на созвон, переносы и отмены.";

/** Ответ эксперту на «Старт» по коду подключения: один раз на входящее. */
export async function confirmCallNoticeConnect(
  deps: { db: Database; cipher: TokenCipher; adapters: ChannelAdapters },
  input: { botId: string; chatId: string; inboundId: string },
): Promise<void> {
  const found = await findBotWithCredentials(deps.db, deps.cipher, input.botId);
  const adapter = found && deps.adapters[found.bot.channel];
  if (!found || !adapter) return;
  const result = await adapter.send(found.credentials, input.chatId, { text: CALL_NOTICE_CONNECTED_TEXT, idempotencyKey: `call-notice-connected:${input.inboundId}` });
  if (!result.ok && (result.reason === "temporary" || result.reason === "rate_limited")) throw new Error("Подтверждение подключения уведомлений не ушло, повтор");
}

async function describeBooking(db: DatabaseExecutor, booking: CallBookingRow) {
  const [row] = await db
    .select({ personName: people.displayName, leadMagnet: leadMagnets.draft })
    .from(callBookings)
    .leftJoin(people, eq(people.id, callBookings.personId))
    .leftJoin(leadMagnets, eq(leadMagnets.id, callBookings.leadMagnetId))
    .where(eq(callBookings.id, booking.id));
  return { personName: row?.personName?.trim() || "Без имени", leadMagnetName: row?.leadMagnet?.name ?? null };
}

/** О чём уведомить эксперта: изменение записи или недошедшее напоминание человеку (`reason` — почему, для эксперта). */
export type CallNoticeEvent = CallBookingChange | { kind: "reminder_failed" | "cancel_message_failed"; booking: CallBookingRow; reason: string };

/** Текст уведомления эксперту: кто, когда по его часам, из какого лидмагнита. */
export async function callNoticeText(db: DatabaseExecutor, change: CallNoticeEvent): Promise<string> {
  const { timeZone } = await readCallCalendar(db);
  const { personName, leadMagnetName } = await describeBooking(db, change.booking);
  const from = leadMagnetName ? `\nЛидмагнит: «${leadMagnetName}»` : "";
  switch (change.kind) {
    case "booked":
      return `Новая запись на созвон: ${personName}, ${slotLabel(change.booking, timeZone)}${from}`;
    case "rescheduled":
      return `Перенос созвона: ${personName}, было ${slotLabel(change.previous, timeZone)}, стало ${slotLabel(change.booking, timeZone)}${from}`;
    case "cancelled":
      return `Отмена созвона: ${personName}, ${slotLabel(change.booking, timeZone)}${change.booking.cancelledBy === "expert" ? " (отменили вы)" : ""}${from}`;
    case "reminder_failed":
      return `Напоминание о созвоне не дошло: ${personName}, ${slotLabel(change.booking, timeZone)}. ${change.reason} Напомните человеку сами.${from}`;
    case "cancel_message_failed":
      return `Сообщение об отмене созвона не дошло: ${personName}, ${slotLabel(change.booking, timeZone)}. ${change.reason} Напишите человеку сами.${from}`;
  }
}

/** Уведомления о записи во все подключённые боты эксперта; повтор того же изменения второго не шлёт. Тестовые — никогда. Возвращает, сколько записано новых. */
export async function queueCallNotices(deps: { db: Database; queue: JobEnqueuer; clock: Clock }, change: CallNoticeEvent): Promise<number> {
  if (change.booking.testChatId) return 0;
  const targets = await noticeTargets(deps.db);
  if (targets.length === 0) return 0;
  const text = await callNoticeText(deps.db, change);
  const kind: CallNoticeKind = change.kind;
  const queued: string[] = [];
  for (const { botId } of targets) {
    // Задача не встанет — записанное уведомление поставит заново подмётчик (`recoverCallBookingWork`)
    const [notice] = await deps.db
      .insert(callNotices)
      .values({ bookingId: change.booking.id, kind, botId, text, createdAt: deps.clock.now() })
      .onConflictDoNothing()
      .returning({ id: callNotices.id });
    if (notice) queued.push(notice.id);
  }
  for (const noticeId of queued) await deps.queue.enqueue("call-notice-send", { noticeId });
  return queued.length;
}

/** Подключённые к уведомлениям боты эксперта, кроме удалённых. */
async function noticeTargets(db: DatabaseExecutor): Promise<Array<{ botId: string }>> {
  return db
    .select({ botId: callNotifyBots.botId })
    .from(callNotifyBots)
    .innerJoin(bots, eq(bots.id, callNotifyBots.botId))
    .where(and(isNotNull(callNotifyBots.chatId), isNull(bots.deletedAt)));
}

/**
 * Уведомление эксперту о вопросе, который агент передал с согласия вернувшегося человека, — в те же боты, что и о
 * записях. `handoverKey` — эта передача: повтор задачи или вызова второго уведомления не шлёт. Возвращает, сколько записано.
 */
export async function queueAgentHandoverNotices(
  deps: { db: Database; queue: JobEnqueuer; clock: Clock },
  handover: { key: string; text: string },
): Promise<number> {
  const targets = await noticeTargets(deps.db);
  const queued: string[] = [];
  for (const { botId } of targets) {
    const [notice] = await deps.db
      .insert(callNotices)
      .values({ kind: "agent_handover", handoverKey: handover.key, botId, text: handover.text, createdAt: deps.clock.now() })
      .onConflictDoNothing()
      .returning({ id: callNotices.id });
    if (notice) queued.push(notice.id);
  }
  for (const noticeId of queued) await deps.queue.enqueue("call-notice-send", { noticeId });
  return queued.length;
}

/**
 * Задача `call-notice-send`. Бот удалён или отключён от уведомлений — не шлём, отмечаем. Эксперт остановил бота или
 * бот сломан — отмечаем у бота: в блоке уведомлений видно, что надо подключить заново. Временный сбой — повтор очереди.
 */
export async function sendCallNotice(deps: { db: Database; cipher: TokenCipher; adapters: ChannelAdapters; clock: Clock }, noticeId: string): Promise<void> {
  // Строка под замком на время отправки: задача и её дубль от подмётчика не отправят уведомление дважды
  await deps.db.transaction(async (tx) => {
    const [notice] = await tx.select().from(callNotices).where(eq(callNotices.id, noticeId)).for("update", { skipLocked: true });
    if (!notice || notice.status !== "queued") return;
    const fail = (error: string) => tx.update(callNotices).set({ status: "failed", error }).where(eq(callNotices.id, noticeId));
    const [target] = await tx.select().from(callNotifyBots).where(eq(callNotifyBots.botId, notice.botId));
    if (!target?.chatId) return void (await fail("Бот отключён от уведомлений"));
    const found = await findBotWithCredentials(tx, deps.cipher, notice.botId);
    const adapter = found && deps.adapters[found.bot.channel];
    if (!found || !adapter) return void (await fail("Бот удалён"));
    const result = await adapter.send(found.credentials, target.chatId, { text: notice.text, idempotencyKey: `call-notice:${notice.id}` });
    if (result.ok) {
      await tx.update(callNotices).set({ status: "sent", sentAt: deps.clock.now(), error: null }).where(eq(callNotices.id, noticeId));
      if (target.failure) await tx.update(callNotifyBots).set({ failure: null }).where(eq(callNotifyBots.botId, notice.botId));
      return;
    }
    if (result.reason === "temporary" || result.reason === "rate_limited") throw new Error(`Уведомление о записи ${notice.id} не ушло, повтор`);
    const failure =
      result.reason === "blocked" ? "Бот не может написать вам: похоже, вы остановили его. Нажмите «Подключить» и снова «Старт»." : "Уведомление не дошло. Проверьте бота и нажмите «Подключить» снова.";
    await fail(failure);
    await tx.update(callNotifyBots).set({ failure }).where(eq(callNotifyBots.botId, notice.botId));
  });
}

/** Напоминание человеку за час до созвона. Тестовая запись или созвон уже скоро — без напоминания. */
export async function scheduleCallReminder(deps: { queue: JobEnqueuer; clock: Clock }, booking: CallBookingRow): Promise<void> {
  if (booking.testChatId || !booking.personId || booking.status !== "booked") return;
  const untilStartMs = booking.startsAt.getTime() - deps.clock.now().getTime();
  if (untilStartMs < REMINDER_TOO_LATE_MINUTES * MINUTE_MS) return;
  const delaySeconds = Math.max(0, Math.ceil((untilStartMs - CALL_REMINDER_MINUTES * MINUTE_MS) / 1000));
  await deps.queue.enqueue("call-reminder", { bookingId: booking.id }, { delaySeconds, singletonKey: `call-reminder:${booking.id}` });
}

const callMoment = (booking: CallBookingRow, timeZone: string) =>
  `${dayLabel(booking.startsAt, timeZone)}, в ${clockLabel(booking.startsAt, timeZone)} (${timeZoneOffsetLabel(timeZone, booking.startsAt)})`;

/** Сообщение человеку об отмене экспертом, когда эксперт не написал своих слов. */
export function callCancelledByExpertText(booking: CallBookingRow, timeZone: string): string {
  return `Созвон ${callMoment(booking, timeZone)} отменён. Если хотите, подберём другое время — напишите, когда вам удобно.`;
}

/** Текст напоминания: когда по часам эксперта с поясом и ссылка на встречу из настройки на момент записи. */
export async function callReminderText(db: DatabaseExecutor, booking: CallBookingRow): Promise<string> {
  const { timeZone } = await readCallCalendar(db);
  return [`Напоминаю: созвон с экспертом ${callMoment(booking, timeZone)}.`, booking.meetingLink ? `Ссылка на встречу: ${booking.meetingLink}` : ""].filter(Boolean).join("\n");
}

/**
 * Задача `call-reminder`: сверяется с часами (рано — переставляет себя), запись ещё действует и напоминания не было —
 * сообщение человеку в бот, где он сейчас разговаривает (веб-чат — в его чат). Созвон уже начался — не шлёт.
 */
export async function sendCallReminder(deps: { db: Database; queue: JobEnqueuer; clock: Clock }, bookingId: string): Promise<void> {
  const [booking] = await deps.db.select().from(callBookings).where(eq(callBookings.id, bookingId));
  if (!booking || booking.status !== "booked" || booking.reminderSentAt || booking.testChatId || !booking.personId) return;
  const now = deps.clock.now();
  if (now >= booking.startsAt) return;
  const remindAt = booking.startsAt.getTime() - CALL_REMINDER_MINUTES * MINUTE_MS;
  if (now.getTime() < remindAt - MINUTE_MS) {
    await deps.queue.enqueue("call-reminder", { bookingId }, { delaySeconds: Math.ceil((remindAt - now.getTime()) / 1000) });
    return;
  }
  const [person] = await deps.db.select({ id: people.id, botId: people.botId }).from(people).where(eq(people.id, booking.personId));
  if (!person) return;
  await enqueueOutbound(deps, {
    botId: person.botId,
    personId: person.id,
    // Служебное сообщение бота, а не касание сценария: дневной потолок сообщений первым не тратит
    kind: "system",
    text: await callReminderText(deps.db, booking),
    idempotencyKey: callReminderKey(booking.id),
  });
  await deps.db.update(callBookings).set({ reminderSentAt: now }).where(eq(callBookings.id, booking.id));
}
