import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { previewConversations } from "../consultant/schema";
import { passages } from "../conversations/schema";
import { leadMagnets } from "../lead-magnets/schema";
import { people } from "../people/schema";
import type { Database } from "../platform/db";
import { createRedactor } from "./redact";
import { agentLogEntries, agentLogTurns } from "./schema";
import type { AgentLogAgent, AgentLogEntry, AgentLogPage, AgentLogSink, AgentLogSource } from "./types";

/** Сколько дней хранится журнал. */
export const AGENT_LOG_KEEP_DAYS = 30;
const MAX_CACHED_CHATS = 2000;

interface ChatOwner {
  leadMagnetId: string;
  agent: AgentLogAgent;
  source: AgentLogSource | null;
  personId: string | null;
  personLabel: string | null;
  channel: string | null;
}

/** Чей это чат: конструктор лидмагнита, Проверка или разговор человека в мессенджере. Чужой — `null`. */
export async function findChatOwner(db: Database, chatId: string): Promise<ChatOwner | null> {
  const [constructor] = await db.select({ id: leadMagnets.id }).from(leadMagnets).where(eq(leadMagnets.constructorChatId, chatId));
  if (constructor) return { leadMagnetId: constructor.id, agent: "constructor", source: null, personId: null, personLabel: null, channel: null };

  const [preview] = await db
    .select({ leadMagnetId: previewConversations.leadMagnetId })
    .from(previewConversations)
    .where(eq(previewConversations.chatId, chatId));
  if (preview) return { leadMagnetId: preview.leadMagnetId, agent: "consultant", source: "preview", personId: null, personLabel: null, channel: null };

  const [passage] = await db
    .select({
      leadMagnetId: passages.leadMagnetId,
      personId: people.id,
      displayName: people.displayName,
      externalUserId: people.externalUserId,
      channel: people.channel,
    })
    .from(passages)
    .innerJoin(people, eq(people.id, passages.personId))
    .where(eq(passages.chatId, chatId));
  if (passage) {
    return {
      leadMagnetId: passage.leadMagnetId,
      agent: "consultant",
      source: "messenger",
      personId: passage.personId,
      personLabel: passage.displayName ?? passage.externalUserId,
      channel: passage.channel,
    };
  }
  return null;
}

/**
 * Запись журнала в базу. Ход агента записи не ждёт: у каждого хода своя очередь, сбой уходит в консоль.
 * `flush` — дождаться всех записей (для тестов и завершения работника).
 */
export function createAgentLogRecorder(db: Database, env: Record<string, string | undefined>): AgentLogSink & { flush(): Promise<void> } {
  const redact = createRedactor(env);
  const owners = new Map<string, ChatOwner>();
  /** Очередь записи хода; `false` — ход не пишется (чат ничей или запись хода не удалась). */
  const turns = new Map<string, Promise<boolean>>();
  const pending = new Set<Promise<unknown>>();

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
    return promise;
  };

  const ownerOf = async (chatId: string): Promise<ChatOwner | null> => {
    const cached = owners.get(chatId);
    if (cached) return cached;
    const owner = await findChatOwner(db, chatId);
    if (owner) {
      owners.set(chatId, owner);
      if (owners.size > MAX_CACHED_CHATS) owners.delete(owners.keys().next().value!);
    }
    return owner;
  };

  return {
    startTurn(turn) {
      const written = track(
        (async () => {
          try {
            const owner = await ownerOf(turn.chatId);
            if (!owner) return false;
            await db.insert(agentLogTurns).values({ id: turn.id, chatId: turn.chatId, startedAt: new Date(turn.startedAt), ...owner });
            return true;
          } catch (error) {
            console.error("Журнал агента: ход не записан", error);
            return false;
          }
        })(),
      );
      turns.set(turn.id, written);
      if (turns.size > MAX_CACHED_CHATS) turns.delete(turns.keys().next().value!);
    },
    addEntry(turnId, entry) {
      const previous = turns.get(turnId);
      if (!previous) return;
      const next = track(
        previous.then(async (ok) => {
          if (!ok) return false;
          try {
            const data = redact(entry) as AgentLogEntry;
            await db.insert(agentLogEntries).values({ turnId, kind: data.kind, at: new Date(data.at), durationMs: Math.round(data.durationMs), data });
          } catch (error) {
            console.error("Журнал агента: запись не сохранена", error);
          }
          return true;
        }),
      );
      turns.set(turnId, next);
    },
    async flush() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/** Курсор порции: время начала и id последнего показанного хода. */
function encodeCursor(startedAt: Date, id: string): string {
  return `${startedAt.toISOString()}|${id}`;
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } | null {
  const [at, id] = cursor.split("|");
  const startedAt = new Date(at ?? "");
  return id && !Number.isNaN(startedAt.getTime()) ? { startedAt, id } : null;
}

/** Ходы лидмагнита новым сверху, порциями; внутри хода записи по порядку. */
export async function listAgentLog(db: Database, leadMagnetId: string, options: { limit: number; before?: string }): Promise<AgentLogPage> {
  const cursor = options.before ? decodeCursor(options.before) : null;
  const rows = await db
    .select()
    .from(agentLogTurns)
    .where(
      and(
        eq(agentLogTurns.leadMagnetId, leadMagnetId),
        cursor
          ? or(lt(agentLogTurns.startedAt, cursor.startedAt), and(eq(agentLogTurns.startedAt, cursor.startedAt), lt(agentLogTurns.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(desc(agentLogTurns.startedAt), desc(agentLogTurns.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const entries = page.length
    ? await db
        .select({ turnId: agentLogEntries.turnId, data: agentLogEntries.data })
        .from(agentLogEntries)
        .where(inArray(agentLogEntries.turnId, page.map((row) => row.id)))
        .orderBy(agentLogEntries.id)
    : [];
  const last = page.at(-1);
  return {
    turns: page.map((row) => ({
      id: row.id,
      agent: row.agent,
      source: row.source,
      personLabel: row.personLabel,
      channel: row.channel,
      startedAt: row.startedAt.toISOString(),
      entries: entries.filter((entry) => entry.turnId === row.id).map((entry) => entry.data),
    })),
    nextBefore: rows.length > options.limit && last ? encodeCursor(last.startedAt, last.id) : null,
  };
}

/** Удаляет ходы старше срока хранения (записи уходят вместе с ними). Возвращает, сколько ходов удалено. */
export async function deleteOldAgentLog(db: Database, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - AGENT_LOG_KEEP_DAYS * 86_400_000);
  const deleted = await db.delete(agentLogTurns).where(lt(agentLogTurns.startedAt, threshold)).returning({ id: agentLogTurns.id });
  return deleted.length;
}
