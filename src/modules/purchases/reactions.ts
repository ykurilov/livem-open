import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { outboundMessages, recordOutbound, scheduleOutboundSend } from "../channels";
import { inboundMessages, passages } from "../conversations/schema";
import { getVersion } from "../lead-magnets";
import { people } from "../people/schema";
import { addDays, atLocalTime, localDate } from "../program/calendar";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { sentImagePath, type ShownImage } from "../images";
import type { ShownVideoLink } from "../videos/shown-video";
import { productLinksOf, tagPassageText } from "./outgoing";
import { hasPaidOrder, markPurchased, ordersOfPassage, unmarkPurchased, type RecordedOrder } from "./orders";
import { formatMoney } from "./money";
import { orderKindOf } from "./getcourse";
import type { ProductLink } from "./product-links";
import { productOrders, type ProductOrder } from "./schema";

/** Напоминание об оплате — назавтра в это время по часам человека. */
export const PAYMENT_REMINDER_AT = "11:00";
/** Чат занят ходом — поздравление и напоминание повторяются через столько секунд. */
export const BUSY_RETRY_SECONDS = 60;
/**
 * Срок захвата напоминания: дольше пишущая задача не живёт (меньше срока задачи в очереди). Захват старше — процесс
 * упал посреди хода: напоминание возьмёт повтор задачи или подмётчик.
 */
export const REMINDER_CLAIM_MS = 10 * 60_000;
/** Реакция на заказ дольше этого не исполнена — уведомление упало после записи: её доводит подмётчик. */
export const REACTION_STALE_MS = 60_000;
/** Поздравление, которое модель пишет в ответе на `payment_check`, — запасная задача через столько секунд. */
export const CHECK_CONGRATULATION_DELAY_SECONDS = 60;
const RECOVERY_BATCH = 100;

/** Агент пишет первым по событию приложения: служебное сообщение в историю, ход, готовый проверенный ответ. */
export interface FirstMessageWriter {
  writeFirst(input: { ownerId: string; chatId: string; deliveryKey: string; title: string; timeZone?: string }): Promise<WriteFirstResult>;
}

/** `no_turn` — хода не было (лимит расходов, чат закрыт): уходит готовый текст. */
export type WriteFirstResult = { kind: "answer"; text: string; video: ShownVideoLink | null; image: ShownImage | null } | { kind: "busy" } | { kind: "no_turn" };

export interface PurchaseDependencies {
  db: Database;
  queue: JobEnqueuer;
  clock: Clock;
}

/**
 * После записи заказа: оплата у известного человека — покупка и поздравление; заказ без оплаты — одно напоминание
 * завтра; возврат — покупка снята. Реакция — только на заказ с меткой `reaction_pending_at` (новая оплата, возврат или
 * связь с человеком) и по его свежему состоянию под блокировкой прохождения и заказа: запоздалая реакция на «оплачен»
 * после обработанного возврата покупку не вернёт. Метка снимается по номеру перемены: пришло новое уведомление —
 * остаётся ему. Повтор уведомления после сбоя доводит реакцию, исполненная не повторяется.
 */
export async function reactToOrder(deps: PurchaseDependencies, recorded: Pick<RecordedOrder, "order">): Promise<void> {
  const { passageId } = recorded.order;
  if (!passageId) return;
  // Порядок блокировок — прохождение, потом заказ, как у сверки по почте
  const reaction = await deps.db.transaction(async (tx) => {
    await tx.select({ id: passages.id }).from(passages).where(eq(passages.id, passageId)).for("update");
    const [order] = await tx.select().from(productOrders).where(eq(productOrders.id, recorded.order.id)).for("update");
    if (!order?.reactionPendingAt) return null;
    // Возврат: покупка снята, Василий первым ничего не пишет; отменён до оплаты — напоминать не о чем
    const kind = order.refundedAt ? "refund" : order.paidAt ? "purchase" : orderKindOf(order.status) === "refunded" ? "none" : "reminder";
    if (kind === "refund") await unmarkPurchased(tx, passageId);
    if (kind === "purchase") await markPurchased(tx, passageId, deps.clock.now());
    return { kind, revision: order.reactionRevision };
  });
  if (!reaction) return;
  // Поздравление пишет задача `purchase-congratulate` (модель — в работнике, не в вебхуке); возврат после постановки
  // задачи снимет покупку — задача ничего не напишет
  if (reaction.kind === "purchase") await deps.queue.enqueue("purchase-congratulate", { passageId }, { singletonKey: `purchase-congratulate:${passageId}` });
  if (reaction.kind === "reminder") await schedulePaymentReminder(deps, passageId);
  await settleOrderReactions(deps.db, [{ id: recorded.order.id, reactionRevision: reaction.revision }]);
}

