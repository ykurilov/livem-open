import { randomUUID } from "node:crypto";
import { SpendingLimitReachedError } from "@ykurilov/agent-chat-core";
import { and, asc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AlertService } from "../alerts";
import { enqueueOutbound, outboundMessages } from "../channels";
import { sentImagePath } from "../images";
import type { ShownVideoLink } from "../videos";
import { appClosingAfter, buildConsultantTail } from "../consultant";
import { ConsultantTurnFailedError, type HeadlessConsultant, type TurnAnswer } from "../consultant/headless-turn";
import type { AgentFlowHandle } from "@ykurilov/agent-chat-flows";
import { PROGRAM_DAY_START } from "../flows";
import { getVersion, type LeadMagnetSettings } from "../lead-magnets";
import { people } from "../people";
import type { Clock } from "../platform/clock";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { readSettings } from "../platform/settings";
import {
  BUDGET_PAUSE_TEXT,
  DAILY_LIMIT_TEXT,
  MAX_TURN_PROVIDER_FAILURES,
  MODEL_DELAY_AFTER_TURN_FAILURES,
  MODEL_DELAY_TEXT,
  morningAfter,
  reminderCostOf,
  turnRetryDelaySeconds,
  type ModelFailureTracker,
} from "../spending";
import type { DatabaseExecutor } from "../platform/db";
import { attachmentNoteOf, personMessageText } from "./person-message";
import { MESSAGE_LIMIT_REASON, passageStatusOf } from "../flows/events";
import { noteCongratulationDelivered } from "../purchases/orders";
import { tagPassageTexts } from "../purchases/outgoing";
import { endActivePassages, type PassageEndStatus } from "./passage-end";
import { inboundMessages, passages } from "./schema";

/** Ход остановлен вместе с работником — через столько его повторит новый. */
const RETRY_AFTER_STOP_SECONDS = 5;

/**
 * Ключ отложенного хода (утро после лимита, повтор после сбоя модели). Свой, не ключ прохождения: отложенная задача не
 * держит живую — человек написал после сброса лимита, ход идёт сразу, а утренний находит, что отвечать нечего.
 */
export const delayedTurnKey = (passageId: string) => `inbound-turn:later:${passageId}`;

export interface TurnDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
  consultant: Pick<HeadlessConsultant, "runTurn" | "chatCost" | "checkedClosingAnswer" | "answerOf">;
  /**
   * Сценарий разговора: решение о входящем (`admit`) — конец разговора и пауза сотрудника; конец по пределу сообщений
   * (`end`) — после записи «завершил», иначе касания продолжили бы уходить по закрытому разговору.
   */
  flow: Pick<AgentFlowHandle, "admit" | "end">;
  spending: TurnSpending;
  alerts: AlertService;
}

/** Деньги и здоровье модели вокруг хода. */
export interface TurnSpending {
  /** Расход месяца дошёл до аварийной остановки. */
  isEmergencyStopped(): Promise<boolean>;
  /** Пороги месячного бюджета после хода. */
  checkBudget(): Promise<unknown>;
  modelFailures: ModelFailureTracker;
}

type InboundRow = typeof inboundMessages.$inferSelect;
type PassageRow = typeof passages.$inferSelect;

type Claim =
  | { kind: "nothing" }
  | {
      kind: "turn";
      passage: PassageRow;
      settings: LeadMagnetSettings;
      messages: InboundRow[];
      /** Сообщения уже отмечены ходом, который не дошёл до ответа: повтор отвечает на них. */
      turnId?: string;
    };

type TurnClaim = Extract<Claim, { kind: "turn" }>;

/** Ход прохождения после начала: его сообщения (`turn_id` ставит начало хода SDK) и сообщения, отданные этим вызовом. */
interface TurnRef {
  passage: PassageRow;
  settings: LeadMagnetSettings;
  turnId: string | null;
  messageIds: string[];
}

/** Сообщения прохождения, на которые консультант ещё не ответил. */
const waitingFor = (passageId: string) =>
  and(
    eq(inboundMessages.passageId, passageId),
    eq(inboundMessages.route, "passage"),
    eq(inboundMessages.startedPassage, false),
    isNull(inboundMessages.answeredAt),
  );

