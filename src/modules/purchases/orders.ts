import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { passages } from "../conversations/schema";
import { getVersion } from "../lead-magnets";
import { leadMagnetVersions } from "../lead-magnets/schema";
import { people } from "../people/schema";
import type { Clock } from "../platform/clock";
import type { Database, DatabaseExecutor } from "../platform/db";
import { orderKindOf, type OrderNotice } from "./getcourse";
import { productLinksOf } from "./outgoing";
import { PREVIEW_MEDIUM } from "./preview-code";
import { productOrders, type OrderMatch, type ProductOrder } from "./schema";

/** Что нужно приёму заказа: запись и часы. Реакции (поздравление, напоминание) ставит вызывающий по итогу. */
export interface OrderDependencies {
  db: Database;
  clock: Clock;
}

export interface RecordedOrder {
  order: ProductOrder;
  /** Оплата пришла этим уведомлением: раньше заказ оплаченным не был, возврата у него нет. */
  newlyPaid: boolean;
  /** Возврат или отмена пришли этим уведомлением. */
  newlyRefunded: boolean;
  /** Заказ связан с прохождением этим уведомлением (или раньше, но ещё без реакции — тогда `false`). */
  newlyMatched: boolean;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
/** Почта в тексте факта целиком: перед ней и после неё нет знаков адреса — «an@mail.ru» не найдётся в «ivan@mail.ru». */
const FACT_EMAIL = "(?:^|[^a-zа-яё0-9._%+-])([a-zа-яё0-9._%+-]+@[a-zа-яё0-9-]+(?:\\.[a-zа-яё0-9-]+)*\\.[a-zа-яё]{2,})";

/** Почта из текста строчными; нет — `null`. */
export function emailIn(text: string): string | null {
  return text.match(EMAIL)?.[0].toLowerCase() ?? null;
}

/**
 * Прохождение заказа: по личному коду из ссылки (`utm_content`), иначе по почте — сначала названной Василию
 * (`payment_email`), потом записанной в «Базе» (поле или факт). Из нескольких — последнее начатое. Тестовая оплата
 * «Проверки» не связывается ни с кем.
 */
async function passageFor(db: DatabaseExecutor, notice: OrderNotice): Promise<{ passageId: string; matchedBy: OrderMatch } | null> {
  if (notice.utm.medium === PREVIEW_MEDIUM) return null;
  if (notice.utm.content) {
    const [byCode] = await db.select({ id: passages.id }).from(passages).where(eq(passages.trackingCode, notice.utm.content));
    if (byCode) return { passageId: byCode.id, matchedBy: "code" };
  }
  if (!notice.email) return null;
  const passageId = await passageByEmail(db, notice.email, notice.utm.campaign);
  return passageId ? { passageId, matchedBy: "email" } : null;
}

/**
 * Прохождение продаёт продукт заказа: в ссылках продуктов его снимка есть кампания заказа. Заказ без кампании (фильтр
 * процесса школы — только наш курс) подходит любому прохождению со ссылками продуктов.
 */
const sellsCampaign = (campaign: string | null) => sql`exists (
  select 1 from ${leadMagnetVersions},
    jsonb_array_elements(case when jsonb_typeof(${leadMagnetVersions.settings}->'productLinks') = 'array'
      then ${leadMagnetVersions.settings}->'productLinks' else '[]'::jsonb end) as link
  where ${leadMagnetVersions.id} = ${passages.snapshotId} and (${campaign}::text is null or link->>'campaign' = ${campaign}))`;

async function passageByEmail(db: DatabaseExecutor, email: string, campaign: string | null): Promise<string | null> {
  const [named] = await db
    .select({ id: passages.id })
    .from(passages)
    .where(and(eq(passages.paymentEmail, email), sellsCampaign(campaign)))
    .orderBy(desc(passages.startedAt))
    .limit(1);
  if (named) return named.id;
  const [known] = await db
    .select({ id: passages.id })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .where(
      and(
        sql`(exists (select 1 from jsonb_each_text(${people.fieldValues}) as field where lower(trim(field.value)) = ${email})
          or exists (
            select 1 from jsonb_array_elements(${people.facts}) as fact,
              regexp_matches(lower(fact->>'text'), ${FACT_EMAIL}, 'g') as found
            where found[1] = ${email}))`,
        sellsCampaign(campaign),
      ),
    )
    .orderBy(desc(passages.startedAt))
    .limit(1);
  return known?.id ?? null;
}

/**
 * Уведомление вместе с записанным раньше по этому заказу: частичное событие (без меток или почты) сопоставляется по
 * сохранённым полям, а заказ «Проверки» остаётся тестовым, что бы ни пришло следом.
 */
function withStored(notice: OrderNotice, stored: ProductOrder): OrderNotice {
  const pick = (fresh: string | null, kept: string | null) => fresh || kept;
  return {
    ...notice,
    email: pick(notice.email, stored.email),
    utm: {
      source: pick(notice.utm.source, stored.utmSource),
      medium: stored.utmMedium === PREVIEW_MEDIUM ? PREVIEW_MEDIUM : pick(notice.utm.medium, stored.utmMedium),
      campaign: pick(notice.utm.campaign, stored.utmCampaign),
      content: pick(notice.utm.content, stored.utmContent),
      term: pick(notice.utm.term, stored.utmTerm),
    },
  };
}

/**
 * Записать уведомление о заказе. Один заказ — одна строка: повтор и смена статуса обновляют её, оплата отмечается один
 * раз (`paid_at`), связь с прохождением не перезаписывается. Неизвестный заказ лежит без прохождения. Возврат —
 * конечный: пришедшая после него оплата записывается для сверки, но покупкой не считается. Перемена, на которую нужна
 * реакция, оставляет метку `reaction_pending_at` в той же транзакции: реакцию доведёт повтор уведомления или подмётчик.
 */
export async function recordOrderNotice(deps: OrderDependencies, source: ProductOrder["source"], notice: OrderNotice, raw: Record<string, unknown>): Promise<RecordedOrder> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const fields = {
      orderNumber: notice.orderNumber,
      status: notice.status,
      amount: notice.amount === null ? null : notice.amount.toFixed(2),
      currency: notice.currency,
      email: notice.email,
      externalUserId: notice.externalUserId,
      offerTitle: notice.offerTitle,
      utmSource: notice.utm.source,
      utmMedium: notice.utm.medium,
      utmCampaign: notice.utm.campaign,
      utmContent: notice.utm.content,
      utmTerm: notice.utm.term,
      raw,
    };
    await tx
      .insert(productOrders)
      .values({ source, externalOrderId: notice.externalOrderId, ...fields })
      .onConflictDoNothing({ target: [productOrders.source, productOrders.externalOrderId] });
    const [before] = await tx
      .select()
      .from(productOrders)
      .where(and(eq(productOrders.source, source), eq(productOrders.externalOrderId, notice.externalOrderId)))
      .for("update");
    if (!before) throw new Error(`Заказ ${notice.externalOrderId} пропал сразу после записи`);

