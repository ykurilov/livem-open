import { primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bots } from "../channels/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { appSchema } from "../platform/app-schema";

/** Senler у бота ВК: ключ API (только зашифрованным, `BOT_TOKEN_KEY`), группа подписчиков по умолчанию, последняя ошибка. */
export const senlerConnections = appSchema.table("senler_connections", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  /** Группа подписчиков Senler, куда добавляем пришедших по ссылке. Нет — не добавляем. */
  defaultGroupId: text("default_group_id"),
  /** Последний отказ Senler при добавлении; успех стирает. */
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Своя группа Senler у лидмагнита на этом боте; нет строки — группа бота. */
export const senlerLeadMagnetGroups = appSchema.table(
  "senler_lead_magnet_groups",
  {
    leadMagnetId: uuid("lead_magnet_id")
      .notNull()
      .references(() => leadMagnets.id),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    groupId: text("group_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.leadMagnetId, table.botId] })],
);

/**
 * Кого бот уже добавлял в группу Senler. Повторный приход по ссылке не добавляет снова: человек уже в группе,
 * а отписавшийся не должен оказаться подписанным обратно без его ведома.
 */
export const senlerAddedSubscribers = appSchema.table(
  "senler_added_subscribers",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id),
    vkUserId: text("vk_user_id").notNull(),
    groupId: text("group_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.botId, table.vkUserId, table.groupId] })],
);
