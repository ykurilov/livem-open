import type { ChatStorage } from "@ykurilov/agent-chat-core";
import type { FlowDeliveryOutcome, FlowEndInput, FlowOutgoing } from "@ykurilov/agent-chat-flows";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import {
  attemptSend,
  findBotWithCredentials,
  type ChannelAdapters,
  type OutboundMessageRecord,
  type RateLimiter,
  type SendFailureCause,
  type SendTarget,
} from "../channels";
import { BOT_REPAIR_RESEND_WINDOW_DAYS } from "../channels/outbound";
import { outboundMessages } from "../channels/schema";
import { mediaSentWith } from "../consultant/sent-media";
import { sentImagePath } from "../images";
import { inboundMessages, passages } from "../conversations/schema";
import { tagPassageText } from "../purchases/outgoing";
import { getPerson, markPersonBlocked } from "../people";
import type { Clock } from "../platform/clock";
import type { TokenCipher } from "../platform/crypto";
import type { Database, DatabaseExecutor } from "../platform/db";

/** Временный сбой: запись не `queued`, её не подхватят подметальщик и отправка исходящих — повторяет только сценарий. */
const AWAITS_FLOW_RETRY_ERROR = "Не ушло из-за временного сбоя мессенджера; повтор — по сценарию";
const NO_TARGET_ERROR = "Бот или получатель больше не существует";
/** Сколько отправка держит запись «отправляется»: дольше — обход упал, сообщение можно взять снова. */
export const SEND_CLAIM_MS = 2 * 60_000;
/** Как часто живая отправка продлевает захват: медленный мессенджер не отдаёт строку второму обходу. */
export const SEND_CLAIM_RENEW_MS = 30_000;
/** Касание ждало починки бота дольше окна (`BOT_REPAIR_RESEND_WINDOW_DAYS`, время базы): устарело, не отправляется. */
export const REPAIR_WINDOW_PASSED_ERROR = "Бот чинили дольше 3 суток: касание устарело и не отправлено";
/** Касание повторяется (починка бота, временный сбой, упавший обход), а человек тем временем написал сам: устарело, не отправляется. */
export const PERSON_WROTE_AFTER_TOUCH_ERROR = "Человек написал после касания: касание устарело и не отправлено";
/** Причина конца сценария, если его касание пришло к уже закрытому прохождению. */
export const PASSAGE_CLOSED_REASON = "passage_closed";

export interface FirstMessageDeliveryDependencies {
  db: Database;
  clock: Clock;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
  /** История разговора: ролик, уже показанный раньше, второй раз не уходит. */
  chatStorage: Pick<ChatStorage, "listMessages" | "listBranchSelections">;
  /** Без ограничителя отправка идёт без пауз (тесты). */
  rateLimiter?: RateLimiter;
  /** Не ушло совсем: проверить бота и сообщить эксперту (тревога). `bot` — сломан бот, сообщение дождётся починки. */
  onPermanentFailure(botId: string, error: string): Promise<SendFailureCause>;
  /** Закончить сценарий чата (`flow.end`): касание пришло к закрытому прохождению. */
  endFlow(input: FlowEndInput): Promise<unknown>;
  /** По умолчанию `SEND_CLAIM_RENEW_MS` (тесты — чаще). */
  claimRenewMs?: number;
  logError?: (message: string) => void;
}

/** Бот и адресат исходящего сообщения. `null` — бота, адаптера или человека больше нет. */
export async function sendTargetOf(
  deps: Pick<FirstMessageDeliveryDependencies, "adapters" | "cipher">,
  db: DatabaseExecutor,
  message: Pick<OutboundMessageRecord, "botId" | "personId">,
): Promise<SendTarget | null> {
  const found = await findBotWithCredentials(db, deps.cipher, message.botId);
  const adapter = found && deps.adapters[found.bot.channel];
  const person = await getPerson(db, message.personId);
  if (!found || !adapter || !person) return null;
  return { adapter, bot: found.credentials, to: person.externalUserId };
}