/** Неотвеченные сообщения хода: отмеченные им и отданные вызовом. */
const unansweredOf = (ref: TurnRef): SQL =>
  and(
    or(...(ref.turnId ? [eq(inboundMessages.turnId, ref.turnId)] : []), inArray(inboundMessages.id, ref.messageIds.length ? ref.messageIds : [""])),
    isNull(inboundMessages.answeredAt),
  )!;

/**
 * Задача `inbound-turn`: сообщения человека — консультанту сразу, пачкой SDK. Ход начнётся, когда человек замолчит на
 * окно тишины (`BURST_QUIET_MS`), — один на все сообщения окна, ответ ровно один. Сообщения пришли по одному — каждое
 * своей задачей: ответит задача последнего, остальные выходят. Упал работник посреди окна — пачку помнит хранилище SDK,
 * ответит обход нового работника (`settleUnattendedTurn`). Повтор задачи ничего не задвоит: SDK не пишет сообщение
 * второй раз, мессенджер не шлёт ответ второй раз (ключ `turn:<id>`).
 */
export async function runPassageTurn(deps: TurnDependencies, passageId: string): Promise<void> {
  if ((await deps.spending.isEmergencyStopped()) && (await pauseForBudget(deps, passageId))) return;

  const claim = await claimTurn(deps, passageId);
  if (claim.kind === "nothing") return;

  try {
    await answerTurn(deps, claim);
  } catch (error) {
    if (error instanceof SpendingLimitReachedError) return await postponeTillMorning(deps, claim, error);
    if (error instanceof ConsultantTurnFailedError) return await handleFailedTurn(deps, await refOf(deps, claim, error.questionId), error);
    throw error;
  }
}

/** Ход по сообщениям вызова: `turn_id` — у сообщения, на которое ответ (его ставит начало хода). */
async function refOf(deps: Pick<TurnDependencies, "db">, claim: TurnClaim, questionId?: string): Promise<TurnRef> {
  const turnId = (questionId && (await turnIdOf(deps.db, questionId))) || claim.turnId || null;
  return { passage: claim.passage, settings: claim.settings, turnId, messageIds: claim.messages.map((message) => message.id) };
}

async function turnIdOf(db: DatabaseExecutor, inboundMessageId: string): Promise<string | null> {
  const [row] = await db.select({ turnId: inboundMessages.turnId }).from(inboundMessages).where(eq(inboundMessages.id, inboundMessageId));
  return row?.turnId ?? null;
}

/**
 * Начало хода SDK на пачку (`beforeTurn`, и у хода без вызова): сообщения пачки отмечаются одним ходом и идут в счёт
 * сообщений человека; хвост хода — по новому счёту. Повтор той же пачки (ход не начался, упал) — тот же ход, счёт прежний.
 * Чат не прохождение — `null`.
 */
export async function reserveBurstTurn(
  deps: Pick<TurnDependencies, "db">,
  input: { chatId: string; burstMessageIds: string[] },
): Promise<{ tail: string | null } | null> {
  return deps.db.transaction(async (tx) => {
    const [passage] = await tx.select().from(passages).where(eq(passages.chatId, input.chatId)).for("update");
    if (!passage) return null;
    const rows = await tx
      .select()
      .from(inboundMessages)
      .where(and(eq(inboundMessages.passageId, passage.id), inArray(inboundMessages.id, input.burstMessageIds)));
    const fresh = rows.filter((row) => !row.turnId);
    const turnId = rows.find((row) => row.turnId)?.turnId ?? randomUUID();
    const personMessageCount = passage.personMessageCount + fresh.length;
    if (fresh.length > 0) {
      await tx.update(inboundMessages).set({ turnId }).where(inArray(inboundMessages.id, fresh.map((row) => row.id)));
      await tx.update(passages).set({ personMessageCount }).where(eq(passages.id, passage.id));
    }
    const snapshot = await getVersion(tx, passage.snapshotId);
    if (!snapshot) throw new Error(`Снимок ${passage.snapshotId} не найден`);
    return { tail: tailOf(snapshot.settings, personMessageCount, rows) };
  });
}

/**
 * Ход на пачку не начался из-за лимита расходов: отметки сняты, утром один ход на эти сообщения и на всё, что человек
 * допишет за ночь.
 */