/** Реакция на заказы исполнена: метка снимается, только если за это время не пришло новой перемены (номер тот же). */
export async function settleOrderReactions(db: DatabaseExecutor, orders: readonly Pick<ProductOrder, "id" | "reactionRevision">[]): Promise<void> {
  for (const order of orders) {
    await db
      .update(productOrders)
      .set({ reactionPendingAt: null })
      .where(and(eq(productOrders.id, order.id), eq(productOrders.reactionRevision, order.reactionRevision)));
  }
}

/**
 * Подмётчик покупок (`stuck-sweep`): реакции на заказы, не исполненные после записи (процесс упал между записью и
 * постановкой задачи), и напоминания, чей захват истёк без отправки (процесс упал посреди хода). Ставит только
 * существующие задачи, повтор безвреден. Возвращает, сколько восстановлено.
 */
export async function recoverPurchaseReactions(deps: PurchaseDependencies): Promise<number> {
  const now = deps.clock.now().getTime();
  const pending = await deps.db
    .select()
    .from(productOrders)
    .where(and(isNotNull(productOrders.passageId), lt(productOrders.reactionPendingAt, new Date(now - REACTION_STALE_MS))))
    .limit(RECOVERY_BATCH);
  let recovered = 0;
  for (const order of pending) {
    try {
      await reactToOrder(deps, { order });
      recovered++;
    } catch (error) {
      console.error(`Реакция на заказ ${order.id} не восстановлена:`, error instanceof Error ? error.message : error);
    }
  }
  const stale = await deps.db
    .select({ id: passages.id })
    .from(passages)
    .where(and(lt(passages.paymentReminderClaimedAt, new Date(now - REMINDER_CLAIM_MS)), isNull(passages.paymentReminderSentAt)))
    .limit(RECOVERY_BATCH);
  for (const { id } of stale) await deps.queue.enqueue("payment-reminder", { passageId: id });
  return recovered + stale.length;
}

/** Одно напоминание об оплате назавтра в 11:00 по поясу человека. Повторный вызов безвреден: отправит одно. */
export async function schedulePaymentReminder(deps: PurchaseDependencies, passageId: string): Promise<void> {
  const [row] = await deps.db
    .select({ timeZone: people.timeZone, sentAt: passages.paymentReminderSentAt, purchasedAt: passages.purchasedAt })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .where(eq(passages.id, passageId));
  if (!row || row.sentAt || row.purchasedAt) return;
  const now = deps.clock.now();
  const at = atLocalTime(addDays(localDate(now, row.timeZone), 1), PAYMENT_REMINDER_AT, row.timeZone);
  const delaySeconds = Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
  await deps.queue.enqueue("payment-reminder", { passageId }, { delaySeconds, singletonKey: `payment-reminder:${passageId}` });
}

/** Продукт заказа: по метке кампании, иначе первый из настроек снимка. */
function productOf(products: readonly ProductLink[], order: ProductOrder | null): ProductLink | null {
  return products.find((product) => order?.utmCampaign === product.campaign) ?? products[0] ?? null;
}

/** Служебное сообщение модели об оплате: что случилось и что сделать. Видит только модель. */
export function congratulationNotice(product: ProductLink | null, order: ProductOrder | null): string {
  const what = product ? `курса «${product.title}»` : "продукта";
  // Нулевая или неизвестная сумма в поздравление не идёт: «0 ₽» звучит странно
  const amount = order?.amount === null || order?.amount === undefined ? 0 : Number(order.amount);
  const details = [order?.offerTitle, amount > 0 ? formatMoney(amount, order!.currency) : null].filter(Boolean).join(", ");
  const tariff = details ? ` (${details})` : "";
  return (
    `Пришла оплата ${what}${tariff}: человек купил. Напиши ему первым одно короткое тёплое поздравление с покупкой. ` +
    "Не продавай и не напоминай об оплате — ни сейчас, ни потом. Если он сейчас делает своё приложение, предложи продолжить."
  );
}

