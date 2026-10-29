import { createRunningAnswerRegistry } from "@ykurilov/agent-chat-core";
import { createPostgresChatStorage } from "@ykurilov/agent-chat-storage-postgres";
import { sharedPerProcess } from "./process-shared";

/** Переписки SDK лежат в схеме `agent_chat` той же базы; миграции SDK применяются при открытии. */
export function openChatStorage(connectionString: string) {
  return createPostgresChatStorage({ connectionString });
}

export type AppChatStorage = Awaited<ReturnType<typeof openChatStorage>>;

type RunningAnswerRegistry = ReturnType<typeof createRunningAnswerRegistry>;

// Один реестр на процесс: все сервисы SDK (конструктор, тестовый разговор, консультанты) видят одни и те же идущие ответы.
// В `next dev` модули перезагружаются, поэтому реестр лежит в globalThis.
const shared = globalThis as typeof globalThis & { livemRunningAnswers?: RunningAnswerRegistry };

export function getRunningAnswerRegistry(): RunningAnswerRegistry {
  return (shared.livemRunningAnswers ??= createRunningAnswerRegistry());
}

/** Хранилище переписок процесса: открывается один раз при первом обращении; неудачное открытие повторит следующий вызов. */
export function getChatStorage(connectionString: string): Promise<AppChatStorage> {
  return sharedPerProcess("livemChatStorage", () => openChatStorage(connectionString));
}