export async function releaseBurstTurn(deps: Pick<TurnDependencies, "db">, input: { chatId: string; burstMessageIds: string[] }): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const released = await tx
      .update(inboundMessages)
      .set({ turnId: null })
      .where(and(inArray(inboundMessages.id, input.burstMessageIds), isNull(inboundMessages.answeredAt)))
      .returning({ id: inboundMessages.id });
    if (released.length > 0)
      await tx
        .update(passages)
        .set({ personMessageCount: sql`greatest(${passages.personMessageCount} - ${released.length}, 0)` })
        .where(eq(passages.chatId, input.chatId));
  });
}

/** Наш хвост: отсчёт до предела и пометка о вложениях. День, этап, рамки и пояс сценарий допишет сам. */
function tailOf(settings: LeadMagnetSettings, personMessageCount: number, messages: readonly InboundRow[]): string | null {
  return [buildConsultantTail({ settings, personMessageCount }), attachmentNoteOf(messages)].filter(Boolean).join("\n") || null;
}

/**
 * Ход на брошенную пачку закончен без вызова (работник упал или перезапустился посреди окна, ответил обход SDK службой
 * версии этого разговора): ответ — человеку через наш бот, как у обычного хода. Ход упал — как у обычного хода.
 */
export async function settleUnattendedTurn(deps: TurnDependencies, input: { chatId: string; answerId: string }): Promise<void> {
  const answer = await deps.consultant.answerOf(input.answerId);
  if (!answer) return;
  const [question] = await deps.db.select().from(inboundMessages).where(eq(inboundMessages.id, answer.questionId));
  if (!question?.passageId) return;
  const [passage] = await deps.db.select().from(passages).where(eq(passages.id, question.passageId));
  const snapshot = passage && (await getVersion(deps.db, passage.snapshotId));
  if (!snapshot) return;
  const turnId = question.turnId ?? null;
  const messages = turnId ? await deps.db.select({ id: inboundMessages.id }).from(inboundMessages).where(eq(inboundMessages.turnId, turnId)) : [question];
  const ref: TurnRef = { passage, settings: snapshot.settings, turnId, messageIds: messages.map((message) => message.id) };
  if (answer.status === "complete") return await answered(deps, ref, answer);
  if (answer.status === "error") return await handleFailedTurn(deps, ref, new ConsultantTurnFailedError("error", answer.errorKind));
  // Остановлен или прерван: ход повторит задача
  await retryAfterShutdown(deps, passage.id);
}

/** Ответ ушёл человеку: модель здорова; написал, пока шёл ход, — следующий ход; пороги бюджета. */
async function answered(deps: TurnDependencies, ref: TurnRef, answer: TurnAnswer): Promise<void> {
  const moreWaiting = await deliverAnswer(deps, ref, answer);
  await deps.spending.modelFailures.recordSuccess();
  if (moreWaiting) await deps.queue.enqueue("inbound-turn", { passageId: ref.passage.id }, { singletonKey: ref.passage.id });
  try {
    await deps.spending.checkBudget();
  } catch (error) {
    // Ответ уже ушёл; пороги проверит задача `budget-check`
    console.error("Проверка бюджета после хода не удалась:", error instanceof Error ? error.message : error);
  }
}

/**
 * Аварийная остановка: модель не зовём, разговор ждёт подъёма бюджета или нового месяца.
 * Отметка `budget_paused_at` — только если человеку есть что ответить; он один раз за остановку получает
 * «отвечу чуть позже» (ключ — прохождение и начало остановки). Возвращает `false`, если разговор не идёт.
 */
async function pauseForBudget(deps: TurnDependencies, passageId: string): Promise<boolean> {
  const [passage] = await deps.db
    .select({ status: passages.status, personId: passages.personId })
    .from(passages)
    .where(eq(passages.id, passageId));
  if (passage?.status !== "active") return false;
  const [waiting] = await deps.db.select({ id: inboundMessages.id }).from(inboundMessages).where(waitingFor(passageId)).limit(1);
  if (!waiting) return true;

  const [paused] = await deps.db
    .update(passages)
    .set({ budgetPausedAt: sql`coalesce(${passages.budgetPausedAt}, ${deps.clock.now()})` })
    .where(eq(passages.id, passageId))
    .returning({ budgetPausedAt: passages.budgetPausedAt });
  await enqueueOutbound(deps, {
    botId: await botOf(deps, passage.personId),
    personId: passage.personId,
    kind: "system",
    passageId,
    text: BUDGET_PAUSE_TEXT,
    idempotencyKey: `budget-pause:${passageId}:${paused!.budgetPausedAt!.toISOString()}`,
  });
  return true;
}

