import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildModelMenu, hasChatMessages, loadCurrentBranch, type ChatStorage, type ModelCatalog, type ModelChoice, type ModelMenu } from "@ykurilov/agent-chat-core";
import { createChatHandler } from "@ykurilov/agent-chat-server";
import type { Attachments } from "@ykurilov/agent-chat-attachments";
import {
  attachConstructorChat,
  clearManualEditNotes,
  findLeadMagnetByConstructorChat,
  getLeadMagnet,
} from "../lead-magnets";
import { logToolCalls } from "../agent-log/capture";
import { markAnnounced, unannounced } from "../corrections";
import { foreignWords } from "@ykurilov/agent-chat-reply-check";
import { CABINET_OWNER_ID } from "../platform/cabinet-owner";
import type { Database } from "../platform/db";
import { AGENT_TIME_ZONE, PROVIDER_FALLBACK } from "../platform/models-catalog";
import { turnChatId } from "../platform/turn-request";
import { createTurnTails } from "../platform/turn-tails";
import { answerCorrectionsLine, constructorTail, fitManualEditNotes } from "./manual-edits";
import { withSaveClaimGuard } from "./save-claim";
import { createConstructorTools } from "./tools";

export const CONSTRUCTOR_BASE_PATH = "/api/constructor";

/** Тег изменения данных: конструктор поменял черновик, панели настроек пора перечитать его. */
export const DRAFT_CHANGED_TAG = "lead-magnet-draft";

/** Предел хвоста хода конструктора: в него помещаются строка о новых правках ответов и заметки о ручных правках. */
export const CONSTRUCTOR_TAIL_MAX_LENGTH = 4000;

export interface ConstructorEndpointOptions {
  db: Database;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  defaultChoice: ModelChoice;
  env?: Record<string, string | undefined>;
  resolveUser: (request: Request) => Promise<{ id: string } | null>;
  /** Продолжить завершённый тестовый разговор лидмагнита (инструмент `reopen_test_conversation`). */
  reopenTestConversation?: (leadMagnetId: string) => Promise<void>;
  /** Инструкция конструктора; по умолчанию — `prompts/constructor.md`. */
  instructions?: string;
  /** Картинки в сообщениях эксперта: снимки экрана, фото. Нет — чат только текстовый. */
  attachments?: Attachments;
}

export interface ConstructorEndpoint {
  fetch(request: Request): Promise<Response>;
  /** Чат конструктора лидмагнита; создаёт его при первом открытии. */
  ensureChat(leadMagnetId: string): Promise<string>;
  /** В чате конструктора уже есть сообщения. */
  hasMessages(chatId: string): Promise<boolean>;
  /** Меню моделей — то же, что отдаёт `GET /api/constructor/models`: форма настроек получает его со страницы, без своего запроса. */
  modelMenu(): ModelMenu;
}

export function readConstructorPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "constructor.md"), "utf8");
}

