import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildModelMenu, loadCurrentBranch, type Chat, type ChatStorage, type ModelCatalog, type ModelChoice, type ModelMenu } from "@ykurilov/agent-chat-core";
import { createChatHandler } from "@ykurilov/agent-chat-server";
import type { Attachments } from "@ykurilov/agent-chat-attachments";
import {
  addConstructorChat,
  clearManualEditNotes,
  findLeadMagnetByConstructorChat,
  getLeadMagnet,
  listConstructorChatIds,
  type LeadMagnet,
  removeConstructorChat,
} from "../lead-magnets";
import { logToolCalls } from "../agent-log/capture";
import { markAnnounced, unannounced } from "../corrections";
import { foreignWords } from "@ykurilov/agent-chat-reply-check";
import { CABINET_OWNER_ID } from "../platform/cabinet-owner";
import type { Database, DatabaseExecutor } from "../platform/db";
import { AGENT_TIME_ZONE, PROVIDER_FALLBACK } from "../platform/models-catalog";
import { turnChatId } from "../platform/turn-request";
import { isUuid } from "../platform/uuid";
import { createTurnTails } from "../platform/turn-tails";
import { answerCorrectionsLine, constructorTail, fitManualEditNotes } from "./manual-edits";
import { CONSTRUCTOR_BASE_PATH, CONSTRUCTOR_CHATS_PREFIX } from "./chats-api";
import { withSaveClaimGuard } from "./save-claim";
import { createConstructorTools } from "./tools";

export { CONSTRUCTOR_BASE_PATH, constructorChatsApi } from "./chats-api";

/** Адреса SDK, которые не про один чат: меню моделей и настройки вложений. */
const isServicePath = (chatId: string, action: string | undefined) =>
  (chatId === "models" && action === undefined) || (chatId === "attachments" && action === "settings");

/** Сколько держится резерв хвоста за ходом, который так и не дошёл до конца (оборванный поток). */
const TAIL_CLAIM_TTL_MS = 15 * 60_000;

const notFound = () => Response.json({ error: { kind: "not_found" } }, { status: 404 });

/** Сначала недавние: как список чатов SDK. */
const byRecentUse = (a: Chat, b: Chat) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Тег изменения данных: конструктор поменял черновик, панели настроек пора перечитать его. */
export const DRAFT_CHANGED_TAG = "lead-magnet-draft";

/** Предел хвоста хода конструктора: в него помещаются строка о новых правках ответов и заметки о ручных правках. */
export const CONSTRUCTOR_TAIL_MAX_LENGTH = 4000;

interface TailClaim {
  leadMagnetId: string;
  notes: Set<string>;
  corrections: Set<string>;
  at: number;
}

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
  /** Файлы в сообщениях эксперта: картинки, а PDF и текст — базы знаний (`createConstructorFiles`). Нет — чат только текстовый. */
  attachments?: Attachments;
}

export interface ConstructorEndpoint {
  fetch(request: Request): Promise<Response>;
  /** Недавний чат конструктора лидмагнита; нет ни одного — заводит первый. */
  ensureChat(leadMagnetId: string): Promise<string>;
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
  /** Хвосты идущих ходов: что из общих заметок и правок лидмагнита уже везёт какой-то ход. */
  const claims = new Set<TailClaim>();
  function claimedBy(leadMagnetId: string): { notes: Set<string>; corrections: Set<string> } {
    const taken = { notes: new Set<string>(), corrections: new Set<string>() };
    for (const claim of claims) {
      if (Date.now() - claim.at > TAIL_CLAIM_TTL_MS) claims.delete(claim);
      else if (claim.leadMagnetId === leadMagnetId) {
        for (const id of claim.notes) taken.notes.add(id);
        for (const id of claim.corrections) taken.corrections.add(id);
      }
    }
    return taken;
  }

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
    // Переименование и удаление чатов; список и создание — только по адресу лидмагнита (`constructorChatsApi`)
    chatList: true,
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

  async function createChat(leadMagnetId: string, executor: DatabaseExecutor = db): Promise<string> {
    const id = randomUUID();
    await chatStorage.createChat({
      id,
      ownerId: CABINET_OWNER_ID,
      modelId: options.defaultChoice.modelId,
      providerId: options.defaultChoice.providerId,
    });
    await addConstructorChat(executor, leadMagnetId, id);
    return id;
  }

  /** Чаты конструктора лидмагнита, недавние первыми. */
  async function chatsOf(leadMagnetId: string, executor: DatabaseExecutor = db): Promise<Chat[]> {
    const chats = await Promise.all((await listConstructorChatIds(executor, leadMagnetId)).map((id) => chatStorage.getChat(id)));
    return chats.filter((chat): chat is Chat => chat !== null).sort(byRecentUse);
  }

  /**
   * Адрес списка лидмагнита: `GET`/`POST` — список и новый чат, `…/<chatId>[/…]` — тот же чат SDK, но только чат этого
   * лидмагнита. Удалённый чат отвязывается от лидмагнита.
   */
  async function leadMagnetChats(request: Request, url: URL): Promise<Response> {
    const [leadMagnetId = "", chatId, ...rest] = url.pathname.slice(CONSTRUCTOR_CHATS_PREFIX.length).split("/").map(decodeURIComponent);
    if (!isUuid(leadMagnetId) || !(await getLeadMagnet(db, leadMagnetId))) return notFound();

    if (!chatId) {
      const method = request.method.toUpperCase();
      if (method === "GET") {
        const chats = (await chatsOf(leadMagnetId)).map(({ id, title, createdAt, updatedAt, closed }) => ({
          id,
          title: title ?? null,
          createdAt,
          updatedAt,
          ...(closed && { closed }),
        }));
        return Response.json({ chats });
      }
      if (method === "POST") return Response.json({ id: await createChat(leadMagnetId) }, { status: 201 });
      return Response.json({ error: { kind: "method_not_allowed" } }, { status: 405 });
    }

    return chatRoute(request, url, [chatId, ...rest], leadMagnetId);
  }

