import { boolean, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bots } from "../channels/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";

/** Календарь созвонов эксперта: один на кабинет, общий для всех лидмагнитов. Всегда одна строка: `id = 1`. */
export const callCalendar = appSchema.table("call_calendar", {
  id: integer("id").primaryKey().default(1),
  /** Пояс эксперта (IANA): по нему окна, подписи времени агенту и в кабинете. */
  timeZone: text("time_zone").notNull().default("Europe/Moscow"),
  /** Длина одного созвона, минуты: окна режутся на созвоны этой длины. */
  callMinutes: integer("call_minutes").notNull().default(30),
});

/**
 * Окно эксперта: промежуток по его часам (`date`, `start_time`, `end_time`). Конец раньше начала — окно через полночь.
 * `weekly` — повторяется каждую неделю с `date`. Правка и удаление записи не трогают: запись живёт сама по себе.
 */
export const callWindows = appSchema.table("call_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  weekly: boolean("weekly").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const CALL_BOOKING_STATUSES = ["booked", "rescheduled", "cancelled"] as const;
export type CallBookingStatus = (typeof CALL_BOOKING_STATUSES)[number];

/** Кто отменил запись. */
export type CallCancelledBy = "person" | "expert";

/**
 * Запись на созвон. Действующая — `booked`; перенос — прежняя строка `rescheduled` со ссылкой на новую.
 * Двух действующих записей на пересекающееся время нет: исключающее ограничение `call_bookings_no_overlap` в базе
 * (миграция 0061), тестовые записи «Проверки» (`test_chat_id`) под него не попадают и окон не занимают.
 */
export const callBookings = appSchema.table(
  "call_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").$type<CallBookingStatus>().notNull().default("booked"),
    /** Человек (`people.id`); у тестовой записи «Проверки» — нет. Без внешнего ключа: склейка людей переносит его сама. */
    personId: uuid("person_id"),
    /** Тестовая запись: чат «Проверки». Окна не занимает, уведомлений и напоминаний нет. */
    testChatId: text("test_chat_id"),
    passageId: uuid("passage_id"),
    leadMagnetId: uuid("lead_magnet_id").references(() => leadMagnets.id),
    /** Ссылка на встречу из настройки лидмагнита в момент записи: её получает напоминание. */
    meetingLink: text("meeting_link"),
    cancelledBy: text("cancelled_by").$type<CallCancelledBy>(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Перенос: новая запись. */
    rescheduledToId: uuid("rescheduled_to_id"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("call_bookings_starts_at").on(table.startsAt),
    index("call_bookings_person").on(table.personId),
    index("call_bookings_test_chat").on(table.testChatId),
  ],
);

export type CallBookingRow = typeof callBookings.$inferSelect;

/**
 * Боты эксперта, через которые он получает уведомления о записях. «Подключить» выдаёт одноразовый код в ссылке бота;
 * «Старт» с ним записывает, кому писать (`chat_id` — аккаунт эксперта в этом мессенджере), и гасит код.
 */
export const callNotifyBots = appSchema.table(
  "call_notify_bots",
  {
    botId: uuid("bot_id")
      .primaryKey()
      .references(() => bots.id),
    connectCode: text("connect_code"),
    chatId: text("chat_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    /** Последняя отправка не дошла насовсем (эксперт остановил бота, бот сломан): что видит эксперт. Успех — сброс. */
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("call_notify_bots_connect_code").on(table.connectCode)],
);

/** `reminder_failed`, `cancel_message_failed` — напоминание или сообщение об отмене не дошло до человека: эксперт напишет сам. */
export const CALL_NOTICE_KINDS = ["booked", "rescheduled", "cancelled", "reminder_failed", "cancel_message_failed"] as const;
export type CallNoticeKind = (typeof CALL_NOTICE_KINDS)[number];
export type CallNoticeStatus = "queued" | "sent" | "failed";

/** Уведомление эксперту о записи через его бота: одно на запись, вид и бот — повтор задачи второго не шлёт. */
export const callNotices = appSchema.table(
  "call_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => callBookings.id),
    kind: text("kind").$type<CallNoticeKind>().notNull(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    text: text("text").notNull(),
    status: text("status").$type<CallNoticeStatus>().notNull().default("queued"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("call_notices_booking_kind_bot").on(table.bookingId, table.kind, table.botId)],
);

export type CallNoticeRow = typeof callNotices.$inferSelect;
