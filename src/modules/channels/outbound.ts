import { and, eq, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import type { BotCredentials, ChannelAdapter, SendResult } from "./channel";
import { videoMessageText, type ShownVideoLink } from "../videos/shown-video";
import type { RateLimiter } from "./rate-limiter";
import { passages } from "../conversations/schema";
import { reopenAfterUndeliveredAnswer, reopenAfterUndeliveredReply } from "../inbox/undelivered-reply";
import { outboundMessages, type OutboundKind } from "./schema";

export type OutboundMessageRecord = typeof outboundMessages.$inferSelect;

export interface SendTarget {
  adapter: ChannelAdapter;
  bot: BotCredentials;
  /** Идентификатор человека в мессенджере. */
  to: string;
}

export interface OutboundDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
  /** Без ограничителя отправка идёт без пауз (тесты, разовые сообщения). */
  rateLimiter?: RateLimiter;
  /**
   * Находит бота и адресата по записи. `null` — бота или человека больше нет. `db` — транзакция отправки: второе
   * соединение из пула, пока первое ждёт мессенджер, не нужно.
   */
  resolveTarget(message: OutboundMessageRecord, db: DatabaseExecutor): Promise<SendTarget | null>;
  /** Человек заблокировал бота: пометить его в базе. */
  onBlocked(message: OutboundMessageRecord): Promise<void>;
  /** Сообщение не ушло совсем: проверить бота и сообщить эксперту (тревога). Итог — чья беда (`SendFailureCause`). */
  onPermanentFailure(message: OutboundMessageRecord, error: string): Promise<SendFailureCause>;
  /** Сколько временных сбоев терпим, прежде чем сдаться. */
  maxAttempts?: number;
}

/**
 * Чья беда, что сообщение не ушло: `bot` — бот не работает (токен отозван); `connection` — бот не отвечает по временной
 * причине (сеть, прокси, мессенджер недоступен); `message` — беда только этого сообщения.
 */
export type SendFailureCause = "bot" | "connection" | "message";

