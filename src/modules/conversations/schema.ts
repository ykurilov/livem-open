import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AttachmentKind, ContactSource } from "../channels/channel";
import { bots } from "../channels/schema";
import type { DialogSummary, PassageSideTasks, SaleAnswer, StageHistoryEntry } from "../consultant/schema";
import { entryLinks, leadMagnets, leadMagnetVersions } from "../lead-magnets/schema";
import { people } from "../people/schema";
import { appSchema } from "../platform/app-schema";

/** `term_ended` — срок программы вышел без «да» и без «прекратите». */
export const PASSAGE_STATUSES = ["active", "completed", "not_completed", "blocked", "term_ended"] as const;
export type PassageStatus = (typeof PASSAGE_STATUSES)[number];

/** Прохождение лидмагнита человеком. Идёт на своём снимке до конца, даже если лидмагнит опубликовали заново. */
export const passages = appSchema.table(
  "passages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => leadMagnetVersions.id),
    entryLinkId: uuid("entry_link_id").references(() => entryLinks.id),
    /** Чат SDK; его владелец — человек (`people.id`). */
    chatId: text("chat_id").notNull(),
    status: text("status").$type<PassageStatus>().notNull().default("active"),
    currentStageId: text("current_stage_id"),
    stageHistory: jsonb("stage_history").$type<StageHistoryEntry[]>().notNull().default([]),
    personMessageCount: integer("person_message_count").notNull().default(0),
    summary: jsonb("summary").$type<DialogSummary>(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    lastPersonMessageAt: timestamp("last_person_message_at", { withTimezone: true }),
    reminderStep: integer("reminder_step").notNull().default(0),
    /** С какого момента человек молчит: от него считаются «через 15 минут», «через час» и конец третьего дня. Новый ответ консультанта начинает цепочку заново. */
    reminderChainStartedAt: timestamp("reminder_chain_started_at", { withTimezone: true }),
    nextReminderAt: timestamp("next_reminder_at", { withTimezone: true }),
    budgetPausedAt: timestamp("budget_paused_at", { withTimezone: true }),
    /** Не используется с SDK 0.58: два хода на одну пачку не начнёт сам SDK. Столбец остался, чтобы не менять схему. */
    turnLeaseUntil: timestamp("turn_lease_until", { withTimezone: true }),
    /** Сколько раз подряд ход упал на сбое модели: от этого зависит пауза до следующей попытки. Удачный ход обнуляет. */
    turnFailures: integer("turn_failures").notNull().default(0),
    /** Дневной лимит человека исчерпан: ход ждёт утра. Поднимут лимит — ход ставится сразу. */
    dailyLimitPausedAt: timestamp("daily_limit_paused_at", { withTimezone: true }),
    /**
     * Консультант не смог ответить (не сбой провайдера или сбои дольше потолка): сообщения ушли во «Входящие».
     * «Входящие» показывают причину, пока эксперт не ответил.
     */
    handedToExpertAt: timestamp("handed_to_expert_at", { withTimezone: true }),
    handoverReason: text("handover_reason"),
    /** Дата дня 1 программы по поясу человека на момент старта; при смене пояса не меняется. Без программы пусто. */
    programStartDate: date("program_start_date", { mode: "string" }),
    /** Сообщений человека в день программы `dayMessageCountDay`: рамки дня. Сбрасывается при смене номера дня. */
    dayMessageCount: integer("day_message_count").notNull().default(0),
    dayMessageCountDay: integer("day_message_count_day").notNull().default(0),
    /** В этот день программы заготовка «Утром отвечу!» уже ушла. */
    dayClosedNoticeDay: integer("day_closed_notice_day"),
    /** Этот день программы человек закрыл сам («до завтра»), консультант отметил его `end_day`: первым в этот день не пишем. */
    personClosedDay: integer("person_closed_day"),
    /** День программы, когда сообщение первым на этапе «Продажа» предложило продукт, а человек с тех пор не писал. */
    saleOfferOutreachDay: integer("sale_offer_outreach_day"),
    /** Сообщений первым в день программы `outreachDay`: потолок дня. */
    outreachSentCount: integer("outreach_sent_count").notNull().default(0),
    outreachDay: integer("outreach_day").notNull().default(0),
    /** Самый дальний день, до которого дошёл человек: отчёт «дошли до дня N». */
    furthestDay: integer("furthest_day").notNull().default(1),
    saleAnswer: jsonb("sale_answer").$type<SaleAnswer>(),
    sideTasks: jsonb("side_tasks").$type<PassageSideTasks>().notNull().default({}),
    /** Личный код человека в ссылках продукта (`utm_content`): по нему уведомление об оплате находит прохождение. */
    trackingCode: text("tracking_code"),
    /** Почта, с которой человек, по его словам, платил (`payment_check`): по ней найдётся заказ без кода. */
    paymentEmail: text("payment_email"),
    /** Человек пообещал оплатить продукт (`payment_promised`): завтра одно напоминание, если оплаты не будет. */
    paymentPromisedAt: timestamp("payment_promised_at", { withTimezone: true }),
    /** Напоминание об оплате ушло: второго не будет. */
    paymentReminderSentAt: timestamp("payment_reminder_sent_at", { withTimezone: true }),
    /** Напоминание об оплате пишется сейчас: вторая задача ждёт; упал процесс — по сроку захвата его возьмёт повтор. */
    paymentReminderClaimedAt: timestamp("payment_reminder_claimed_at", { withTimezone: true }),
    /** Пришла оплата продукта: больше не продаём и не напоминаем, итог прохождения — «купил». */
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    /** Поздравление с покупкой ушло: второго не будет. */
    purchaseCongratulatedAt: timestamp("purchase_congratulated_at", { withTimezone: true }),
    /**
     * Ход, в котором `payment_check` нашёл оплату: поздравление — в его ответе. Ответ этого хода записан в исходящие
     * (`turn:<id>`) — поздравлен; ход не дошёл до ответа — поздравит задача `purchase-congratulate`.
     */
    purchaseCongratulationTurnId: uuid("purchase_congratulation_turn_id"),
    // Время записи, а не начала транзакции: по нему прохождения идут по порядку
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("passages_chat").on(table.chatId),
    // У человека не больше одного идущего прохождения
    uniqueIndex("passages_one_active_per_person").on(table.personId).where(sql`${table.status} = 'active'`),
    index("passages_lead_magnet").on(table.leadMagnetId),
    uniqueIndex("passages_tracking_code").on(table.trackingCode),
    index("passages_payment_email").on(table.paymentEmail),
  ],
);

