import { loadCurrentBranch, type ChatStorage } from "@ykurilov/agent-chat-core";
import { and, eq, isNull } from "drizzle-orm";
import { fields, people } from "../people/schema";
import type { Database } from "../platform/db";
import { isUuid } from "../platform/uuid";

/** Поле карточки, куда консультант записывает, как к человеку обращаться. */
export const PERSON_NAME_FIELD = "Имя";

/**
 * Имя из профиля мессенджера для хвоста хода — только пока поле «Имя» не заполнено. Человек сказал, как к нему
 * обращаться, — имя уже в карточке, а строка в каждом ходе подталкивала бы звать по имени слишком часто (eval 14.10).
 * Владелец чата не человек (тестовый разговор эксперта) — `null`.
 */
export async function profileNameForTail(db: Database, ownerId: string): Promise<string | null> {
  if (!isUuid(ownerId)) return null;
  const [person] = await db.select({ name: people.displayName }).from(people).where(eq(people.id, ownerId));
  if (!person?.name) return null;
  return (await cardName(db, ownerId)) === null ? person.name : null;
}

/** Как человек сказал к нему обращаться: поле «Имя» карточки. Не заполнено или чат не человека — `null`. */
async function cardName(db: Database, ownerId: string): Promise<string | null> {
  if (!isUuid(ownerId)) return null;
  const [person] = await db.select({ values: people.fieldValues }).from(people).where(eq(people.id, ownerId));
  if (!person) return null;
  const nameFields = await db.select({ id: fields.id }).from(fields).where(and(eq(fields.name, PERSON_NAME_FIELD), isNull(fields.deletedAt)));
  for (const { id } of nameFields) {
    const value = person.values[id];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}

/** Сколько последних ответов без имени после обращения по имени: имя — не чаще каждого четвёртого сообщения. */
export const NAME_REST_ANSWERS = 3;

/** Строка хвоста: в недавних ответах человека уже звали по имени. */
export const NAME_REST_LINE = "В этом сообщении не называй человека по имени: ты называл его в одном из трёх последних сообщений.";

/**
 * Имя есть в одном из недавних ответов — в любом падеже (основа без последней буквы у имени длиннее трёх букв) и не
 * частью другого слова. Правило «по имени изредка» модель не держит: начав звать по имени, повторяет свои прошлые
 * ответы (eval 15.10: Ольга по имени в 20 ответах из 27, подряд). Хвост ставит запрет на следующие ответы.
 */
export function namedRecently(name: string, recentAnswers: readonly string[]): boolean {
  const word = name.trim().split(/\s+/)[0] ?? "";
  if (!word) return false;
  const stem = word.length > 3 ? word.slice(0, -1) : word;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<!\\p{L})${escaped}${word.length > 3 ? "\\p{L}{0,3}" : ""}(?!\\p{L})`, "iu");
  return recentAnswers.some((answer) => pattern.test(answer));
}

/** Человека звали по имени из карточки в одном из последних ответов консультанта на текущей ветке чата. */
export async function nameUsedRecently(deps: { db: Database; chatStorage: ChatStorage }, ownerId: string, chatId: string): Promise<boolean> {
  const name = await cardName(deps.db, ownerId);
  if (!name) return false;
  const answers = (await loadCurrentBranch(deps.chatStorage, chatId))
    .filter((message) => message.role === "assistant" && message.status === "complete")
    .slice(-NAME_REST_ANSWERS)
    .map((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
  return namedRecently(name, answers);
}
