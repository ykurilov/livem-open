import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "../platform/app-schema";

/** Учётные записи для входа по паролю (AUTH_MODE=password). Пароль — только хешем scrypt. */
export const accounts = appSchema.table("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Строчными буквами. */
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