export const INBOUND_KINDS = ["message", "button", "blocked", "unblocked", "contact"] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

export const INBOUND_ROUTES = ["passage", "inbox", "ignored"] as const;
export type InboundRoute = (typeof INBOUND_ROUTES)[number];

/**
 * Всё, что пришло от мессенджера. Уникальный `dedupe_key` гарантирует: повтор вебхука не создаёт второй записи,
 * а значит и второго ответа. Маршрут решает работник (`inbound-route`), вебхук только записывает.
 */
export const inboundMessages = appSchema.table(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    kind: text("kind").$type<InboundKind>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    externalUserId: text("external_user_id").notNull(),
    userName: text("user_name"),
    text: text("text").notNull().default(""),
    attachmentKind: text("attachment_kind").$type<AttachmentKind>(),
    startCode: text("start_code"),
    /** Кнопка: что в ней зашито и id нажатия для ответа мессенджеру. */
    buttonPayload: text("button_payload"),
    callbackId: text("callback_id"),
    /** Контакт: откуда человек (сам код чужой ссылки не храним). */
    contactSource: text("contact_source").$type<ContactSource>(),
    personId: uuid("person_id").references(() => people.id),
    passageId: uuid("passage_id").references(() => passages.id),
    route: text("route").$type<InboundRoute>(),
    /** Это сообщение начало прохождение: в ответ уходит первое сообщение лидмагнита. */
    startedPassage: boolean("started_passage").notNull().default(false),
    /** На это сообщение решено ответить автоответом «скоро свяжусь». */
    autoreply: boolean("autoreply").notNull().default(false),
    /** На это сообщение решено ответить меню с кнопками лидмагнитов (режим бота «меню»). */
    menu: boolean("menu").notNull().default(false),
    /** Ход консультанта, который взял сообщение. Пока `answered_at` пуст, ход не закончен и повторится с теми же сообщениями. */
    turnId: uuid("turn_id"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // Время записи, а не начала транзакции: по нему склеиваются сообщения
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("inbound_messages_dedupe_key").on(table.dedupeKey),
    index("inbound_messages_passage").on(table.passageId),
    index("inbound_messages_person").on(table.personId),
    index("inbound_messages_unprocessed").on(table.receivedAt).where(sql`${table.processedAt} is null`),
  ],
);