/** Служебное сообщение модели для напоминания об оплате. */
export function reminderNotice(product: ProductLink | null): string {
  const what = product ? `курс «${product.title}»` : "продукт";
  const link = product ? ` Ссылка: ${product.url}` : "";
  return (
    `Вчера человек собирался оплатить ${what}, оплаты пока нет. Напиши ему первым одно доброе короткое напоминание со ссылкой — в этом сообщении можно ссылку на оплату, — без давления и без цены: ` +
    `вдруг что-то помешало — подскажешь.${link} Больше об оплате сам не напоминай.`
  );
}

/** Готовые тексты, если хода модели не было (лимит, чат закрыт). */
export const congratulationFallback = (product: ProductLink | null) =>
  `Вижу оплату${product ? ` курса «${product.title}»` : ""} — поздравляю! Отличный шаг. Если понадобится помощь с приложением, пишите.`;
export const reminderFallback = (product: ProductLink | null) =>
  `Напоминаю про ${product ? `курс «${product.title}»` : "оплату"}${product ? `: ${product.url}` : ""}. Если что-то помешало оплатить, напишите — подскажу.`;

interface PassageForMessage {
  passageId: string;
  personId: string;
  botId: string;
  chatId: string;
  timeZone: string | null;
  blocked: boolean;
  products: ProductLink[];
}

async function passageForMessage(db: Database, passageId: string): Promise<PassageForMessage | null> {
  const [row] = await db
    .select({ personId: passages.personId, chatId: passages.chatId, snapshotId: passages.snapshotId, botId: people.botId, timeZone: people.timeZone, blockedAt: people.blockedAt })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .where(eq(passages.id, passageId));
  if (!row) return null;
  const snapshot = await getVersion(db, row.snapshotId);
  return {
    passageId,
    personId: row.personId,
    botId: row.botId,
    chatId: row.chatId,
    timeZone: row.timeZone,
    blocked: row.blockedAt !== null,
    products: snapshot ? productLinksOf(snapshot.settings) : [],
  };
}

/**
 * Задача `purchase-congratulate`: Василий пишет первым — поздравляет с покупкой. Один раз: ключ служебного сообщения и
 * ключ исходящего те же при повторе, отметка — в транзакции записи исходящего. Чат занят ходом — повтор через минуту. Запасная
 * задача после `payment_check` ничего не пишет, если ответ хода с поздравлением уже ушёл (отметка поставлена).
 */
export async function congratulatePurchase(deps: PurchaseDependencies & { writer: FirstMessageWriter }, passageId: string): Promise<void> {
  const target = await passageForMessage(deps.db, passageId);
  const congratulated = await congratulationWitnessed(deps.db, deps.clock, passageId);
  const [state] = await deps.db.select({ purchasedAt: passages.purchasedAt }).from(passages).where(eq(passages.id, passageId));
  if (!target || !state?.purchasedAt || congratulated || target.blocked) return;
  const { paid } = await ordersOfPassage(deps.db, passageId);
  const product = productOf(target.products, paid);
  const written = await deps.writer.writeFirst({
    ownerId: target.personId,
    chatId: target.chatId,
    deliveryKey: `purchase:${passageId}`,
    title: congratulationNotice(product, paid),
    ...(target.timeZone && { timeZone: target.timeZone }),
  });
  if (written.kind === "busy") {
    await deps.queue.enqueue("purchase-congratulate", { passageId }, { delaySeconds: BUSY_RETRY_SECONDS });
    return;
  }
  const answer = written.kind === "answer" && (written.text.trim() || written.video || written.image) ? written : { text: congratulationFallback(product), video: null, image: null };
  const text = await tagPassageText(deps.db, passageId, answer.text);
  // Проверка и запись — одна транзакция под замком прохождения, как у реакции на заказ: пока писал, поздравил ответ
  // хода на `payment_check` или обработан возврат — не пишем; записали — отметка там же
  const recorded = await deps.db.transaction(async (tx) => {
    await tx.select({ id: passages.id }).from(passages).where(eq(passages.id, passageId)).for("update");
    if ((await congratulationWitnessed(tx, deps.clock, passageId)) || !(await stillPurchased(tx, passageId))) return null;
    const message = await recordOutbound(tx, deps.clock, {
      botId: target.botId,
      personId: target.personId,
      kind: "outreach",
      passageId,
      text,
      ...(answer.video && { video: answer.video }),
      ...(answer.image && { imagePath: sentImagePath(answer.image) }),
      idempotencyKey: `purchase-congratulate:${passageId}`,
    });
    await tx
      .update(passages)
      .set({ purchaseCongratulatedAt: deps.clock.now(), purchaseCongratulationTurnId: null })
      .where(and(eq(passages.id, passageId), isNull(passages.purchaseCongratulatedAt)));
    return message;
  });
  // Задача отправки — после фиксации; не поставилась — запись подберёт подмётчик исходящих (`requeueStuckOutbound`)
  if (recorded?.created) await scheduleOutboundSend(deps.queue, recorded.id);
}