export interface OutboundDraft {
  botId: string;
  personId: string;
  kind: OutboundKind;
  text: string;
  imagePath?: string;
  buttons?: Array<{ label: string; payload: string }>;
  /** Готовые ответы человека под ответом консультанта (`OutgoingMessage.quickReplies`). */
  quickReplies?: string[];
  /** Ролик консультанта: уходит отдельным сообщением сразу после текста. */
  video?: ShownVideoLink;
  /** Отдельные сообщения после текста и ролика, по порядку (прощание). */
  followUps?: string[];
  /** Ответ из «Входящих»: имя эксперта. */
  staffName?: string;
  mailingId?: string;
  /** Сообщение прохождения: закрытому разговору после починки бота оно не повторяется. */
  passageId?: string;
  /** Одно и то же событие не отправится дважды, сколько бы раз его ни поставили. */
  idempotencyKey: string;
  delaySeconds?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
/** Через сколько секунд сообщение, ждущее более раннее тому же человеку, проверит очередь снова. */
const ORDER_RECHECK_SECONDS = 1;
const EMPTY_MESSAGE_ERROR = "Пустое сообщение: отправлять нечего";
const REPLY_WINDOW_CLOSED_ERROR = "Окно ответа закрыто: писать первым нельзя, пока человек не напишет сам";
const BACKOFF_START_SECONDS = 10;
const BACKOFF_CAP_SECONDS = 600;
/** Сколько зависших сообщений подмётчик ставит за раз. */
const STUCK_BATCH = 500;
/** Сообщение, не ушедшее из-за бота, после его починки отправляется, только если ему не больше трёх суток. */
export const BOT_REPAIR_RESEND_WINDOW_DAYS = 3;
const OUTDATED_ANSWER_ERROR = `бот не работал дольше ${BOT_REPAIR_RESEND_WINDOW_DAYS} суток, ответ устарел и не отправлен`;

/** Записывает сообщение и ставит задачу отправки. Повторный вызов с тем же ключом ничего не меняет. */
export async function enqueueOutbound(
  deps: Pick<OutboundDependencies, "db" | "queue" | "clock">,
  draft: OutboundDraft,
): Promise<{ id: string; created: boolean }> {
  const recorded = await recordOutbound(deps.db, deps.clock, draft);
  if (!recorded.created) return recorded;
  try {
    await scheduleOutboundSend(deps.queue, recorded.id, draft.delaySeconds);
  } catch (error) {
    // Задачи нет — запись без задачи зависла бы навсегда. Откатываем, чтобы вызывающий мог повторить.
    await deps.db.delete(outboundMessages).where(eq(outboundMessages.id, recorded.id));
    throw error;
  }
  return recorded;
}

/**
 * Только записывает сообщение — в транзакции вызывающего, вместе с его проверкой и отметками. Задачу отправки ставит
 * `scheduleOutboundSend` после фиксации; не поставилась — запись подберёт `requeueStuckOutbound`. Повтор ключа — та же запись.
 */
export async function recordOutbound(db: DatabaseExecutor, clock: Clock, draft: OutboundDraft): Promise<{ id: string; created: boolean }> {
  const [inserted] = await db
    .insert(outboundMessages)
    .values({
      botId: draft.botId,
      personId: draft.personId,
      kind: draft.kind,
      text: draft.text,
      imagePath: draft.imagePath,
      buttons: draft.buttons,
      quickReplies: draft.quickReplies,
      video: draft.video,
      followUps: draft.followUps,
      staffName: draft.staffName,
      mailingId: draft.mailingId,
      passageId: draft.passageId,
      idempotencyKey: draft.idempotencyKey,
      nextAttemptAt: secondsFrom(clock, draft.delaySeconds ?? 0),
    })
    .onConflictDoNothing({ target: outboundMessages.idempotencyKey })
    .returning({ id: outboundMessages.id });
  if (inserted) return { id: inserted.id, created: true };
  const [existing] = await db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(eq(outboundMessages.idempotencyKey, draft.idempotencyKey));
  if (!existing) throw new Error("Запись с таким ключом пропала сразу после проверки");
  return { id: existing.id, created: false };
}

/** Задача отправки записанного сообщения. */
export async function scheduleOutboundSend(queue: JobEnqueuer, outboundMessageId: string, delaySeconds?: number): Promise<void> {
  await queue.enqueue("outbound-send", { outboundMessageId }, delaySeconds ? { delaySeconds } : undefined);
}

type Outcome =
  | { kind: "nothing" }
  | { kind: "early"; delaySeconds: number }
  | { kind: "retry"; delaySeconds: number }
  | { kind: "blocked"; message: OutboundMessageRecord }
  /** `temporary` — сдались после временных сбоев (сеть, прокси), а не после отказа мессенджера. */
  | { kind: "failed"; message: OutboundMessageRecord; error: string; temporary: boolean }
  /** Бот исправен, но ответ консультанта не уйдёт уже никогда: только во «Входящие», без тревоги. */
  | { kind: "answerUndelivered"; message: OutboundMessageRecord; error: string };

/** Выполняет задачу `outbound-send`: одна попытка отправки с учётом скорости бота и итогом в базе. */
export async function sendOutbound(deps: OutboundDependencies, outboundMessageId: string): Promise<void> {
  const attempted: { manualReply?: OutboundMessageRecord } = {};
  const attempt = async (tx: DatabaseExecutor): Promise<Outcome> => {
    // Строка блокируется на время отправки: две задачи на одно сообщение не отправят его дважды
    const [message] = await tx
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, outboundMessageId))
      .for("update", { skipLocked: true });