    const match = before.passageId ? null : await passageFor(tx, withStored(notice, before));
    // Пустые поля нового уведомления прежних значений не стирают: процесс «оплачен» может прислать меньше,
    // опоздавшее «создан» не откатывает статус оплаченного заказа, а после возврата статус меняет только возврат.
    // Заказ «Проверки» тестовым и остаётся
    const statusKept = (before.refundedAt === null || notice.kind === "refunded") && !(before.paidAt && notice.kind === "open");
    const mediumKept = before.utmMedium !== PREVIEW_MEDIUM;
    const kept = Object.fromEntries(
      Object.entries(fields).filter(([key, value]) => value !== null && value !== "" && (key !== "status" || statusKept) && (key !== "utmMedium" || mediumKept)),
    );
    const newlyRefunded = notice.kind === "refunded" && !before.refundedAt;
    const newlyPaid = notice.kind === "paid" && !before.paidAt && !before.refundedAt;
    const newlyMatched = match !== null;
    const reacting = (before.passageId !== null || newlyMatched) && (newlyPaid || newlyRefunded || newlyMatched);
    const [order] = await tx
      .update(productOrders)
      .set({
        ...kept,
        ...(match && { passageId: match.passageId, matchedBy: match.matchedBy }),
        ...(notice.kind === "paid" && !before.paidAt && { paidAt: now }),
        ...(newlyRefunded && { refundedAt: now }),
        ...(reacting && { reactionPendingAt: before.reactionPendingAt ?? now, reactionRevision: before.reactionRevision + 1 }),
        updatedAt: now,
      })
      .where(eq(productOrders.id, before.id))
      .returning();
    return { order: order!, newlyPaid, newlyRefunded, newlyMatched };
  });
}