/** Покупка в силе: отметка стоит и оплаченный заказ без возврата есть. */
async function stillPurchased(db: DatabaseExecutor, passageId: string): Promise<boolean> {
  const [state] = await db.select({ purchasedAt: passages.purchasedAt }).from(passages).where(eq(passages.id, passageId));
  return Boolean(state?.purchasedAt) && (await hasPaidOrder(db, passageId));
}

/**
 * Поздравлен ли человек: отметка стоит или ответ хода с найденной оплатой уже записан в исходящие (`turn:<id>`), а
 * до отметки ход не дошёл (упал между ними) — тогда отметка ставится здесь.
 */
async function congratulationWitnessed(db: DatabaseExecutor, clock: Clock, passageId: string): Promise<boolean> {
  const [state] = await db
    .select({ congratulatedAt: passages.purchaseCongratulatedAt, turnId: passages.purchaseCongratulationTurnId })
    .from(passages)
    .where(eq(passages.id, passageId));
  if (!state) return false;
  if (state.congratulatedAt) return true;
  if (!state.turnId || !(await outboundExists(db, `turn:${state.turnId}`))) return false;
  await db
    .update(passages)
    .set({ purchaseCongratulatedAt: clock.now(), purchaseCongratulationTurnId: null })
    .where(and(eq(passages.id, passageId), isNull(passages.purchaseCongratulatedAt), eq(passages.purchaseCongratulationTurnId, state.turnId)));
  return true;
}

/**
 * `payment_check` нашёл оплату: поздравление модель пишет в ответе этого хода (ход — по сообщениям, которые он сейчас
 * отвечает). Запасная задача — до метки: ход не дойдёт до ответа (сбой модели, падение) — поздравит она; ответ хода
 * записан — отметка «поздравлен», задача ничего не пишет.
 */
export async function congratulationInAnswer(deps: PurchaseDependencies, passageId: string): Promise<void> {
  const [current] = await deps.db
    .select({ turnId: inboundMessages.turnId })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.passageId, passageId), isNotNull(inboundMessages.turnId), isNull(inboundMessages.answeredAt)))
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(1);
  await deps.queue.enqueue("purchase-congratulate", { passageId }, { delaySeconds: CHECK_CONGRATULATION_DELAY_SECONDS });
  await deps.db
    .update(passages)
    .set({ purchaseCongratulationTurnId: current?.turnId ?? null })
    .where(and(eq(passages.id, passageId), isNull(passages.purchaseCongratulatedAt)));
}

/**
 * Задача `payment-reminder`: одно доброе напоминание об оплате, если человек обещал или оформил заказ, а оплаты нет.
 * Не идёт оплатившему, твёрдо отказавшемуся, попросившему прекратить и заблокировавшему бота; второе не идёт никогда.
 * Пока пишется — захват (`payment_reminder_claimed_at`) держит вторую задачу; процесс упал — захват истекает, и
 * напоминание берёт повтор. Отметка «ушло» — в транзакции записи исходящего; исходящее уже есть — только отметка.
 */