    if (!message) {
      const [exists] = await tx
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(eq(outboundMessages.id, outboundMessageId));
      if (!exists) throw new Error(`Исходящее сообщение ${outboundMessageId} не найдено`);
      return { kind: "nothing" }; // его уже отправляет другая задача
    }
    // Итог записан, а последствия — нет (работник упал после записи): доводим их
    if (message.outcomePending && message.status === "blocked") return { kind: "blocked", message };
    if (message.outcomePending && message.status === "failed") {
      if (message.error === REPLY_WINDOW_CLOSED_ERROR) return { kind: "answerUndelivered", message, error: message.error };
      const temporary = message.attempts >= (deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      return { kind: "failed", message, error: message.error ?? "", temporary };
    }
    if (message.status !== "queued") return { kind: "nothing" };
    if (message.kind === "manual_reply") attempted.manualReply = message;
    // Пауза после rate_limited или временного сбоя ещё идёт — ранний дубль задачи передаёт отправку на её конец
    const waitMs = message.nextAttemptAt.getTime() - deps.clock.now().getTime();
    if (waitMs > 0) return { kind: "early", delaySeconds: Math.ceil(waitMs / 1000) };
    // Более раннее сообщение тому же человеку ещё не ушло (его шлёт соседняя задача или оно на паузе) — ждём его:
    // человек получает сообщения по порядку записи, даже когда работник берёт их разом (возврат после починки бота)
    const earlier = await earlierQueuedTo(tx, message);
    if (earlier) {
      const earlierWaitMs = earlier.nextAttemptAt.getTime() - deps.clock.now().getTime();
      return { kind: "early", delaySeconds: Math.max(ORDER_RECHECK_SECONDS, Math.ceil(earlierWaitMs / 1000)) };
    }

    // Итог с последствиями помечается в той же записи: упадём до них — повтор задачи или подмётчик их доведут
    const withConsequences = { outcomePending: true, nextAttemptAt: deps.clock.now() };
    const target = await deps.resolveTarget(message, tx);
    if (!target) {
      const error = "Бот или получатель больше не существует";
      await tx.update(outboundMessages).set({ status: "failed", error, ...withConsequences }).where(eq(outboundMessages.id, message.id));
      return { kind: "failed", message, error, temporary: false };
    }

    await deps.rateLimiter?.acquire(target.bot.id, target.adapter.ratePerSecond);
    let result = await attemptSend(target, message);
    if (photoRefused(message, result, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      // Ответ важнее картинки — пробуем текстом. Текст ушёл — мессенджер не принял саму картинку (размер, формат):
      // повторы тоже без неё. Не ушёл и он — беда не в картинке (токен, сеть): она остаётся до повтора или починки бота
      const photoError = result.error;
      const withoutPhoto = await attemptSend(target, { ...message, imagePath: null });
      if (withoutPhoto.ok || (withoutPhoto.sentParts ?? 0) > 0) {
        console.error(`Картинка сообщения ${message.id} не принята: ${photoError}`);
        await tx.update(outboundMessages).set({ imagePath: null }).where(eq(outboundMessages.id, message.id));
      }
      // Без картинки сообщение пустое — итог прежний, ошибка картинки
      if (withoutPhoto.ok || withoutPhoto.reason !== "empty") result = withoutPhoto;
    }

    if (result.ok) {
      await tx
        .update(outboundMessages)
        .set({ status: "sent", externalMessageId: result.externalMessageId, sentAt: deps.clock.now(), error: null })
        .where(eq(outboundMessages.id, message.id));
      return { kind: "nothing" };
    }

    switch (result.reason) {
      case "blocked":
        await tx.update(outboundMessages).set({ status: "blocked", ...withConsequences }).where(eq(outboundMessages.id, message.id));
        return { kind: "blocked", message };

      case "reply_window_closed": {
        // Мессенджер не даёт писать, пока человек не ответит. Бот исправен, человек не блокировал: тревоги нет,
        // повтора нет. Сообщения первым идут мимо этой очереди: их окно ведёт сценарий (`flows/delivery.ts`).
        // Ответ консультанта сам уже не уйдёт — отвечать эксперту
        const error = REPLY_WINDOW_CLOSED_ERROR;
        const sentParts = result.sentParts ?? message.sentParts;
        const answer = message.kind === "consultant";
        await tx
          .update(outboundMessages)
          .set({ status: "failed", error, sentParts, ...(answer && withConsequences) })
          .where(eq(outboundMessages.id, message.id));
        return answer ? { kind: "answerUndelivered", message: { ...message, sentParts }, error } : { kind: "nothing" };
      }

      case "rate_limited": {
        // Ограничение скорости — не вина сообщения: попытка не засчитывается, но ушедшие части запоминаем
        const delaySeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        await tx
          .update(outboundMessages)
          .set({ sentParts: result.sentParts ?? message.sentParts, nextAttemptAt: secondsFrom(deps.clock, delaySeconds) })
          .where(eq(outboundMessages.id, message.id));
        return { kind: "retry", delaySeconds };
      }

      case "temporary": {
        const attempts = message.attempts + 1;
        if (attempts >= (deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
          const sentParts = result.sentParts ?? message.sentParts;
          await tx
            .update(outboundMessages)
            .set({ status: "failed", attempts, error: result.error, sentParts, ...withConsequences })
            .where(eq(outboundMessages.id, message.id));
          return { kind: "failed", message: { ...message, sentParts }, error: result.error, temporary: true };
        }
        const delaySeconds = Math.min(BACKOFF_START_SECONDS * 2 ** (attempts - 1), BACKOFF_CAP_SECONDS);
        await tx
          .update(outboundMessages)
          .set({
            attempts,
            error: result.error,
            sentParts: result.sentParts ?? message.sentParts,
            nextAttemptAt: secondsFrom(deps.clock, delaySeconds),
          })
          .where(eq(outboundMessages.id, message.id));
        return { kind: "retry", delaySeconds };
      }

      case "empty": {
        // Отправлять нечего: повтор ничего не изменит, а эксперту тревога не нужна — бот исправен
        const error = EMPTY_MESSAGE_ERROR;
        await tx.update(outboundMessages).set({ status: "failed", error }).where(eq(outboundMessages.id, message.id));
        console.error(`Исходящее сообщение ${message.id} пустое, не отправлено`);
        return { kind: "nothing" };
      }

      case "permanent": {
        // Ушедшие части запоминаем: после починки бота повтор продолжит с места остановки
        const sentParts = result.sentParts ?? message.sentParts;
        await tx
          .update(outboundMessages)
          .set({ status: "failed", error: result.error, sentParts, ...withConsequences })
          .where(eq(outboundMessages.id, message.id));
        return { kind: "failed", message: { ...message, sentParts }, error: result.error, temporary: false };
      }
    }
  };
  const outcome = await deps.db.transaction(async (tx) => {
    const decided = await attempt(tx);
    // Ответ эксперта из «Входящих» не ушёл совсем: переписка снова ждёт ответа — вместе с итогом, одной транзакцией
    const reply = attempted.manualReply;
    if (reply) {
      const [now] = await tx.select({ status: outboundMessages.status }).from(outboundMessages).where(eq(outboundMessages.id, reply.id));
      if (now?.status === "failed" || now?.status === "blocked") await reopenAfterUndeliveredReply(tx, reply);
    }
    return decided;
  });

  // Действия после записи итога: если они упадут, итог в базе уже сохранён, а пометка `outcome_pending` — до их конца
  const consequencesDone = (awaitsBotRepair = false) =>
    deps.db
      .update(outboundMessages)
      .set({
        outcomePending: false,
        ...(awaitsBotRepair && { awaitsBotRepair: sql`${outboundMessages.awaitsBotRepair} or ${outboundMessages.status} = 'failed'` }),
      })
      .where(eq(outboundMessages.id, outboundMessageId));
  switch (outcome.kind) {
    case "retry":
    case "early":
      await deps.queue.enqueue("outbound-send", { outboundMessageId }, { delaySeconds: outcome.delaySeconds });
      break;
    case "blocked":
      await deps.onBlocked(outcome.message);
      await consequencesDone();
      break;
    case "failed": {
      const cause = await deps.onPermanentFailure(outcome.message, outcome.error);
      // Сломан бот или пропала связь, пока шли повторы, — сообщение уйдёт после починки или возврата связи (проверка ботов).
      // Мессенджер отказал самому сообщению — беда сообщения, даже если проверка бота в тот же миг не прошла
      const awaitsBot = cause === "bot" || (cause === "connection" && outcome.temporary);
      // Бот исправен — ответ консультанта сам уже не уйдёт, отвечать эксперту
      if (outcome.message.kind === "consultant" && !awaitsBot) {
        await reopenAfterUndeliveredAnswer(deps.db, outcome.message, outcome.error, deps.clock.now());
      }
      await consequencesDone(awaitsBot);
      break;
    }
    case "answerUndelivered":
      await reopenAfterUndeliveredAnswer(deps.db, outcome.message, outcome.error, deps.clock.now());
      await consequencesDone();
      break;
    case "nothing":
      break;
  }
}

/**
 * Подмётчик: сообщения, которые ждут отправки, но срок их попытки давно прошёл, — задача потерялась
 * (процесс упал между записью и постановкой). И сообщения, чей итог записан, а последствия так и не доведены.
 * Ставит их заново; лишняя задача безвредна — строка блокируется при отправке.
 */
export async function requeueStuckOutbound(deps: Pick<OutboundDependencies, "db" | "queue">, overdueBefore: Date): Promise<number> {
  const stuck = await deps.db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(and(or(eq(outboundMessages.status, "queued"), eq(outboundMessages.outcomePending, true)), lt(outboundMessages.nextAttemptAt, overdueBefore)))
    .limit(STUCK_BATCH);
  for (const { id } of stuck) await deps.queue.enqueue("outbound-send", { outboundMessageId: id });
  return stuck.length;
}

/**
 * Бот снова в порядке (починили или вернулась связь): сообщения, не ушедшие из-за него за последние трое суток, ставятся
 * заново, по порядку записи; одному человеку они уходят по очереди (`earlierQueuedTo`), сколько бы задач работник ни брал разом. Запись та же, ключ повтора тот же — дважды сообщение не уйдёт. Старые просто перестают ждать;
 * устаревший ответ консультанта — эксперту во «Входящие», чтобы вопрос человека не потерялся.
 * Сообщения прохождения повторяются, только пока разговор идёт; ответ консультанта — и в завершённом разговоре (там итог и прощание).
 * Один запрос: пометку снимаем ровно с тех строк, что он разобрал, — помеченные позже ждут следующей починки.
 */
export async function requeueAfterBotRepair(deps: Pick<OutboundDependencies, "db" | "queue">, botId: string): Promise<number> {
  const fresh = sql`${outboundMessages.createdAt} > now() - make_interval(days => ${BOT_REPAIR_RESEND_WINDOW_DAYS})`;
  const passageStillOpen = sql`exists (
    select 1 from ${passages}
    where ${passages.id} = ${outboundMessages.passageId}
      and (${passages.status} = 'active' or (${passages.status} = 'completed' and ${outboundMessages.kind} = 'consultant'))
  )`;
  const passageAllows = sql`(${outboundMessages.passageId} is null or ${passageStillOpen})`;
  const resend = sql`${fresh} and ${passageAllows}`;
  const ifResend = (value: SQL, column: AnyColumn) =>
    sql`case when ${resend} then ${value} else ${column} end`;
  const handled = await deps.db
    .update(outboundMessages)
    .set({
      awaitsBotRepair: false,
      status: ifResend(sql`'queued'`, outboundMessages.status),
      attempts: ifResend(sql`0`, outboundMessages.attempts),
      error: ifResend(sql`null`, outboundMessages.error),
      // Срок попытки прежний, он уже прошёл: пауза не держит отправку, а потерянную задачу сразу подберёт подмётчик
    })
    .where(
      and(
        eq(outboundMessages.botId, botId),
        eq(outboundMessages.awaitsBotRepair, true),
        eq(outboundMessages.status, "failed"),
      ),
    )
    .returning({
      id: outboundMessages.id,
      status: outboundMessages.status,
      createdAt: outboundMessages.createdAt,
      personId: outboundMessages.personId,
      passageId: outboundMessages.passageId,
      idempotencyKey: outboundMessages.idempotencyKey,
      sentParts: outboundMessages.sentParts,
      outdatedAnswer: sql<boolean>`${outboundMessages.kind} = 'consultant' and not ${fresh} and ${passageAllows}`,
    });
  const requeued = handled.filter((message) => message.status === "queued").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // Если задача не встанет, сообщение подберёт подмётчик зависших
  for (const { id } of requeued) await deps.queue.enqueue("outbound-send", { outboundMessageId: id });
  for (const answer of handled.filter((message) => message.outdatedAnswer)) {
    try {
      // Срок окна — по времени базы, как и выше
      await reopenAfterUndeliveredAnswer(deps.db, answer, OUTDATED_ANSWER_ERROR, new Date());
    } catch (error) {
      console.error(`Устаревший ответ ${answer.id} не передан во «Входящие»:`, error instanceof Error ? error.message : String(error));
    }
  }
  return requeued.length;
}

/** Самое раннее неушедшее сообщение тому же человеку через того же бота, записанное до этого. */
async function earlierQueuedTo(db: DatabaseExecutor, message: OutboundMessageRecord): Promise<{ nextAttemptAt: Date } | null> {
  const [earlier] = await db
    .select({ nextAttemptAt: outboundMessages.nextAttemptAt })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.personId, message.personId),
        eq(outboundMessages.botId, message.botId),
        eq(outboundMessages.status, "queued"),
        // Время записи сравнивается в базе: в JavaScript оно теряет микросекунды
        sql`(${outboundMessages.createdAt}, ${outboundMessages.id}) < (select o.created_at, o.id from ${outboundMessages} o where o.id = ${message.id})`,
      ),
    )
    .orderBy(outboundMessages.createdAt)
    .limit(1);
  return earlier ?? null;
}