/** Заказы прохождения: оплаченный без возврата и последний неоплаченный (отменённый или возвращённый — не в счёт). */
export async function ordersOfPassage(db: DatabaseExecutor, passageId: string): Promise<{ paid: ProductOrder | null; unpaid: ProductOrder | null }> {
  const rows = await db.select().from(productOrders).where(eq(productOrders.passageId, passageId)).orderBy(desc(productOrders.createdAt));
  const cancelled = (row: ProductOrder) => orderKindOf(row.status) === "refunded";
  return {
    paid: rows.find((row) => row.paidAt && !row.refundedAt) ?? null,
    unpaid: rows.find((row) => !row.paidAt && !row.refundedAt && !cancelled(row)) ?? null,
  };
}

/**
 * Сверка по почте, которую назвал человек: заказы с ней без прохождения переходят к этому прохождению — только
 * продукты этого прохождения (или заказ без кампании) и не тестовые оплаты «Проверки». Почта запоминается — заказ,
 * который придёт позже, найдёт человека по ней. Привязка, как и уведомление, оставляет метку реакции: сверка исполнит
 * её сама, а упадёт до этого — доведёт повтор сверки или подмётчик.
 */
export async function linkOrdersByEmail(db: Database, input: { passageId: string; email: string; at: Date }): Promise<ProductOrder[]> {
  return db.transaction(async (tx) => {
    const [passage] = await tx.update(passages).set({ paymentEmail: input.email }).where(eq(passages.id, input.passageId)).returning({ snapshotId: passages.snapshotId });
    const snapshot = passage && (await getVersion(tx, passage.snapshotId));
    const campaigns = snapshot ? productLinksOf(snapshot.settings).map((product) => product.campaign) : [];
    // Только ничьи заказы: привязанный к кому-то (по метке или почте) не перепривязывается никогда
    return tx
      .update(productOrders)
      .set({
        passageId: input.passageId,
        matchedBy: "email",
        reactionPendingAt: sql`coalesce(${productOrders.reactionPendingAt}, ${input.at})`,
        reactionRevision: sql`${productOrders.reactionRevision} + 1`,
      })
      .where(
        and(
          eq(productOrders.email, input.email),
          isNull(productOrders.passageId),
          sql`${productOrders.utmMedium} is distinct from ${PREVIEW_MEDIUM}`,
          or(isNull(productOrders.utmCampaign), ...(campaigns.length ? [inArray(productOrders.utmCampaign, campaigns)] : [])),
        ),
      )
      .returning();
  });
}

/**
 * Ответ хода записан в исходящие: если в этом ходе `payment_check` нашёл оплату, поздравление было в ответе — второе
 * задача `purchase-congratulate` не напишет. Зовётся в транзакции пометки «отвечено»; упали до неё — ту же отметку
 * поставит задача, найдя исходящее хода (`congratulationWitnessed`).
 */
export async function noteCongratulationDelivered(db: DatabaseExecutor, input: { passageId: string; turnId: string; at: Date }): Promise<void> {
  await db
    .update(passages)
    .set({ purchaseCongratulatedAt: input.at, purchaseCongratulationTurnId: null })
    .where(and(eq(passages.id, input.passageId), isNull(passages.purchaseCongratulatedAt), eq(passages.purchaseCongratulationTurnId, input.turnId)));
}

/** Отметить покупку у прохождения: один раз; итог, если записан, — «согласился» (купил). Возвращает, впервые ли. */
export async function markPurchased(db: DatabaseExecutor, passageId: string, at: Date): Promise<boolean> {
  const marked = await db
    .update(passages)
    .set({
      purchasedAt: at,
      summary: sql`case when ${passages.summary} is null then null else jsonb_set(${passages.summary}, '{outcome}', '"agreed"') end`,
    })
    .where(and(eq(passages.id, passageId), isNull(passages.purchasedAt)))
    .returning({ id: passages.id });
  return marked.length > 0;
}

/** Возврат: покупка снята, если других оплаченных заказов без возврата нет. Поздравление уже было — оно не повторится. */
export async function unmarkPurchased(db: DatabaseExecutor, passageId: string): Promise<void> {
  if (await hasPaidOrder(db, passageId)) return;
  await db.update(passages).set({ purchasedAt: null }).where(eq(passages.id, passageId));
}

/** Есть ли у прохождения оплаченный заказ без возврата. */
export async function hasPaidOrder(db: DatabaseExecutor, passageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: productOrders.id })
    .from(productOrders)
    .where(and(eq(productOrders.passageId, passageId), isNotNull(productOrders.paidAt), isNull(productOrders.refundedAt)))
    .limit(1);
  return Boolean(row);
}
