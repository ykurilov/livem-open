import { and, eq, gt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { people } from "../people/schema";
import type { Database } from "../platform/db";
import { endActivePassages } from "./passage-end";
import { passages } from "./schema";

/**
 * «Начать заново» из карточки человека: идущий разговор закрывается как «не завершил», а прошлые разговоры, рассылки
 * и ответы эксперта больше не решают, куда идут его сообщения — следующий «Старт» или ссылка начинают лидмагнит с чистого
 * листа, в том числе с законченной программой. Поля и факты человека остаются. Касания закрытого разговора не уходят:
 * доставка видит закрытое прохождение и заканчивает его сценарий. Человека нет — `false`.
 */
export async function startConversationsOver(db: Database, personId: string, at: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Под блокировкой строки человека: маршрутизация его входящих держит её всю транзакцию
    const [person] = await tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).for("update");
    if (!person) return false;
    await endActivePassages(tx, eq(passages.personId, personId), "not_completed", at);
    // Время базы, а не часы приложения: с ним сравниваются времена записи прохождений и сообщений
    await tx.update(people).set({ conversationsResetAt: sql`clock_timestamp()` }).where(eq(people.id, personId));
    return true;
  });
}

/** Записано после «Начать заново» (сброса не было — всё). Колонка — время записи по часам базы. */
export function afterStartOver(column: AnyPgColumn, resetAt: Date | null, condition: SQL | undefined): SQL | undefined {
  return resetAt ? and(condition, gt(column, resetAt)) : condition;
}
