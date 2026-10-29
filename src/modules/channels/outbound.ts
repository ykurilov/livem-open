import { and, eq, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import type { BotCredentials, ChannelAdapter, SendResult } from "./channel";
import { videoMessageText, type ShownVideoLink } from "../videos/shown-video";
import type { RateLimiter } from "./rate-limiter";
import { passages } from "../conversations/schema";
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
  /** Находит бота и адресата по записи. `null` — бота или человека больше нет. */
  resolveTarget(message: OutboundMessageRecord): Promise<SendTarget | null>;
  /** Человек заблокировал бота: пометить его в базе. */
  onBlocked(message: OutboundMessageRecord): Promise<void>;
  /**
   * Сообщение не ушло совсем: сообщить эксперту (тревога). Итог — чья беда: `bot` — бот не работает (токен отозван),
   * тогда сообщение ждёт починки бота; `message` — беда только этого сообщения.
   */
  onPermanentFailure(message: OutboundMessageRecord, error: string): Promise<SendFailureCause>;
  /** Сколько временных сбоев терпим, прежде чем сдаться. */
  maxAttempts?: number;
}

export type SendFailureCause = "bot" | "message";

export interface OutboundDraft {
  botId: string;
  personId: string;
  kind: OutboundKind;
  text: string;
  imagePath?: string;
  buttons?: Array<{ label: string; payload: string }>;
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
const EMPTY_MESSAGE_ERROR = "Пустое сообщение: отправлять нечего";
const REPLY_WINDOW_CLOSED_ERROR = "Окно ответа закрыто: писать первым нельзя, пока человек не напишет сам";
const BACKOFF_START_SECONDS = 10;
const BACKOFF_CAP_SECONDS = 600;
/** Сколько зависших сообщений подмётчик ставит за раз. */
const STUCK_BATCH = 500;
/** Сообщение, не ушедшее из-за бота, после его починки отправляется, только если ему не больше трёх суток. */
export const BOT_REPAIR_RESEND_WINDOW_DAYS = 3;

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
  | { kind: "retry"; delaySeconds: number }
  | { kind: "blocked"; message: OutboundMessageRecord }
  | { kind: "failed"; message: OutboundMessageRecord; error: string };

/** Выполняет задачу `outbound-send`: одна попытка отправки с учётом скорости бота и итогом в базе. */
export async function sendOutbound(deps: OutboundDependencies, outboundMessageId: string): Promise<void> {
  const outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
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
    if (message.status !== "queued") return { kind: "nothing" };

    const target = await deps.resolveTarget(message);
    if (!target) {
      const error = "Бот или получатель больше не существует";
      await tx.update(outboundMessages).set({ status: "failed", error }).where(eq(outboundMessages.id, message.id));
      return { kind: "failed", message, error };
    }

    await deps.rateLimiter?.acquire(target.bot.id, target.adapter.ratePerSecond);
    let result = await attemptSend(target, message);
    if (photoRefused(message, result, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
      // Мессенджер не принял картинку (размер, формат): ответ важнее картинки — уходит текстом, повторы тоже без неё
      console.error(`Картинка сообщения ${message.id} не принята: ${result.error}`);
      await tx.update(outboundMessages).set({ imagePath: null }).where(eq(outboundMessages.id, message.id));
      result = await attemptSend(target, { ...message, imagePath: null });
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
        await tx.update(outboundMessages).set({ status: "blocked" }).where(eq(outboundMessages.id, message.id));
        return { kind: "blocked", message };

      case "reply_window_closed": {
        // Мессенджер не даёт писать, пока человек не ответит. Бот исправен, человек не блокировал: тревоги нет,
        // повтора нет. Сообщения первым идут мимо этой очереди: их окно ведёт сценарий (`flows/delivery.ts`)
        await tx.update(outboundMessages).set({ status: "failed", error: REPLY_WINDOW_CLOSED_ERROR }).where(eq(outboundMessages.id, message.id));
        return { kind: "nothing" };
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
          await tx
            .update(outboundMessages)
            .set({ status: "failed", attempts, error: result.error, sentParts: result.sentParts ?? message.sentParts })
            .where(eq(outboundMessages.id, message.id));
          return { kind: "failed", message, error: result.error };
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

      case "permanent":
        // Ушедшие части запоминаем: после починки бота повтор продолжит с места остановки
        await tx
          .update(outboundMessages)
          .set({ status: "failed", error: result.error, sentParts: result.sentParts ?? message.sentParts })
          .where(eq(outboundMessages.id, message.id));
        return { kind: "failed", message, error: result.error };
    }
  });

  // Действия после записи итога: если они упадут, итог в базе уже сохранён
  switch (outcome.kind) {
    case "retry":
      await deps.queue.enqueue("outbound-send", { outboundMessageId }, { delaySeconds: outcome.delaySeconds });
      break;
    case "blocked":
      await deps.onBlocked(outcome.message);
      break;
    case "failed": {
      const cause = await deps.onPermanentFailure(outcome.message, outcome.error);
      if (cause === "bot") {
        await deps.db
          .update(outboundMessages)
          .set({ awaitsBotRepair: true })
          .where(and(eq(outboundMessages.id, outboundMessageId), eq(outboundMessages.status, "failed")));
      }
      break;
    }
    case "nothing":
      break;
  }
}

/**
 * Подмётчик: сообщения, которые ждут отправки, но срок их попытки давно прошёл, — задача потерялась
 * (процесс упал между записью и постановкой). Ставит их заново; лишняя задача безвредна — строка блокируется при отправке.
 */
export async function requeueStuckOutbound(deps: Pick<OutboundDependencies, "db" | "queue">, overdueBefore: Date): Promise<number> {
  const stuck = await deps.db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.status, "queued"), lt(outboundMessages.nextAttemptAt, overdueBefore)))
    .limit(STUCK_BATCH);
  for (const { id } of stuck) await deps.queue.enqueue("outbound-send", { outboundMessageId: id });
  return stuck.length;
}