export async function remindPayment(deps: PurchaseDependencies & { writer: FirstMessageWriter }, passageId: string): Promise<void> {
  const target = await passageForMessage(deps.db, passageId);
  const [state] = await deps.db
    .select({ promisedAt: passages.paymentPromisedAt, purchasedAt: passages.purchasedAt, sentAt: passages.paymentReminderSentAt, saleAnswer: passages.saleAnswer, summary: passages.summary })
    .from(passages)
    .where(eq(passages.id, passageId));
  if (!state || state.sentAt) return;
  const now = deps.clock.now();
  const staleClaim = lt(passages.paymentReminderClaimedAt, new Date(now.getTime() - REMINDER_CLAIM_MS));
  const { paid, unpaid } = await ordersOfPassage(deps.db, passageId);
  if (!target || state.purchasedAt || state.saleAnswer?.firm || state.summary?.outcome === "declined" || target.blocked || paid || (!state.promisedAt && !unpaid)) {
    // Напоминать не о чем: истёкший захват снят, иначе подмётчик будил бы задачу снова
    await deps.db.update(passages).set({ paymentReminderClaimedAt: null }).where(and(eq(passages.id, passageId), staleClaim));
    return;
  }
  const key = `payment-reminder:${passageId}`;
  const markSent = () =>
    deps.db.update(passages).set({ paymentReminderSentAt: deps.clock.now(), paymentReminderClaimedAt: null }).where(and(eq(passages.id, passageId), isNull(passages.paymentReminderSentAt)));
  if (await outboundExists(deps.db, key)) return void (await markSent());

  const claimed = await deps.db
    .update(passages)
    .set({ paymentReminderClaimedAt: now })
    .where(and(eq(passages.id, passageId), isNull(passages.paymentReminderSentAt), isNull(passages.purchasedAt), or(isNull(passages.paymentReminderClaimedAt), staleClaim)))
    .returning({ id: passages.id });
  // Пишет другая задача: допишет она, а упадёт — захват истечёт
  if (claimed.length === 0) return;

  // Не ушло (занято, сбой) — захват снимается, повтор задачи возьмёт его снова
  const release = () =>
    deps.db.update(passages).set({ paymentReminderClaimedAt: null }).where(and(eq(passages.id, passageId), eq(passages.paymentReminderClaimedAt, now)));
  let recorded: { id: string; created: boolean } | null;
  try {
    const product = productOf(target.products, unpaid);
    const written = await deps.writer.writeFirst({
      ownerId: target.personId,
      chatId: target.chatId,
      deliveryKey: key,
      title: reminderNotice(product),
      ...(target.timeZone && { timeZone: target.timeZone }),
    });
    if (written.kind === "busy") {
      await release();
      await deps.queue.enqueue("payment-reminder", { passageId }, { delaySeconds: BUSY_RETRY_SECONDS });
      return;
    }
    const answer = written.kind === "answer" && (written.text.trim() || written.video || written.image) ? written : { text: reminderFallback(product), video: null, image: null };
    const text = await tagPassageText(deps.db, passageId, answer.text);
    // Проверка и запись — одна транзакция под замком прохождения, как у реакции на заказ: пока писал, пришла и
    // обработана оплата — не напоминаем; записали — отметка «ушло» там же
    recorded = await deps.db.transaction(async (tx) => {
      const [fresh] = await tx
        .select({ purchasedAt: passages.purchasedAt, sentAt: passages.paymentReminderSentAt })
        .from(passages)
        .where(eq(passages.id, passageId))
        .for("update");
      if (!fresh || fresh.sentAt || fresh.purchasedAt || (await hasPaidOrder(tx, passageId))) return null;
      const message = await recordOutbound(tx, deps.clock, {
        botId: target.botId,
        personId: target.personId,
        kind: "outreach",
        passageId,
        text,
        ...(answer.video && { video: answer.video }),
        ...(answer.image && { imagePath: sentImagePath(answer.image) }),
        idempotencyKey: key,
      });
      await tx.update(passages).set({ paymentReminderSentAt: deps.clock.now(), paymentReminderClaimedAt: null }).where(eq(passages.id, passageId));
      return message;
    });
    if (!recorded) await release();
  } catch (error) {
    await release();
    throw error;
  }
  // Задача отправки — после фиксации; не поставилась — запись подберёт подмётчик исходящих (`requeueStuckOutbound`)
  if (recorded?.created) await scheduleOutboundSend(deps.queue, recorded.id);
}

/** Исходящее с этим ключом уже в очереди: сообщение ушло (или уйдёт), второе не пишем. */
export async function outboundExists(db: DatabaseExecutor, idempotencyKey: string): Promise<boolean> {
  const [row] = await db.select({ id: outboundMessages.id }).from(outboundMessages).where(eq(outboundMessages.idempotencyKey, idempotencyKey));
  return Boolean(row);
}