/**
 * Доставка сообщений, которые сценарий пишет первым (`attach({ deliver })`), через бот человека — сразу, мимо очереди
 * исходящих: исход нужен сценарию в ответ. Карточка ролика уходит следом за текстом, как у обычного ответа. Запись в
 * исходящих (`outreach`) — для «Входящих» и отчёта; тот же `messageId` — та же запись, доставленное второй раз не
 * уходит. Повторы делает сценарий, не очередь.
 * Порядок: запись «отправляется» (захват на `SEND_CLAIM_MS`, пока отправка жива — продлевается) → отправка без
 * транзакции → итог. Медленный мессенджер не держит ни строку, ни соединение пула; второй обход с тем же `messageId`,
 * пока идёт первый, получает «повторить». Итог пишется, только если захват всё ещё свой: зависший обход, у которого
 * строку забрали, не затирает нового владельца.
 * Сломан бот (токен отозван) — сценарию «ждать починки» (`await_repair`), запись `awaiting_repair`; очередь исходящих её
 * не берёт. Починку замечает `resumeOutreachAwaitingRepair` (`delivery-repair.ts`) и просит сценарий отправить тот же
 * `messageId`: отправляет его всегда один путь — эта доставка. Повтор продолжает с ушедших частей. Ждавшее дольше
 * окна починки (3 суток по времени базы) — «не доставлено» без отправки. Любой повтор того же `messageId` (после
 * починки, временного сбоя, упавшего обхода), после которого человек уже написал, — тоже «не доставлено».
 * Чат без прохождения (тестовый чат «Проверки») в настоящие боты не уходит. Прохождение уже закрыто, а сценарий жив
 * (сбой между записью конца и `flow.end`) — касание не уходит, сценарий заканчивается. Кроме прощания «срок вышел»:
 * его сценарий пишет после своего конца, когда прохождение уже «срок вышел».
 */