/**
 * Дневной лимит человека исчерпан: модель не вызвана, человеку готовый текст (один раз за день),
 * утром ход на всё, что он написал. Цепочку напоминаний не трогаем.
 */
async function postponeTillMorning(deps: TurnDependencies, claim: TurnClaim, limit: SpendingLimitReachedError): Promise<void> {
  // Сообщения снова ждут: лимит проверен до записи, а отказ при начале хода снял отметки (`releaseBurstTurn`)
  const { passage, settings } = claim;
  // Отметка — чтобы поднятый в настройках лимит сразу отпустил разговор
  await deps.db.update(passages).set({ dailyLimitPausedAt: deps.clock.now() }).where(eq(passages.id, passage.id));
  // У программы утро — начало её дня по поясу человека
  const morning = await morningAfter(
    deps,
    limit.resetsAt,
    settings.flow.schedule ? { morningAt: settings.flow.schedule.dayStart ?? PROGRAM_DAY_START, timeZone: await timeZoneOf(deps, passage.personId) } : undefined,
  );
  const delaySeconds = Math.max(0, Math.ceil((morning.getTime() - deps.clock.now().getTime()) / 1000));
  await deps.queue.enqueue("inbound-turn", { passageId: passage.id }, { singletonKey: delayedTurnKey(passage.id), delaySeconds });
  await enqueueOutbound(deps, {
    botId: await botOf(deps, passage.personId),
    personId: passage.personId,
    kind: "system",
    passageId: passage.id,
    text: DAILY_LIMIT_TEXT,
    idempotencyKey: `daily-limit:${passage.id}:${deps.clock.mskDate()}`,
  });
}

/**
 * Ход упал. Сбой провайдера — тот же ход повторяется позже и всё реже; ошибка в очередь не уходит,
 * иначе повторы очереди кончатся и человек останется без ответа. Со второго сбоя хода человеку «отвечу чуть позже».
 * Не сбой провайдера или сбоев больше потолка — повторять незачем: разговор передаётся эксперту.
 * Ход остановила остановка работника — не сбой: тот же ход повторит новый работник.
 */
async function handleFailedTurn(deps: TurnDependencies, ref: TurnRef, failure: ConsultantTurnFailedError): Promise<void> {
  const { passage } = ref;
  if (failure.byShutdown) return retryAfterShutdown(deps, passage.id);
  console.error(`Ход прохождения ${passage.id} упал:`, failure.message);
  if (!failure.isProviderFailure) return handOverToExpert(deps, ref, failure.reason);

  await deps.spending.modelFailures.recordFailure(failure.message);
  const [counted] = await deps.db
    .update(passages)
    .set({ turnFailures: sql`${passages.turnFailures} + 1` })
    .where(eq(passages.id, passage.id))
    .returning({ turnFailures: passages.turnFailures });
  const failures = counted!.turnFailures;
  if (failures >= MAX_TURN_PROVIDER_FAILURES)
    return handOverToExpert(deps, ref, `${failure.reason}, попыток за сутки: ${failures}`);

  await deps.queue.enqueue(
    "inbound-turn",
    { passageId: passage.id },
    { singletonKey: delayedTurnKey(passage.id), delaySeconds: turnRetryDelaySeconds(failures) },
  );
  if (failures >= MODEL_DELAY_AFTER_TURN_FAILURES) await sendModelDelay(deps, ref);
}