  /**
   * Запрос к одному чату — по адресу лидмагнита или по прямому `/api/constructor/<chatId>/…`. Пускает только чат,
   * привязанный к лидмагниту (и к этому, если адрес лидмагнита); удалённый чат отвязывается.
   */
  async function chatRoute(request: Request, url: URL, segments: string[], leadMagnetId?: string): Promise<Response> {
    const [chatId = "", action] = segments;
    const target = new URL(`${CONSTRUCTOR_BASE_PATH}/${segments.map(encodeURIComponent).join("/")}${url.search}`, url);
    const forwarded =
      target.href === url.href
        ? request
        : new Request(target, { method: request.method, headers: request.headers, body: request.body, signal: request.signal, duplex: "half" } as RequestInit);
    if (isServicePath(chatId, action)) return handler.fetch(forwarded);

    const lead = await findLeadMagnetByConstructorChat(db, chatId);
    if (!lead || (leadMagnetId !== undefined && lead.id !== leadMagnetId)) return notFound();
    const response = await chatRequest(forwarded, lead);
    if (request.method.toUpperCase() === "DELETE" && segments.length === 1 && (response.status === 204 || response.status === 404)) {
      await removeConstructorChat(db, chatId);
    }
    return response;
  }

  /** Запрос к чату SDK; ход получает хвост — заметки о ручных правках и строку о новых правках ответов. */
  async function chatRequest(request: Request, lead: LeadMagnet): Promise<Response> {
    const chatId = turnChatId(request, CONSTRUCTOR_BASE_PATH);
    if (!chatId) return handler.fetch(request);
    // Заметки и правки, которые уже несёт идущий ход другого чата, этому ходу не достаются: каждая — ровно в один ход
    const taken = claimedBy(lead.id);
    const corrections = await unannounced(db, lead.id);
    const freshIds = corrections.ids.filter((id) => !taken.corrections.has(id));
    // Новые правки и ответы эксперта — одной строкой; сами записи конструктор читает инструментом
    const correctionsLine = answerCorrectionsLine({ fresh: freshIds.length, pending: corrections.pendingTotal });
    const notes = lead.pendingManualEdits.filter((note) => !taken.notes.has(note.id));
    const sent = fitManualEditNotes(notes, CONSTRUCTOR_TAIL_MAX_LENGTH, correctionsLine);
    const tail = constructorTail(sent.map((note) => note.text), correctionsLine);
    tails.set(chatId, tail);
    if (!tail) return handler.fetch(request);

    const claim: TailClaim = {
      leadMagnetId: lead.id,
      notes: new Set(sent.map((note) => note.id)),
      corrections: new Set(correctionsLine ? freshIds : []),
      at: Date.now(),
    };
    claims.add(claim);
    let response: Response;
    try {
      response = await handler.fetch(request);
    } catch (error) {
      claims.delete(claim);
      throw error;
    }
    if (!response.ok || !response.body) {
      claims.delete(claim);
      return response;
    }

    // Заметки стираются, а правки помечаются упомянутыми, только когда ход дошёл до конца удачно: при сбое их унесёт
    // повтор или следующее сообщение
    const clearWhenTurnCompleted = new TransformStream<Uint8Array, Uint8Array>({
      async flush() {
        try {
          const answer = (await loadCurrentBranch(chatStorage, chatId)).at(-1);
          if (answer?.role !== "assistant" || answer.status !== "complete") return;
          if (sent.length > 0) await clearManualEditNotes(db, lead.id, sent.map((note) => note.id));
          if (correctionsLine) await markAnnounced(db, freshIds, corrections.seenAt);
        } catch (error) {
          console.error(`Конструктор: не удалось снять хвост хода (заметки о ручной правке, новые правки ответов): ${error instanceof Error ? error.message : error}`);
        } finally {
          claims.delete(claim);
        }
      },
      // Поток оборван: ход не подтверждён, заметки снова свободны для следующего хода (без `cancel` в среде — через TAIL_CLAIM_TTL_MS)
      cancel() {
        claims.delete(claim);
      },
    } as Transformer<Uint8Array, Uint8Array>);
    return new Response(response.body.pipeThrough(clearWhenTurnCompleted), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return {
    async fetch(request) {
      // Вход — первым: без него ни чтения черновика, ни хвоста
      if (!(await options.resolveUser(request))) return Response.json({ error: "unauthenticated" }, { status: 401 });

      const url = new URL(request.url);
      if (url.pathname.startsWith(CONSTRUCTOR_CHATS_PREFIX)) return leadMagnetChats(request, url);
      // Общий список всех чатов кабинета и чат без лидмагнита не нужны никому
      const segments = url.pathname.slice(CONSTRUCTOR_BASE_PATH.length).split("/").filter(Boolean).map(decodeURIComponent);
      if (!url.pathname.startsWith(`${CONSTRUCTOR_BASE_PATH}/`) || segments.length === 0) return notFound();
      return chatRoute(request, url, segments);
    },

    async ensureChat(leadMagnetId) {
      if (!(await getLeadMagnet(db, leadMagnetId))) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
      // Две вкладки разом не заводят два первых чата: проверка и создание — под замком лидмагнита
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`constructor-chats:${leadMagnetId}`}))`);
        return (await chatsOf(leadMagnetId, tx))[0]?.id ?? createChat(leadMagnetId, tx);
      });
    },


    modelMenu: () => buildModelMenu(options.catalog, options.env ?? process.env, options.defaultChoice),
  };
}
