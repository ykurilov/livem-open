import { randomInt } from "node:crypto";
import type { AgentFlowHandle, FlowEndInput } from "@ykurilov/agent-chat-flows";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { agentLogTurns } from "../agent-log/schema";
import { callBookings } from "../booking/schema";
import { CHANNEL_LABELS, type ChannelAdapters, type ChannelKind } from "../channels/channel";
import { bots, leadMagnetBots, outboundMessages } from "../channels/schema";
import { recordOutbound, scheduleOutboundSend } from "../channels";
import { endActivePassages } from "../conversations/passage-end";
import { chatOwnerOf, inboundMessages, passages } from "../conversations/schema";
import { inboxThreads } from "../inbox/schema";
import { getVersion } from "../lead-magnets";
import { listAttachedBots } from "../lead-magnets/publish";
import { mailingRecipients } from "../mailings/schema";
import { people } from "../people/schema";
import type { Person } from "../people/people";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { sentImagePath } from "../images";
import { tagPassageText } from "../purchases/outgoing";
import { BUSY_RETRY_SECONDS, type FirstMessageWriter } from "../purchases/reactions";
import { enabledMessengerHandoff, MESSENGER_HANDOFF_EVENT, type HandoffMessenger } from "./setting";
import { handoffNotice } from "./notice";
import { messengerHandoffs, type MessengerHandoffRow } from "./schema";