/** Задача хода переживёт остановку в очереди; не встала — ход найдёт подметальщик (`requeueLostTurns`). */
async function retryAfterShutdown(deps: TurnDependencies, passageId: string): Promise<void> {
  try {
    await deps.queue.enqueue("inbound-turn", { passageId }, { singletonKey: passageId, delaySeconds: RETRY_AFTER_STOP_SECONDS });
  } catch (error) {
    console.error(`Ход прохождения ${passageId} остановлен вместе с работником, задача не поставлена:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Консультант не смог ответить: сообщения хода — во «Входящие» эксперту, у прохождения — пометка с причиной,
 * эксперту — тревога про этот разговор. Человеку — «отвечу чуть позже», если ещё не получал.
 * Разговор остаётся активным: следующее сообщение человека — снова к консультанту.
 */
async function handOverToExpert(deps: TurnDependencies, ref: TurnRef, reason: string): Promise<void> {
  const { passage } = ref;
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await tx.update(inboundMessages).set({ route: "inbox" }).where(unansweredOf(ref));
    // «Входящие» показывают причину по `handed_to_expert_at`, пока эксперт не ответил
    await tx
      .update(passages)
      // Напоминать некому: консультант не отвечает. Следующий его ответ начнёт цепочку заново
      .set({ turnFailures: 0, handedToExpertAt: now, handoverReason: reason, nextReminderAt: null })
      .where(eq(passages.id, passage.id));
  });
  await sendModelDelay(deps, ref);
  await deps.alerts.raise(
    "turn_failed",
    `Консультант не смог ответить человеку (разговор ${passage.id}): ${reason}\nСообщения переданы во «Входящие» — ответьте вручную.`,
    `${passage.id}:${turnKey(ref)}`,
  );
}

/** Ключ хода для исходящих и тревог: ход приложения, а до его начала — последнее сообщение вызова. */
const turnKey = (ref: TurnRef) => ref.turnId ?? ref.messageIds.at(-1) ?? ref.passage.id;

async function sendModelDelay(deps: TurnDependencies, ref: TurnRef): Promise<void> {
  const { passage } = ref;
  await enqueueOutbound(deps, {
    botId: await botOf(deps, passage.personId),
    personId: passage.personId,
    kind: "system",
    passageId: passage.id,
    text: MODEL_DELAY_TEXT,
    idempotencyKey: `model-delay:${turnKey(ref)}`,
  });
}

async function timeZoneOf(deps: Pick<TurnDependencies, "db">, personId: string): Promise<string | null> {
  const [person] = await deps.db.select({ timeZone: people.timeZone }).from(people).where(eq(people.id, personId));
  return person?.timeZone ?? null;
}

async function botOf(deps: Pick<TurnDependencies, "db">, personId: string): Promise<string> {
  const [person] = await deps.db.select({ botId: people.botId }).from(people).where(eq(people.id, personId));
  if (!person) throw new Error(`Человек ${personId} не найден`);
  return person.botId;
}

/** Ход консультанта на сообщения вызова: ответ человеку и пометка «отвечено». */
async function answerTurn(deps: TurnDependencies, claim: TurnClaim): Promise<void> {
  const { passage } = claim;
  // Решение сценария о входящем: разговор закончился — эксперту; рамку дня и паузу держат ворота хода службы
  const decision = await deps.flow.admit({ ownerId: passage.personId, chatId: passage.chatId });
  if (decision.kind === "ended") return endedBeforeTurn(deps, claim, passageStatusOf(decision.reason));
  const answer = await askConsultant(deps, claim);
  // Отвечает другой вызов (следующее сообщение пачки) или ход без вызова: ответ доставит он
  if (answer.elsewhere) return;
  const ref = await refOf(deps, claim, answer.questionId);
  if (answer.held) {
    // Пока ход ждал тишины, эксперт ответил или разговор закончился: решение — текущее, а не с начала хода
    const current = decision.kind === "paused" ? decision : await deps.flow.admit({ ownerId: passage.personId, chatId: passage.chatId });
    if (current.kind === "ended") return endedBeforeTurn(deps, claim, passageStatusOf(current.reason));
    if (await heldWithoutAnswer(deps, ref, current.kind === "paused"))
      await deps.queue.enqueue("inbound-turn", { passageId: passage.id }, { singletonKey: passage.id });
    return;
  }
  await answered(deps, ref, answer);
}

/** Ответ консультанта человеку и пометка «отвечено». Возвращает, остались ли сообщения без ответа. */
async function deliverAnswer(deps: TurnDependencies, ref: TurnRef, answer: TurnAnswer): Promise<boolean> {
  const { passage, settings } = ref;
  const { text: modelReply, video, image } = answer;
  const passageId = passage.id;
  const [after] = await deps.db.select().from(passages).where(eq(passages.id, passageId));
  if (!after) throw new Error(`Прохождение ${passageId} пропало во время хода`);
  // Предел сообщений: консультант предупреждён хвостом, но если не завершил сам — завершает приложение.
  // У программы его заменяют рамки дня
  const reachedLimit = !settings.flow.schedule && after.status === "active" && after.personMessageCount >= settings.maxPersonMessages;
  const completed = after.status === "completed" || reachedLimit;
  // Согласившемуся последнее сообщение собирает приложение: ответ на вопрос из finish_dialog и прощание из настроек.
  // При отказе, уходе, пределе без итога и без прощания в настройках — последний ответ модели, как есть.
  const closing = completed ? appClosingAfter(after.summary, settings.farewellMessage) : null;
  // Ответ из finish_dialog мимо хранилища консультанта: проверяется здесь, прощание эксперта — нет
  const reply = closing
    ? await deps.consultant.checkedClosingAnswer({
        ownerId: passage.personId,
        chatId: passage.chatId,
        messageId: answer.answerId ?? answer.questionId,
        answer: closing.answer,
      })
    : modelReply;
  const farewell = closing?.farewell ?? "";
  // Ролик — после ответа, прощание — после ролика. Без ролика прощание — в том же сообщении, что и ответ.
  const text = video ? reply : [reply, farewell].filter(Boolean).join("\n\n");

  // Ответ — в очередь до пометки «отвечено»: упадём между ними — повтор найдёт готовый ответ, ключ не даст дубля.
  // Разговор за время хода ушёл в другой лидмагнит или человек заблокировал бота — ответ уже не к месту.
  let delivered = false;
  if (after.status === "active" || after.status === "completed") {
    const botId = await botOf(deps, passage.personId);
    if (text || video || image) {
      // Ссылки продукта — с личным кодом человека: по нему узнаем об оплате. История модели остаётся без меток
      const [taggedText, taggedFarewell] = await tagPassageTexts(deps.db, passageId, [text, farewell]);
      await enqueueOutbound(deps, {
        botId,
        personId: passage.personId,
        kind: "consultant",
        passageId,
        text: taggedText!,
        ...(video && { video, followUps: taggedFarewell ? [taggedFarewell] : [] }),
        // Картинка уходит фото, ответ — подписью к ней
        ...(image && { imagePath: sentImagePath(image) }),
        idempotencyKey: `turn:${turnKey(ref)}`,
      });
      delivered = true;
    }
  }

  const chatCost = await deps.consultant.chatCost(passage.chatId);
  const now = deps.clock.now();
  // Тишину после ответа и сообщения первым ведёт сценарий SDK: касания, ночь, потолок дня
  const moreWaiting = await deps.db.transaction(async (tx) => {
    await tx.update(inboundMessages).set({ answeredAt: now }).where(unansweredOf(ref));
    // `payment_check` этого хода нашёл оплату — поздравление ушло в ответе, запасная задача его не повторит
    if (delivered && ref.turnId) await noteCongratulationDelivered(tx, { passageId, turnId: ref.turnId, at: now });
    await tx
      .update(passages)
      .set({
        // Расход на тексты старых напоминаний мимо журнала SDK — к цене разговора
        costUsd: (chatCost + (await reminderCostOf(tx, passageId))).toFixed(6),
        turnFailures: 0,
        dailyLimitPausedAt: null,
        ...(reachedLimit && { status: "completed" as const, endedAt: now }),
      })
      .where(eq(passages.id, passageId));
    const left = await tx.select({ id: inboundMessages.id }).from(inboundMessages).where(waitingFor(passageId)).limit(1);
    return left.length > 0;
  });
  if (reachedLimit) await endFlowAtLimit(deps, passage, settings.maxPersonMessages);
  return moreWaiting;
}

/**
 * Предел сообщений записан — сценарий тоже заканчивается: сроки и касания сняты. Не вышло — ответ уже ушёл, а касание
 * по закрытому прохождению остановит доставка (`flows/delivery.ts`) и закончит сценарий сама.
 */
async function endFlowAtLimit(deps: TurnDependencies, passage: PassageRow, limit: number): Promise<void> {
  try {
    await deps.flow.end({ ownerId: passage.personId, chatId: passage.chatId, reason: MESSAGE_LIMIT_REASON, outcome: `предел сообщений человека: ${limit}` });
  } catch (error) {
    console.error(`Сценарий разговора ${passage.id} не закончен по пределу сообщений:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Разговор закончился раньше, чем дошёл ход (срок вышел, «не завершил», конец снаружи): консультант не отвечает,
 * сообщения — эксперту во «Входящие». Статус прохождения пишет `onFinish` сценария; не успел — пишем по той же причине.
 */
async function endedBeforeTurn(deps: TurnDependencies, claim: TurnClaim, status: PassageEndStatus): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(inboundMessages)
      .set({ route: "inbox" })
      .where(and(eq(inboundMessages.passageId, claim.passage.id), eq(inboundMessages.route, "passage"), isNull(inboundMessages.answeredAt)));
    await endActivePassages(tx, eq(passages.id, claim.passage.id), status, deps.clock.now());
  });
}