export function createFirstMessageDelivery(deps: FirstMessageDeliveryDependencies): (message: FlowOutgoing) => Promise<FlowDeliveryOutcome> {
  const { db, clock } = deps;
  return async (message) => {
    const [passage] = await db
      .select({ id: passages.id, personId: passages.personId, status: passages.status })
      .from(passages)
      .where(eq(passages.chatId, message.chatId));
    const person = passage?.personId === message.ownerId ? await getPerson(db, passage.personId) : null;
    if (!passage || !person) {
      deps.logError?.(`[сценарий] чат=${message.chatId}: не разговор с человеком в мессенджере, сообщение первым не отправлено`);
      return { status: "failed" };
    }
    // Прощание «срок вышел» сценарий шлёт уже после конца разговора: прохождение к этому времени закрыто его же событием
    const deadlineFarewell = passage.status === "term_ended" && message.reasons.some((reason) => reason.kind === "farewell");
    if (passage.status !== "active" && !deadlineFarewell) {
      deps.logError?.(`[сценарий] чат=${message.chatId}: прохождение уже закрыто (${passage.status}), касание не отправлено, сценарий заканчивается`);
      await deps.endFlow({ ownerId: message.ownerId, chatId: message.chatId, reason: PASSAGE_CLOSED_REASON, outcome: `прохождение уже закрыто: ${passage.status}` });
      return { status: "failed" };
    }

    const { video, image } = await mediaSentWith(deps.chatStorage, message.chatId, message.messageId, message.parts);
    const claimed = await claimOutreach(db, clock, {
      botId: person.botId,
      personId: person.id,
      kind: "outreach",
      passageId: passage.id,
      // Ссылки продукта — с личным кодом человека; в истории модели — как она их написала
      text: await tagPassageText(db, passage.id, message.text),
      video,
      imagePath: image && sentImagePath(image),
      idempotencyKey: `flow:${message.messageId}`,
    });
    if (claimed.kind === "settled") return claimed.outcome;
    const row = claimed.row;

    const claim = holdSendClaim(deps, row);
    let sending: { target: SendTarget; result: Awaited<ReturnType<typeof attemptSend>> } | null;
    try {
      const target = await sendTargetOf(deps, db, row);
      if (target) await deps.rateLimiter?.acquire(target.bot.id, target.adapter.ratePerSecond);
      sending = target && { target, result: await attemptSend(target, row) };
    } finally {
      await claim.release();
    }

    // Итог — только своей попытки: захват мог истечь и перейти к другому обходу
    const settle = (patch: Partial<typeof outboundMessages.$inferInsert>) =>
      db
        .update(outboundMessages)
        .set({ attempts: row.attempts + 1, ...patch })
        .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending"), eq(outboundMessages.nextAttemptAt, claim.heldUntil())));
    const fail = (status: "failed" | "blocked", error: string | null, sentParts = row.sentParts) => settle({ status, error, sentParts });

    if (!sending) {
      await fail("failed", NO_TARGET_ERROR);
      return { status: "failed" };
    }
    const { result } = sending;
    if (result.ok) {
      await settle({ status: "sent", error: null, externalMessageId: result.externalMessageId, sentAt: clock.now() });
      return { status: "delivered" };
    }
    switch (result.reason) {
      case "blocked":
        await fail("blocked", null);
        await markPersonBlocked(db, person.id, clock.now());
        return { status: "blocked" };
      case "reply_window_closed":
        // Мессенджер не даёт писать первым, пока человек не напишет сам (ВК, 950): бот исправен, тревоги нет
        await fail("failed", "Окно ответа закрыто: писать первым нельзя, пока человек не напишет сам");
        return { status: "window_closed" };
      case "rate_limited":
        await fail("failed", AWAITS_FLOW_RETRY_ERROR, result.sentParts);
        return { status: "retry", afterMs: result.retryAfterMs };
      case "temporary":
        await fail("failed", AWAITS_FLOW_RETRY_ERROR, result.sentParts);
        return { status: "retry" };
      case "empty":
        await fail("failed", "Пустое сообщение: отправлять нечего");
        return { status: "failed" };
      case "permanent": {
        await fail("failed", result.error, result.sentParts);
        // Тревога — после записи итога: её проверка бота идёт в мессенджер
        const cause = await deps.onPermanentFailure(row.botId, result.error);
        // Беда самого сообщения — повтор ничего не изменит
        if (cause !== "bot") return { status: "failed" };
        // Сломан бот: запись ждёт починки, если её за это время не взял другой обход
        await db
          .update(outboundMessages)
          .set({ status: "awaiting_repair" })
          .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "failed"), eq(outboundMessages.nextAttemptAt, claim.heldUntil())));
        return { status: "await_repair" };
      }
    }
  };
}

/**
 * Пока идёт отправка, захват строки продлевается на `SEND_CLAIM_MS` вперёд — условно по своему текущему сроку, он и есть
 * знак владельца. Строку забрал другой обход (срок уже не свой) — продление прекращается. `release` снимает таймер и
 * ждёт идущего продления: после него `heldUntil` — окончательный срок для записи итога.
 */