/** Длина кода перехода: `A-Za-z0-9`, ~143 бита — не подобрать; влезает в `start` Telegram (до 64), `ref` ВК и Max. */
export const HANDOFF_CODE_LENGTH = 24;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function newHandoffCode(): string {
  let code = "";
  for (let index = 0; index < HANDOFF_CODE_LENGTH; index++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Кнопка мессенджера в веб-чате: ссылка на бот с кодом перехода. */
export interface HandoffButton {
  channel: HandoffMessenger;
  title: string;
  url: string;
}

export type OfferResult = { ok: true; buttons: HandoffButton[] } | { ok: false; reason: "off" | "not_web" | "taken" | "no_bots" };

/**
 * Кнопки — мессенджеры из настройки, где лидмагнит опубликован (привязан бот и есть адаптер), по одной на мессенджер,
 * в порядке настройки.
 */
async function handoffButtons(
  db: DatabaseExecutor,
  adapters: ChannelAdapters,
  input: { leadMagnetId: string; channels: readonly HandoffMessenger[]; code: string },
): Promise<HandoffButton[]> {
  const attached = await listAttachedBots(db, input.leadMagnetId);
  return input.channels.flatMap((channel) => {
    const bot = attached.find((row) => row.channel === channel);
    const adapter = adapters[channel];
    return bot && adapter ? [{ channel, title: CHANNEL_LABELS[channel], url: adapter.entryLink(bot, input.code) }] : [];
  });
}

/**
 * Инструмент консультанта: человек в веб-чате, переход включён — строка перехода (одна на прохождение, повтор вызова
 * отдаёт ту же) и кнопки мессенджеров. Человек уже перешёл — `taken`.
 */
export async function offerMessengerHandoff(
  db: Database,
  adapters: ChannelAdapters,
  chat: { ownerId: string; chatId: string },
): Promise<OfferResult> {
  const [row] = await db
    .select({ passage: passages, person: people })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .where(eq(passages.chatId, chat.chatId));
  if (!row) return { ok: false, reason: "not_web" };
  const { passage, person } = row;
  if (person.channel !== "web") return { ok: false, reason: "not_web" };
  const snapshot = await getVersion(db, passage.snapshotId);
  const setting = snapshot && enabledMessengerHandoff(snapshot.settings);
  if (!setting) return { ok: false, reason: "off" };
  const existing = await handoffOfPassage(db, passage.id);
  if (existing?.takenAt) return { ok: false, reason: "taken" };
  const code = existing?.code ?? newHandoffCode();
  const buttons = await handoffButtons(db, adapters, { leadMagnetId: passage.leadMagnetId, channels: setting.channels, code });
  if (buttons.length === 0) return { ok: false, reason: "no_bots" };
  if (!existing)
    await db
      .insert(messengerHandoffs)
      // Время базы, как у исходящих: по нему видно, дошёл ли ответ хода с кнопками и что было до них
      .values({ passageId: passage.id, personId: person.id, visitorId: person.externalUserId, code, offeredAt: sql`now()` })
      .onConflictDoNothing({ target: messengerHandoffs.passageId });
  // Соседний вызов успел раньше — его код
  const saved = existing ?? (await handoffOfPassage(db, passage.id));
  if (!saved) throw new Error(`Переход разговора ${passage.id} не записался`);
  if (saved.code === code) return { ok: true, buttons };
  return { ok: true, buttons: await handoffButtons(db, adapters, { leadMagnetId: passage.leadMagnetId, channels: setting.channels, code: saved.code }) };
}

async function handoffOfPassage(db: DatabaseExecutor, passageId: string): Promise<MessengerHandoffRow | null> {
  const [row] = await db.select().from(messengerHandoffs).where(eq(messengerHandoffs.passageId, passageId));
  return row ?? null;
}

export async function findHandoffByCode(db: DatabaseExecutor, code: string): Promise<MessengerHandoffRow | null> {
  if (code.length !== HANDOFF_CODE_LENGTH) return null;
  const [row] = await db.select().from(messengerHandoffs).where(eq(messengerHandoffs.code, code));
  return row ?? null;
}

/**
 * Что веб-чат посетителя показывает вместо поля ввода на вкладке лидмагнита; `null` — поле ввода, разговор идёт здесь.
 * - `offered` — кнопки мессенджеров: агент их показал и его ответ с объяснением уже дошёл. Кнопок не осталось (бот
 *   отвязали, лидмагнит сняли) — `null`: веб-чат не тупик.
 * - `taken` — человек перешёл: где продолжается разговор, со ссылкой в бот.
 * - `messenger` — человек перешёл по другому лидмагниту, этот опубликован в том же боте: ссылка лидмагнита в бот,
 *   чтобы не завести второго человека веб-чата.
 */
export type WebChatHandoffState =
  | { state: "offered"; buttons: HandoffButton[] }
  | { state: "taken" | "messenger"; channel: HandoffMessenger; title: string; url: string };

export async function handoffStateForVisitor(
  db: DatabaseExecutor,
  adapters: ChannelAdapters,
  input: { visitorId: string; leadMagnetId: string; code: string },
): Promise<WebChatHandoffState | null> {
  const [row] = await db
    .select({ handoff: messengerHandoffs, passage: passages, takenBot: bots })
    .from(messengerHandoffs)
    .innerJoin(passages, eq(passages.id, messengerHandoffs.passageId))
    .leftJoin(bots, eq(bots.id, messengerHandoffs.takenBotId))
    .where(and(eq(messengerHandoffs.visitorId, input.visitorId), eq(passages.leadMagnetId, input.leadMagnetId)))
    .orderBy(desc(messengerHandoffs.offeredAt))
    .limit(1);
  if (!row) return messengerInvite(db, adapters, input);
  const { handoff, passage, takenBot } = row;
  if (handoff.takenAt) {
    if (!takenBot || takenBot.channel === "web") return null;
    // Бот, где человек нажал «Старт»: ссылка в него и после отвязки от лидмагнита — разговор идёт там
    const url = adapters[takenBot.channel]?.entryLink(takenBot, handoff.code) ?? "";
    return { state: "taken", channel: takenBot.channel, title: CHANNEL_LABELS[takenBot.channel], url };
  }
  // Разговор закончился раньше, чем человек нажал кнопку: кнопки больше не нужны
  if (passage.status !== "active" || !(await answeredAfter(db, handoff))) return null;
  const snapshot = await getVersion(db, passage.snapshotId);
  const channels = snapshot?.settings.messengerHandoff?.channels ?? [];
  const buttons = await handoffButtons(db, adapters, { leadMagnetId: passage.leadMagnetId, channels, code: handoff.code });
  return buttons.length > 0 ? { state: "offered", buttons } : null;
}

/** Ответ хода, в котором агент показал кнопки, дошёл до веб-чата. */
async function answeredAfter(db: DatabaseExecutor, handoff: MessengerHandoffRow): Promise<boolean> {
  const [answer] = await db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.passageId, handoff.passageId), eq(outboundMessages.status, "sent"), gt(outboundMessages.createdAt, handoff.offeredAt)))
    .limit(1);
  return Boolean(answer);
}