export function createConstructorEndpoint(options: ConstructorEndpointOptions): ConstructorEndpoint {
  const { db, chatStorage } = options;
  const deps = { db, chatStorage, ...(options.reopenTestConversation && { reopenTestConversation: options.reopenTestConversation }) };
  const instructions = options.instructions ?? readConstructorPrompt();
  const tails = createTurnTails();

  const handler = createChatHandler({
    basePath: CONSTRUCTOR_BASE_PATH,
    storage: chatStorage,
    ...(options.attachments && { attachments: options.attachments }),
    // Ответ эксперту — без иероглифов и чужих слов, как у консультанта; ссылки конструктора не трогаются.
    // Слова из черновика лидмагнита законны, даже если конструктор их не читал в этом ходе
    replyChecks: {
      checks: [foreignWords({ script: "cyrillic" })],
      // Фраза перед инструментом печаталась бы на экране до исправления: эксперт видит ответ только после проверки
      web: "hold",
      knownTexts: async ({ chatId }) => {
        const lead = await findLeadMagnetByConstructorChat(db, chatId);
        return lead ? [JSON.stringify(lead.draft)] : [];
      },
    },
    // «Записал» без удачной правки в ходе эксперту не уходит; пропущенную «]» в аргументах правки дописывает ядро SDK
    catalog: withSaveClaimGuard(options.catalog),
    defaultChoice: options.defaultChoice,
    ...(options.env && { env: options.env }),
    resolveUser: async (request) => ((await options.resolveUser(request)) ? { id: CABINET_OWNER_ID } : null),
    // Без поправки на лету: проверка «Записал» (`save-claim.ts`) знает только один ответ на ход
    chatCapabilities: () => ({ steer: false }),
    agent: {
      instructions,
      tools: (model) =>
        logToolCalls(
          createConstructorTools(
            deps,
            async () => {
              const lead = await findLeadMagnetByConstructorChat(db, model.chatId);
              if (!lead) throw new Error(`Чат ${model.chatId} не привязан к лидмагниту`);
              return lead.id;
            },
            () => model.notifyDataChanged({ tag: DRAFT_CHANGED_TAG }),
          ),
          model.chatId,
        ),
      // Вызовы идут по очереди: просмотр после правки видит её результат
      sequentialTools: true,
      // Заметки о ручных правках и строка о новых правках ответов — в конце запроса шагов этого хода, в историю не пишутся
      stepContext: tails.stepContext,
      timeZone: AGENT_TIME_ZONE,
      providerFallback: PROVIDER_FALLBACK,
    },
  });

  return {
    async fetch(request) {
      // Вход — первым: без него ни чтения черновика, ни хвоста
      if (!(await options.resolveUser(request))) return Response.json({ error: "unauthenticated" }, { status: 401 });

      const chatId = turnChatId(request, CONSTRUCTOR_BASE_PATH);
      const lead = chatId ? await findLeadMagnetByConstructorChat(db, chatId) : null;
      // Новые правки и ответы эксперта — одной строкой; сами записи конструктор читает инструментом
      const corrections = lead ? await unannounced(db, lead.id) : { ids: [], pendingTotal: 0, seenAt: new Date() };
      const correctionsLine = answerCorrectionsLine({ fresh: corrections.ids.length, pending: corrections.pendingTotal });
      const sent = fitManualEditNotes(lead?.pendingManualEdits ?? [], CONSTRUCTOR_TAIL_MAX_LENGTH, correctionsLine);
      const tail = constructorTail(sent.map((note) => note.text), correctionsLine);
      if (chatId) tails.set(chatId, lead ? tail : null);
      if (!lead || !chatId || !tail) return handler.fetch(request);

      const response = await handler.fetch(request);
      if (!response.ok || !response.body) return response;
      // Заметки стираются, а правки помечаются упомянутыми, только когда ход дошёл до конца удачно: при сбое их унесёт
      // повтор или следующее сообщение
      const clearWhenTurnCompleted = new TransformStream<Uint8Array, Uint8Array>({
        async flush() {
          try {
            const answer = (await loadCurrentBranch(chatStorage, chatId)).at(-1);
            if (answer?.role !== "assistant" || answer.status !== "complete") return;
            if (sent.length > 0) await clearManualEditNotes(db, lead.id, sent.map((note) => note.id));
            if (correctionsLine) await markAnnounced(db, corrections.ids, corrections.seenAt);
          } catch (error) {
            console.error(`Конструктор: не удалось снять хвост хода (заметки о ручной правке, новые правки ответов): ${error instanceof Error ? error.message : error}`);
          }
        },
      });
      return new Response(response.body.pipeThrough(clearWhenTurnCompleted), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },

    async ensureChat(leadMagnetId) {
      const lead = await getLeadMagnet(db, leadMagnetId);
      if (!lead) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      if (lead.constructorChatId) return lead.constructorChatId;
      const id = randomUUID();
      await chatStorage.createChat({
        id,
        ownerId: CABINET_OWNER_ID,
        modelId: options.defaultChoice.modelId,
        providerId: options.defaultChoice.providerId,
      });
      return attachConstructorChat(db, leadMagnetId, id);
    },

    hasMessages: (chatId) => hasChatMessages(chatStorage, chatId),

    modelMenu: () => buildModelMenu(options.catalog, options.env ?? process.env, options.defaultChoice),
  };
}