function holdSendClaim(deps: Pick<FirstMessageDeliveryDependencies, "db" | "clock" | "claimRenewMs" | "logError">, row: OutboundMessageRecord) {
  let heldUntil = row.nextAttemptAt;
  let renewing: Promise<void> | null = null;
  const renew = async () => {
    const [renewed] = await deps.db
      .update(outboundMessages)
      .set({ nextAttemptAt: new Date(deps.clock.now().getTime() + SEND_CLAIM_MS) })
      .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending"), eq(outboundMessages.nextAttemptAt, heldUntil)))
      .returning({ nextAttemptAt: outboundMessages.nextAttemptAt });
    if (renewed) heldUntil = renewed.nextAttemptAt;
    else clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = renew()
      .catch((error: unknown) => deps.logError?.(`[сценарий] исходящее ${row.id}: захват не продлён — ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => (renewing = null));
  }, deps.claimRenewMs ?? SEND_CLAIM_RENEW_MS);
  timer.unref?.();
  return {
    heldUntil: () => heldUntil,
    async release() {
      clearInterval(timer);
      await renewing;
    },
  };
}

type OutreachDraft = Pick<typeof outboundMessages.$inferInsert, "botId" | "personId" | "kind" | "passageId" | "text" | "video" | "imagePath" | "idempotencyKey">;

/**
 * Взять сообщение в отправку: новая запись, прошлая неудачная попытка (сценарий повторяет тот же `messageId`), ждавшая
 * починки бота, либо брошенная упавшим обходом, когда истёк её захват. Отправленное или заблокированное — сразу итог;
 * идущая сейчас отправка — «повторить»: к повтору сценария она закончится. Устаревшее за время ожидания (окно починки
 * по времени базы, человек написал после касания) — «не доставлено» той же записью, без отправки.
 */
async function claimOutreach(
  db: Database,
  clock: Clock,
  draft: OutreachDraft,
): Promise<{ kind: "send"; row: OutboundMessageRecord } | { kind: "settled"; outcome: FlowDeliveryOutcome }> {
  const now = clock.now();
  const claimUntil = new Date(now.getTime() + SEND_CLAIM_MS);
  const [created] = await db
    .insert(outboundMessages)
    .values({ ...draft, status: "sending", nextAttemptAt: claimUntil })
    .onConflictDoNothing({ target: outboundMessages.idempotencyKey })
    .returning();
  if (created) return { kind: "send", row: created };

  // Одной записью: устаревшее закрывается, остальное захватывается. После `term_ended` сообщения человека идут во
  // «Входящие», а не в историю сценария: его проверка «человек написал после» их не видит — смотрим сами. Проверка — у
  // каждого повтора, а не только у первого после починки: временный сбой или упавший обход возобновлённой отправки
  // меняют статус строки, а устаревшее касание остаётся устаревшим
  const staleReason = sql<string | null>`case
    when ${outboundMessages.createdAt} <= now() - make_interval(days => ${BOT_REPAIR_RESEND_WINDOW_DAYS}) then ${REPAIR_WINDOW_PASSED_ERROR}::text
    when exists (
      select 1 from ${inboundMessages}
      where ${inboundMessages.personId} = ${outboundMessages.personId} and ${inboundMessages.receivedAt} > ${outboundMessages.createdAt}
    ) then ${PERSON_WROTE_AFTER_TOUCH_ERROR}::text
  end`;
  const [reclaimed] = await db
    .update(outboundMessages)
    .set({
      status: sql`case when ${staleReason} is null then 'sending' else 'failed' end`,
      error: sql`coalesce(${staleReason}, ${outboundMessages.error})`,
      nextAttemptAt: sql`case when ${staleReason} is null then ${claimUntil.toISOString()}::timestamptz else ${outboundMessages.nextAttemptAt} end`,
    })
    .where(
      and(
        eq(outboundMessages.idempotencyKey, draft.idempotencyKey),
        or(
          inArray(outboundMessages.status, ["failed", "awaiting_repair"]),
          and(eq(outboundMessages.status, "sending"), lte(outboundMessages.nextAttemptAt, now)),
        ),
      ),
    )
    .returning();
  if (reclaimed?.status === "failed") return { kind: "settled", outcome: { status: "failed" } };
  if (reclaimed) return { kind: "send", row: reclaimed };

  const [existing] = await db.select({ status: outboundMessages.status }).from(outboundMessages).where(eq(outboundMessages.idempotencyKey, draft.idempotencyKey));
  if (!existing) throw new Error(`Исходящее ${draft.idempotencyKey} пропало сразу после записи`);
  if (existing.status === "sent") return { kind: "settled", outcome: { status: "delivered" } };
  if (existing.status === "blocked") return { kind: "settled", outcome: { status: "blocked" } };
  return { kind: "settled", outcome: { status: "retry" } };
}