/** Посетитель перешёл в мессенджер и снова в веб-чате другого лидмагнита, опубликованного в том же боте. */
async function messengerInvite(
  db: DatabaseExecutor,
  adapters: ChannelAdapters,
  input: { visitorId: string; leadMagnetId: string; code: string },
): Promise<WebChatHandoffState | null> {
  // В веб-чате у посетителя снова есть своя запись (лидмагнита нет в его мессенджере) — разговоры идут здесь
  const [web] = await db
    .select({ id: people.id })
    .from(people)
    .innerJoin(bots, eq(bots.id, people.botId))
    .where(and(eq(bots.channel, "web"), eq(people.externalUserId, input.visitorId)))
    .limit(1);
  if (web) return null;
  const person = await handedOffPerson(db, input.visitorId);
  if (!person || person.channel === "web") return null;
  const [bot] = await db
    .select({ username: bots.username, externalId: bots.externalId })
    .from(leadMagnetBots)
    .innerJoin(bots, eq(bots.id, leadMagnetBots.botId))
    .where(and(eq(leadMagnetBots.leadMagnetId, input.leadMagnetId), eq(leadMagnetBots.botId, person.botId)));
  const adapter = adapters[person.channel];
  if (!bot || !adapter) return null;
  return { state: "messenger", channel: person.channel, title: CHANNEL_LABELS[person.channel], url: adapter.entryLink(bot, input.code) };
}

/** Посетитель веб-чата перешёл в мессенджер: его запись человека (она теперь — аккаунт мессенджера). */
export async function handedOffPerson(db: DatabaseExecutor, visitorId: string): Promise<Person | null> {
  const [row] = await db
    .select({ person: people })
    .from(messengerHandoffs)
    .innerJoin(people, eq(people.id, messengerHandoffs.personId))
    .where(and(eq(messengerHandoffs.visitorId, visitorId), sql`${messengerHandoffs.takenAt} is not null`))
    .orderBy(desc(messengerHandoffs.takenAt))
    .limit(1);
  return row?.person ?? null;
}

/**
 * «Старт» с кодом перехода — внутри транзакции разбора входящего, после `upsertPerson` (строка `messenger` под замком).
 * - `taken` — первый «Старт»: веб-человек становится этим аккаунтом мессенджера; запись мессенджера, если человек уже
 *   писал боту, вливается в него (её идущий разговор закончен, история и «Входящие» — у одного человека).
 * - `repeat` — тот же человек нажал «Старт» снова.
 * - `foreign` — код взят другим или его лидмагнит не на этом боте: дальше как ссылка лидмагнита.
 */
export type HandoffTake =
  | { kind: "taken"; person: Person; handoff: MessengerHandoffRow }
  | { kind: "repeat"; person: Person; handoff: MessengerHandoffRow }
  | { kind: "foreign"; handoff: MessengerHandoffRow };

export async function takeMessengerHandoff(
  tx: DatabaseExecutor,
  input: {
    handoff: MessengerHandoffRow;
    messenger: Person;
    bot: { id: string; channel: ChannelKind };
    inbound: { id: string; externalUserId: string; userName: string | null };
    now: Date;
    isPublishedOnBot(leadMagnetId: string): Promise<boolean>;
    endFlow(input: FlowEndInput): void;
  },
): Promise<HandoffTake> {
  const [handoff] = await tx.select().from(messengerHandoffs).where(eq(messengerHandoffs.id, input.handoff.id)).for("update");
  if (!handoff) return { kind: "foreign", handoff: input.handoff };
  if (handoff.takenAt) return handoff.personId === input.messenger.id ? { kind: "repeat", person: input.messenger, handoff } : { kind: "foreign", handoff };
  const [passage] = await tx.select().from(passages).where(eq(passages.id, handoff.passageId));
  const [web] = await tx.select().from(people).where(eq(people.id, handoff.personId)).for("update");
  if (!passage || !web || web.channel !== "web" || input.bot.channel === "web" || !(await input.isPublishedOnBot(passage.leadMagnetId)))
    return { kind: "foreign", handoff };

  const merged = await absorbMessengerPerson(tx, { web, messenger: input.messenger, now: input.now, endFlow: input.endFlow });
  const [person] = await tx
    .update(people)
    .set({
      channel: input.bot.channel,
      botId: input.bot.id,
      externalUserId: input.inbound.externalUserId,
      displayName: input.inbound.userName?.trim() || input.messenger.displayName || web.displayName,
      blockedAt: null,
      lastInboundAt: input.now,
      ...merged,
    })
    .where(eq(people.id, web.id))
    .returning();
  const [taken] = await tx
    .update(messengerHandoffs)
    .set({ takenAt: input.now, takenBotId: input.bot.id, takenInboundId: input.inbound.id })
    .where(eq(messengerHandoffs.id, handoff.id))
    .returning();
  return { kind: "taken", person: person!, handoff: taken! };
}