/**
 * Бот снова в порядке: сообщения, не ушедшие из-за него за последние трое суток, ставятся заново.
 * Запись та же, ключ повтора тот же — дважды сообщение не уйдёт. Старые просто перестают ждать.
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
  const resend = sql`${fresh} and (${outboundMessages.passageId} is null or ${passageStillOpen})`;
  const ifResend = (value: SQL, column: AnyColumn) =>
    sql`case when ${resend} then ${value} else ${column} end`;
  const handled = await deps.db
    .update(outboundMessages)
    .set({
      awaitsBotRepair: false,
      status: ifResend(sql`'queued'`, outboundMessages.status),
      attempts: ifResend(sql`0`, outboundMessages.attempts),
      error: ifResend(sql`null`, outboundMessages.error),
      nextAttemptAt: ifResend(sql`now()`, outboundMessages.nextAttemptAt),
    })
    .where(
      and(
        eq(outboundMessages.botId, botId),
        eq(outboundMessages.awaitsBotRepair, true),
        eq(outboundMessages.status, "failed"),
      ),
    )
    .returning({ id: outboundMessages.id, status: outboundMessages.status });
  const requeued = handled.filter((message) => message.status === "queued");
  // Если задача не встанет, сообщение подберёт подмётчик зависших
  for (const { id } of requeued) await deps.queue.enqueue("outbound-send", { outboundMessageId: id });
  return requeued.length;
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

/** Окончательный сбой на самой картинке: ни одна часть сообщения не ушла, а повторять с картинкой бесполезно. */
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
      idempotencyKey: message.idempotencyKey,
      sentParts: message.sentParts,
    });
  } catch (error) {
    return { ok: false, reason: "temporary", error: error instanceof Error ? error.message : String(error) };
  }
}