/**
 * Служба записала сообщения без хода: после жёсткой рамки дня утром на них ответит сценарий одним ходом, на паузе
 * сотрудника они — эксперту во «Входящие». Цепочку касаний не трогаем: консультант не отвечал.
 */
async function heldWithoutAnswer(deps: TurnDependencies, ref: TurnRef, paused: boolean): Promise<boolean> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await tx
      .update(inboundMessages)
      .set(paused ? { route: "inbox" } : { answeredAt: now })
      .where(unansweredOf(ref));
    const left = await tx.select({ id: inboundMessages.id }).from(inboundMessages).where(waitingFor(ref.passage.id)).limit(1);
    return left.length > 0;
  });
}

async function askConsultant(deps: TurnDependencies, claim: TurnClaim): Promise<TurnAnswer> {
  const { passage, settings, turnId, messages } = claim;
  const { maxMessageChars } = await readSettings(deps.db);
  return deps.consultant.runTurn({
    snapshotId: passage.snapshotId,
    settings,
    ownerId: passage.personId,
    chatId: passage.chatId,
    // Каждое сообщение — своим сообщением SDK с id входящего; пустое (без текста и вложения) модели не нужно
    messages: messages.flatMap((message) => {
      const text = personMessageText(message, maxMessageChars);
      return text ? [{ id: message.id, text }] : [];
    }),
    ...(turnId && { turnId }),
    // Хвост повтора упавшего хода; у хода на пачку его даёт начало хода (`reserveBurstTurn`) по новому счёту
    tail: tailOf(settings, passage.personMessageCount, messages),
    expertReplies: await expertRepliesDuring(deps, passage),
  });
}