function secondsFrom(clock: Clock, seconds: number): Date {
  return new Date(clock.now().getTime() + seconds * 1000);
}

/** Что человек получит по порядку: текст, ролик, дополнительные сообщения. По этому же порядку их показывают «Входящие». */
export function outboundPartsOf(message: Pick<OutboundMessageRecord, "text" | "video" | "followUps">): Array<{ text: string; video: ShownVideoLink | null }> {
  const parts = [
    { text: message.text, video: null },
    ...(message.video ? [{ text: videoMessageText(message.video), video: message.video }] : []),
    ...message.followUps.map((text) => ({ text, video: null })),
  ].filter((part) => part.video || part.text.trim() !== "");
  return parts.length > 0 ? parts : [{ text: message.text, video: null }];
}

/** Окончательный сбой на картинке: ни одна часть сообщения не ушла, а повторять с картинкой бесполезно. Виновата ли она — покажет попытка без неё. */
function photoRefused(
  message: OutboundMessageRecord,
  result: SendResult,
  maxAttempts: number,
): result is Extract<SendResult, { reason: "permanent" | "temporary" }> {
  if (!message.imagePath || result.ok || (result.sentParts ?? message.sentParts) > 0) return false;
  return result.reason === "permanent" || (result.reason === "temporary" && message.attempts + 1 >= maxAttempts);
}

/** Одна попытка отправки записи адаптером: части с `sentParts`, исключение адаптера — временный сбой. */
export async function attemptSend(target: SendTarget, message: OutboundMessageRecord): Promise<SendResult> {
  // Ролик — сразу после текста, прощание — после ролика: одно сообщение частями, повтор продолжает с места остановки
  const followUps = [...(message.video ? [videoMessageText(message.video)] : []), ...message.followUps];
  try {
    return await target.adapter.send(target.bot, target.to, {
      text: message.text,
      followUps,
      imagePath: message.imagePath ?? undefined,
      buttons: message.buttons ?? undefined,
      ...(message.quickReplies && { quickReplies: message.quickReplies }),
      idempotencyKey: message.idempotencyKey,
      sentParts: message.sentParts,
    });
  } catch (error) {
    return { ok: false, reason: "temporary", error: error instanceof Error ? error.message : String(error) };
  }
}
