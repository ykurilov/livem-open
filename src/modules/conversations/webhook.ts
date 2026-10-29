import { and, eq, isNull } from "drizzle-orm";
import { findBotWithCredentials, type ChannelAdapters, type ChannelEvent, type WebhookRequest } from "../channels";
import type { TokenCipher } from "../platform/crypto";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { inboundMessages } from "./schema";

export interface WebhookDependencies {
  db: Database;
  queue: JobEnqueuer;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

const REJECTED: WebhookResponse = { status: 401, body: "" };
const RETRY_LATER: WebhookResponse = { status: 500, body: "" };

function inboundRow(botId: string, event: ChannelEvent): typeof inboundMessages.$inferInsert {
  const base = { botId, kind: event.type, dedupeKey: event.dedupeKey, externalUserId: event.userId };
  switch (event.type) {
    case "message":
      return {
        ...base,
        userName: event.userName ?? null,
        text: event.text,
        attachmentKind: event.attachment ?? null,
        startCode: event.startCode ?? null,
      };
    case "button":
      return { ...base, buttonPayload: event.payload, callbackId: event.callbackId };
    case "contact":
      return { ...base, contactSource: event.source };
    case "blocked":
    case "unblocked":
      return base;
  }
}

/**
 * Вебхук мессенджера (конституция I): проверка секрета, запись входящих и задача `inbound-route` — и сразу ответ.
 * Ни модели, ни мессенджера. Повтор того же события упирается в `dedupe_key` и второй записи не создаёт.
 * Задачу поставить не удалось — запись убирается и мессенджер получает ошибку: он повторит, сообщение не потеряется.
 * Процесс упал между записью и задачей — повтор события находит неразобранную запись и ставит задачу заново.
 */
export async function acceptWebhook(
  deps: WebhookDependencies,
  input: { channel: string; botId: string; request: WebhookRequest },
): Promise<WebhookResponse> {
  const found = await findBotWithCredentials(deps.db, deps.cipher, input.botId);
  if (!found || found.bot.channel !== input.channel) return REJECTED;
  const adapter = deps.adapters[found.bot.channel];
  if (!adapter) return REJECTED;

  const parsed = await adapter.parseWebhook(input.request, found.credentials);
  if (parsed.kind === "rejected") return REJECTED;
  if (parsed.kind === "handshake") return { status: 200, body: parsed.responseBody };

  for (const event of parsed.events) {
    const [stored] = await deps.db
      .insert(inboundMessages)
      .values(inboundRow(found.bot.id, event))
      .onConflictDoNothing({ target: inboundMessages.dedupeKey })
      .returning({ id: inboundMessages.id });
    // Повтор события: задача нужна, только если запись ещё не разобрана (лишняя задача безвредна — разбор идемпотентен)
    const unprocessed = stored
      ? null
      : await deps.db
          .select({ id: inboundMessages.id })
          .from(inboundMessages)
          .where(and(eq(inboundMessages.dedupeKey, event.dedupeKey), isNull(inboundMessages.processedAt)))
          .then((rows) => rows[0] ?? null);
    const inboundMessageId = stored?.id ?? unprocessed?.id;
    if (!inboundMessageId) continue;
    try {
      await deps.queue.enqueue("inbound-route", { inboundMessageId });
    } catch (error) {
      if (stored) await deps.db.delete(inboundMessages).where(eq(inboundMessages.id, stored.id));
      console.error("Вебхук: не удалось поставить задачу, мессенджер повторит:", error instanceof Error ? error.message : error);
      return RETRY_LATER;
    }
  }
  return { status: 200, body: parsed.responseBody };
}
