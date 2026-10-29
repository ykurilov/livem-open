import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { leadMagnets } from "../lead-magnets/schema";
import type { ShownVideoLink } from "../videos/shown-video";
import { appSchema } from "../platform/app-schema";
import type { ChannelKind } from "./channel";

export const BOT_STATUSES = ["ok", "error"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

/** Что бот делает, если человек пришёл без кода лидмагнита. */
export const NO_CODE_MODES = ["nothing", "default", "menu"] as const;
export type NoCodeMode = (typeof NO_CODE_MODES)[number];

/** Подключённые боты мессенджеров. Токен хранится только зашифрованным (`BOT_TOKEN_KEY`). */
export const bots = appSchema.table(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").$type<ChannelKind>().notNull(),
    title: text("title").notNull(),
    externalId: text("external_id").notNull(),
    username: text("username").notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    status: text("status").$type<BotStatus>().notNull().default("ok"),
    statusError: text("status_error"),
    /** Подряд неудачных проверок по временной причине (сеть, прокси). Сбрасывается при успешной проверке. */
    checkFailures: integer("check_failures").notNull().default(0),
    noCodeMode: text("no_code_mode").$type<NoCodeMode>().notNull().default("nothing"),
    defaultLeadMagnetId: uuid("default_lead_magnet_id").references(() => leadMagnets.id),
    /** Бот удалён экспертом: не принимает сообщений и не виден. Запись остаётся — на неё ссылаются люди и переписка. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("bots_channel_external_id").on(table.channel, table.externalId)],
);

/** На каких ботах работает лидмагнит: не больше одного бота на мессенджер. */
export const leadMagnetBots = appSchema.table(
  "lead_magnet_bots",
  {
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    channel: text("channel").$type<ChannelKind>().notNull(),
  },
  (table) => [
    uniqueIndex("lead_magnet_bots_lead_magnet_channel").on(table.leadMagnetId, table.channel),
    index("lead_magnet_bots_bot").on(table.botId),
  ],
);

/** `outreach` — сообщение, которое консультант в программе пишет первым, когда человек молчит. */
export const OUTBOUND_KINDS = ["consultant", "reminder", "outreach", "autoreply", "manual_reply", "mailing", "menu", "system"] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

/**
 * `sending` — сообщение первым сценария уходит прямо сейчас; `next_attempt_at` — до какого времени захвачено.
 * `awaiting_repair` — сообщение первым не ушло из-за сломанного бота и ждёт починки у сценария; очередь его не берёт
 * (`flows/delivery.ts`, `flows/delivery-repair.ts`).
 */
export const OUTBOUND_STATUSES = ["queued", "sending", "sent", "failed", "blocked", "awaiting_repair"] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/**
 * Очередь исходящих сообщений. Внешних ключей на `bots` и `people` нет: отправка находит бота и человека сама
 * и помечает сообщение `failed`, если их уже нет.
 * Поле `attempts` — счётчик повторов при временных сбоях.
 */
export const outboundMessages = appSchema.table(
  "outbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id").notNull(),
    personId: uuid("person_id").notNull(),
    kind: text("kind").$type<OutboundKind>().notNull(),
    mailingId: uuid("mailing_id"),
    /** Прохождение, к которому относится сообщение (консультант, напоминание, служебное). После починки бота по нему решаем, к месту ли повтор. */
    passageId: uuid("passage_id"),
    text: text("text").notNull(),
    imagePath: text("image_path"),
    buttons: jsonb("buttons").$type<Array<{ label: string; payload: string }>>(),
    /** Ролик, который показал консультант: уходит отдельным сообщением после текста, «Входящие» показывают его ссылкой. */
    video: jsonb("video").$type<ShownVideoLink>(),
    /** Отдельные сообщения после текста и ролика, по порядку (прощание). */
    followUps: jsonb("follow_ups").$type<string[]>().notNull().default([]),
    /** Кто ответил из «Входящих» (`manual_reply`): имя эксперта для консультанта. Нет — «сотрудник». */
    staffName: text("staff_name"),
    status: text("status").$type<OutboundStatus>().notNull().default("queued"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** Когда должна пройти следующая попытка. Сильно просрочена, а сообщение всё ещё ждёт — задача потерялась. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Сколько частей сообщения (картинка, куски текста, ролик, прощание) уже ушло: повтор продолжает с остатка. */
    sentParts: integer("sent_parts").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Не ушло, потому что не работал бот (токен отозван). Когда бот снова в порядке, сообщение ставится заново. */
    awaitsBotRepair: boolean("awaits_bot_repair").notNull().default(false),
    externalMessageId: text("external_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("outbound_messages_idempotency_key").on(table.idempotencyKey),
    index("outbound_messages_person").on(table.personId),
    index("outbound_messages_mailing").on(table.mailingId),
    index("outbound_messages_waiting").on(table.nextAttemptAt).where(sql`${table.status} = 'queued'`),
    index("outbound_messages_awaiting_bot").on(table.botId).where(sql`${table.awaitsBotRepair}`),
  ],
);
