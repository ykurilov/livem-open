import { randomUUID } from "node:crypto";
import type { Database, DatabaseExecutor } from "../platform/db";
import { agentLogEntries, agentLogTurns } from "./schema";
import { findChatOwner } from "./store";
import type { ChatMigrationEntry, FirstMessageEntry, FlowTransitionEntry } from "./types";

/**
 * Событие сценария — отдельной строкой «Лога» лидмагнита: переход между нодами или причины, по которым бот написал
 * первым. Чужой чат (не конструктор, не «Проверка», не разговор человека) не пишется. Сбой уходит в консоль:
 * сценарий журнал не тормозит.
 */
export async function recordFlowLogEvent(db: Database, chatId: string, entry: FlowTransitionEntry | FirstMessageEntry): Promise<void> {
  try {
    const owner = await findChatOwner(db, chatId);
    if (!owner) return;
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(agentLogTurns).values({ id, chatId, startedAt: new Date(entry.at), ...owner });
      await tx.insert(agentLogEntries).values({ turnId: id, kind: entry.kind, at: new Date(entry.at), durationMs: 0, data: entry });
    });
  } catch (error) {
    console.error("Журнал агента: событие сценария не записано", error);
  }
}

/**
 * Перевод идущих разговоров на новую версию — строкой «Лога» лидмагнита. Пишется в транзакции самого перевода: нет
 * записи — нет и перевода. Своего чата у перевода нет, ход помечен `migration:<id>`.
 */
export async function recordChatMigration(tx: DatabaseExecutor, leadMagnetId: string, entry: ChatMigrationEntry): Promise<void> {
  const id = randomUUID();
  const at = new Date(entry.at);
  await tx.insert(agentLogTurns).values({ id, leadMagnetId, chatId: `migration:${id}`, agent: "consultant", source: null, personLabel: entry.by, startedAt: at });
  await tx.insert(agentLogEntries).values({ turnId: id, kind: entry.kind, at, durationMs: 0, data: entry });
}
