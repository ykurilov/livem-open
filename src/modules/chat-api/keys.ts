import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseExecutor } from "../platform/db";
import { chatApiKeys } from "./schema";

/** Ключи узнаются по началу: запрос с `lmk_` — с сервера эксперта, иначе — токен посетителя из браузера. */
export const CHAT_API_KEY_PREFIX = "lmk_";
/** Сколько знаков ключа кабинет показывает после выпуска: по ним эксперт узнаёт свой ключ. */
const KEY_START_LENGTH = 10;
const KEY_MAX_LENGTH = 200;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Действующий ключ в кабинете: начало и когда выпущен. Нет или отозван — `null`. */
export interface ShownChatApiKey {
  keyStart: string;
  createdAt: Date;
}

/** Выпустить ключ: показывается один раз, в базе — хэш. Прежний ключ перестаёт действовать. */
export async function issueChatApiKey(db: DatabaseExecutor, leadMagnetId: string): Promise<{ key: string } & ShownChatApiKey> {
  const key = `${CHAT_API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const keyStart = key.slice(0, KEY_START_LENGTH);
  const [row] = await db.transaction(async (tx) => {
    await revokeChatApiKey(tx, leadMagnetId);
    return tx.insert(chatApiKeys).values({ leadMagnetId, keyHash: hashKey(key), keyStart }).returning({ createdAt: chatApiKeys.createdAt });
  });
  return { key, keyStart, createdAt: row!.createdAt };
}

/** Отозвать действующий ключ: запросы с ним больше не принимаются. */
export async function revokeChatApiKey(db: DatabaseExecutor, leadMagnetId: string): Promise<void> {
  await db
    .update(chatApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(chatApiKeys.leadMagnetId, leadMagnetId), isNull(chatApiKeys.revokedAt)));
}

export async function readChatApiKey(db: DatabaseExecutor, leadMagnetId: string): Promise<ShownChatApiKey | null> {
  const [row] = await db
    .select({ keyStart: chatApiKeys.keyStart, createdAt: chatApiKeys.createdAt })
    .from(chatApiKeys)
    .where(and(eq(chatApiKeys.leadMagnetId, leadMagnetId), isNull(chatApiKeys.revokedAt)));
  return row ?? null;
}

/** Лидмагнит действующего ключа; выдуманный или отозванный — `null`. */
export async function chatApiKeyLeadMagnet(db: DatabaseExecutor, key: string): Promise<string | null> {
  if (!key.startsWith(CHAT_API_KEY_PREFIX) || key.length > KEY_MAX_LENGTH) return null;
  const [row] = await db
    .select({ leadMagnetId: chatApiKeys.leadMagnetId })
    .from(chatApiKeys)
    .where(and(eq(chatApiKeys.keyHash, hashKey(key)), isNull(chatApiKeys.revokedAt)));
  return row?.leadMagnetId ?? null;
}