/** Ответы эксперта из «Входящих» человеку за этот разговор; не ушедшие человеку (бот заблокирован, сбой) не в счёт. */
async function expertRepliesDuring(deps: Pick<TurnDependencies, "db">, passage: PassageRow) {
  return deps.db
    .select({ id: outboundMessages.id, text: outboundMessages.text, staffName: outboundMessages.staffName })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.personId, passage.personId),
        eq(outboundMessages.kind, "manual_reply"),
        inArray(outboundMessages.status, ["queued", "sent"]),
        gte(outboundMessages.createdAt, passage.startedAt),
      ),
    )
    .orderBy(asc(outboundMessages.createdAt));
}

async function claimTurn(deps: TurnDependencies, passageId: string): Promise<Claim> {
  return deps.db.transaction(async (tx): Promise<Claim> => {
    const [passage] = await tx.select().from(passages).where(eq(passages.id, passageId)).for("update");
    if (!passage) throw new Error(`Прохождение ${passageId} не найдено`);

    const waiting = await tx.select().from(inboundMessages).where(waitingFor(passageId)).orderBy(asc(inboundMessages.receivedAt));
    if (waiting.length === 0) return { kind: "nothing" };

    // Ход, начатый и не дошедший до ответа (упал, работник остановился), — сначала он, с теми же сообщениями
    const unfinished = waiting.find((message) => message.turnId)?.turnId ?? undefined;
    if (passage.status !== "active") {
      // finish_dialog завершает разговор посреди хода: упавший ход всё равно доводится до ответа и прощания
      const finishing = passage.status === "completed" && unfinished;
      const late = waiting.filter((message) => !finishing || message.turnId !== unfinished);
      // Разговор закончился раньше, чем дошла очередь до этих сообщений: их увидит эксперт во «Входящих»
      if (late.length > 0)
        await tx
          .update(inboundMessages)
          .set({ route: "inbox" })
          .where(inArray(inboundMessages.id, late.map((message) => message.id)));
      if (!finishing) return { kind: "nothing" };
    }

    const snapshot = await getVersion(tx, passage.snapshotId);
    if (!snapshot) throw new Error(`Снимок ${passage.snapshotId} не найден`);
    const messages = unfinished ? waiting.filter((message) => message.turnId === unfinished) : waiting;
    return { kind: "turn", passage, settings: snapshot.settings, messages, ...(unfinished && { turnId: unfinished }) };
  });
}