/**
 * Запись мессенджера `messenger` вливается в веб-человека `web`: её идущий разговор закончен («перешёл»), прохождения,
 * входящие, исходящие, получатели рассылок, журнал агента и «Входящие» — теперь у `web`. Чаты SDK её прохождений
 * остаются за прежним владельцем (`chat_owner_id`). Карточка — общая, при совпадении поля верх берёт веб-разговор.
 * Возвращает поля карточки для записи в `web`; сама запись `messenger` удаляется (освобождает аккаунт мессенджера).
 */
async function absorbMessengerPerson(
  tx: DatabaseExecutor,
  input: { web: Person; messenger: Person; now: Date; endFlow(input: FlowEndInput): void },
): Promise<Partial<typeof people.$inferInsert>> {
  const { web, messenger } = input;
  const [active] = await tx
    .select()
    .from(passages)
    .where(and(eq(passages.personId, messenger.id), eq(passages.status, "active")))
    .for("update");
  if (active) {
    await endActivePassages(tx, eq(passages.id, active.id), "not_completed", input.now);
    input.endFlow({ ownerId: chatOwnerOf(active), chatId: active.chatId, reason: "switched", outcome: "перешёл из веб-чата" });
  }
  const threads = await tx.select().from(inboxThreads).where(inArray(inboxThreads.personId, [web.id, messenger.id]));

  await tx
    .update(passages)
    .set({ chatOwnerId: sql`coalesce(${passages.chatOwnerId}, ${passages.personId})`, personId: web.id })
    .where(eq(passages.personId, messenger.id));
  await tx.update(inboundMessages).set({ personId: web.id }).where(eq(inboundMessages.personId, messenger.id));
  await tx.update(outboundMessages).set({ personId: web.id }).where(eq(outboundMessages.personId, messenger.id));
  await tx.execute(sql`
    delete from ${mailingRecipients} as own
    where own.person_id = ${messenger.id}
      and exists (select 1 from ${mailingRecipients} as other where other.mailing_id = own.mailing_id and other.person_id = ${web.id})`);
  await tx.update(mailingRecipients).set({ personId: web.id }).where(eq(mailingRecipients.personId, messenger.id));
  await tx.update(agentLogTurns).set({ personId: web.id }).where(eq(agentLogTurns.personId, messenger.id));
  await tx.update(messengerHandoffs).set({ personId: web.id }).where(eq(messengerHandoffs.personId, messenger.id));
  await tx.update(callBookings).set({ personId: web.id }).where(eq(callBookings.personId, messenger.id));

  // «Входящие»: перенос входящих триггер считает заново — одна строка с суммой, как было у обоих
  await tx.delete(inboxThreads).where(inArray(inboxThreads.personId, [web.id, messenger.id]));
  if (threads.length > 0) {
    const latest = (values: Array<Date | null>) => values.reduce<Date | null>((max, value) => (value && (!max || value > max) ? value : max), null);
    await tx.insert(inboxThreads).values({
      personId: web.id,
      unansweredCount: threads.reduce((sum, thread) => sum + thread.unansweredCount, 0),
      lastMessageAt: latest(threads.map((thread) => thread.lastMessageAt)),
      lastReplyAt: latest(threads.map((thread) => thread.lastReplyAt)),
    });
  }
  await tx.delete(people).where(eq(people.id, messenger.id));

  const later = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));
  return {
    facts: [...messenger.facts, ...web.facts],
    fieldValues: { ...messenger.fieldValues, ...web.fieldValues },
    fieldUpdatedAt: { ...messenger.fieldUpdatedAt, ...web.fieldUpdatedAt },
    timeZone: web.timeZone ?? messenger.timeZone,
    source: web.source ?? messenger.source,
    lastAutoreplyOn: later(web.lastAutoreplyOn, messenger.lastAutoreplyOn),
    lastManualReplyOn: later(web.lastManualReplyOn, messenger.lastManualReplyOn),
  };
}

