import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCurrentBranch, type ChatStorage, type ModelCatalog, type ModelChoice } from "@ykurilov/agent-chat-core";
import { createChatHandler } from "@ykurilov/agent-chat-server";
import {
  attachConstructorChat,
  clearManualEditNotes,
  findLeadMagnetByConstructorChat,
  getLeadMagnet,
} from "../lead-magnets";
import { logToolCalls } from "../agent-log/capture";
import { foreignWords } from "@ykurilov/agent-chat-reply-check";
import { CABINET_OWNER_ID } from "../platform/cabinet-owner";
import type { Database } from "../platform/db";
import { AGENT_TIME_ZONE, PROVIDER_FALLBACK } from "../platform/models-catalog";
import { turnChatId } from "../platform/turn-request";
import { createTurnTails } from "../platform/turn-tails";
import { constructorTail, fitManualEditNotes } from "./manual-edits";
import { withSaveClaimGuard } from "./save-claim";
import { createConstructorTools } from "./tools";

export const CONSTRUCTOR_BASE_PATH = "/api/constructor";

/** Тег изменения данных: конструктор поменял черновик, панели настроек пора перечитать его. */
export const DRAFT_CHANGED_TAG = "lead-magnet-draft";

/** Предел хвоста хода конструктора: в него помещаются заметки о ручных правках. */
export const CONSTRUCTOR_TAIL_MAX_LENGTH = 4000;

export interface ConstructorEndpointOptions {
  db: Database;
  chatStorage: ChatStorage;
  catalog: ModelCatalog;
  defaultChoice: ModelChoice;
  env?: Record<string, string | undefined>;
  resolveUser: (request: Request) => Promise<{ id: string } | null>;
  /** Инструкция конструктора; по умолчанию — `prompts/constructor.md`. */
  instructions?: string;
}

export interface ConstructorEndpoint {
  fetch(request: Request): Promise<Response>;
  /** Чат конструктора лидмагнита; создаёт его при первом открытии. */
  ensureChat(leadMagnetId: string): Promise<string>;
  /** В чате конструктора уже есть сообщения. */
  hasMessages(chatId: string): Promise<boolean>;
}

export function readConstructorPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "constructor.md"), "utf8");
}

export function createConstructorEndpoint(options: ConstructorEndpointOptions): ConstructorEndpoint {
  const { db, chatStorage } = options;
  const deps = { db, chatStorage };
  const instructions = options.instructions ?? readConstructorPrompt();
  const tails = createTurnTails();

  const handler = createChatHandler({
    basePath: CONSTRUCTOR_BASE_PATH,
    storage: chatStorage,
    // Ответ эксперту — без иероглифов и чужих слов, как у консультанта; ссылки конструктора не трогаются.
    // Слова из черновика лидмагнита законны, даже если конструктор их не читал в этом ходе
    replyChecks: {
      checks: [foreignWords({ script: "cyrillic" })],
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
      // Заметки о ручных правках — в конце запроса шагов этого хода, в историю не пишутся
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
      const sent = fitManualEditNotes(lead?.pendingManualEdits ?? [], CONSTRUCTOR_TAIL_MAX_LENGTH);
      const tail = constructorTail(sent.map((note) => note.text));
      if (chatId) tails.set(chatId, lead ? tail : null);
      if (!lead || !chatId || !tail) return handler.fetch(request);

      const response = await handler.fetch(request);
      if (!response.ok || !response.body) return response;
      // Заметки стираются, только когда ход дошёл до конца удачно: при сбое их унесёт повтор или следующее сообщение
      const clearWhenTurnCompleted = new TransformStream<Uint8Array, Uint8Array>({
        async flush() {
          try {
            const answer = (await loadCurrentBranch(chatStorage, chatId)).at(-1);
            if (answer?.role === "assistant" && answer.status === "complete")
              await clearManualEditNotes(db, lead.id, sent.map((note) => note.id));
          } catch (error) {
            console.error(`Конструктор: не удалось стереть заметки о ручной правке: ${error instanceof Error ? error.message : error}`);
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

    async hasMessages(chatId) {
      return (await chatStorage.listMessages(chatId)).length > 0;
    },
  };
}
