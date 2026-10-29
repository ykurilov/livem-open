// Сценарии для разовых скриптов (перенос идущих чатов, откат): без таймеров и доставки — только закрепление чатов и
// чтение их места. Касаний скрипт не шлёт: их отправит работник в свой срок.
import { createChatService } from "@ykurilov/agent-chat-core";
import { openChatStorage } from "../platform/chat-storage";
import { systemClock } from "../platform/clock";
import type { DatabaseConnection } from "../platform/db";
import { createAppCatalog } from "../platform/models-catalog";
import { createLeadMagnetFlow, type LeadMagnetFlow } from "./runtime";

export interface ScriptFlow {
  flow: LeadMagnetFlow;
  /** Дождаться фоновой работы сценария и закрыть хранилище переписок. */
  close(): Promise<void>;
}

export async function openScriptFlow(connection: DatabaseConnection, databaseUrl: string): Promise<ScriptFlow> {
  const storage = await openChatStorage(databaseUrl);
  // Сценарию нужна служба чата, чтобы читать состояние переписки; модель она не зовёт
  const service = createChatService({ storage, catalog: createAppCatalog(), agent: { instructions: "" } });
  const flow = createLeadMagnetFlow({ db: connection.db, pool: connection.pool, clock: systemClock, logError: (message) => console.error(message) });
  flow.attachPorts(() => service);
  return {
    flow,
    async close() {
      await flow.settled();
      await storage.close();
    },
  };
}