/** Строка журнала расхода SDK для продолжения после перехода: агент пишет первым в мессенджере. */
export const MESSENGER_HANDOFF_USAGE_SOURCE = "messenger_handoff";

export interface HandoffContinueDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
  writer: FirstMessageWriter;
  flow: Pick<AgentFlowHandle, "signal">;
}

/**
 * Задача `messenger-handoff-continue`: после «Старта» по коду сценарий получает событие `messenger_handoff` (переход
 * применится в начале хода), агент пишет первым — продолжение, — и оно уходит в мессенджер. Повтор задачи не шлёт
 * второго события и второго сообщения. Чат занят ходом — повтор через минуту.
 */
export async function continueInMessenger(deps: HandoffContinueDependencies, handoffId: string): Promise<void> {
  const [row] = await deps.db
    .select({ handoff: messengerHandoffs, passage: passages, person: people })
    .from(messengerHandoffs)
    .innerJoin(passages, eq(passages.id, messengerHandoffs.passageId))
    .innerJoin(people, eq(people.id, passages.personId))
    .where(eq(messengerHandoffs.id, handoffId));
  if (!row?.handoff.takenAt || row.passage.status !== "active" || row.person.channel === "web") return;
  const { handoff, passage, person } = row;
  const ownerId = chatOwnerOf(passage);
  if (!handoff.signaledAt) {
    await deps.flow.signal({ ownerId, chatId: passage.chatId, name: MESSENGER_HANDOFF_EVENT, data: { channel: person.channel }, wakeAgent: false });
    await deps.db.update(messengerHandoffs).set({ signaledAt: deps.clock.now() }).where(eq(messengerHandoffs.id, handoffId));
  }
  const idempotencyKey = `handoff:${handoffId}`;
  const [sent] = await deps.db.select({ id: outboundMessages.id }).from(outboundMessages).where(eq(outboundMessages.idempotencyKey, idempotencyKey));
  if (sent) return;
  const written = await deps.writer.writeFirst({
    ownerId,
    chatId: passage.chatId,
    deliveryKey: idempotencyKey,
    title: handoffNotice(person.channel),
    usageSource: MESSENGER_HANDOFF_USAGE_SOURCE,
    ...(person.timeZone && { timeZone: person.timeZone }),
  });
  if (written.kind === "busy") {
    await deps.queue.enqueue("messenger-handoff-continue", { handoffId }, { delaySeconds: BUSY_RETRY_SECONDS });
    return;
  }
  // Хода не было (лимит расходов) — человек видит, на чём остановились: последнее сообщение до кнопок (про кнопки
  // веб-чата в мессенджере не к месту)
  const answer =
    written.kind === "answer" && (written.text.trim() || written.video || written.image) ? written : await lastSentBefore(deps.db, passage.id, handoff.offeredAt);
  if (!answer) return;
  const recorded = await recordOutbound(deps.db, deps.clock, {
    botId: person.botId,
    personId: person.id,
    kind: "outreach",
    passageId: passage.id,
    text: await tagPassageText(deps.db, passage.id, answer.text),
    ...(answer.video && { video: answer.video }),
    ...("image" in answer && answer.image && { imagePath: sentImagePath(answer.image) }),
    ...("imagePath" in answer && answer.imagePath && { imagePath: answer.imagePath }),
    idempotencyKey,
  });
  if (recorded.created) await scheduleOutboundSend(deps.queue, recorded.id);
}

async function lastSentBefore(db: DatabaseExecutor, passageId: string, before: Date) {
  const [last] = await db
    .select({ text: outboundMessages.text, video: outboundMessages.video, imagePath: outboundMessages.imagePath })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.passageId, passageId), eq(outboundMessages.status, "sent"), lt(outboundMessages.createdAt, before)))
    .orderBy(desc(outboundMessages.sentAt))
    .limit(1);
  return last ?? null;
}
