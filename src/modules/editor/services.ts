import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import { getUser } from "../../auth";
import { AccessError, parseAllowedEmails } from "../access";
import { createAgentLogRecorder, withAgentLog } from "../agent-log";
import { requireUserFromCookie } from "../access/require-user";
import { createConstructorEndpoint, type ConstructorEndpoint } from "../constructor";
import { createPreviewEndpoint, type PreviewEndpoint } from "../consultant";
import { loadAppModels } from "../platform/app-models";
import { getChatImages } from "../platform/chat-attachments";
import { getChatStorage } from "../platform/chat-storage";
import { getDatabase } from "../platform/db";
import { requireEnv } from "../platform/env";
import { createRoleSwapEndpoint, type RoleSwapEndpoint } from "../role-swap";

export interface EditorServices {
  constructor: ConstructorEndpoint;
  preview: PreviewEndpoint;
  /** «Поменяемся ролями»: эксперт отвечает за консультанта, агент играет клиента. */
  roleSwap: RoleSwapEndpoint;
  /** Каталог моделей: по нему проверяется выбор модели в настройках. */
  catalog: ModelCatalog;
}

async function resolveCabinetUser(request: Request): Promise<{ id: string } | null> {
  try {
    return await requireUserFromCookie(request.headers.get("cookie"), {
      allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
      getUser: (cookieHeader) => getUser(cookieHeader),
    });
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

async function createEditorServices(): Promise<EditorServices> {
  const { db, pool } = getDatabase();
  const chatStorage = await getChatStorage(requireEnv("DATABASE_URL"));
  const models = await loadAppModels();
  // Каждый вызов модели пишется в журнал лидмагнита (вкладка «Лог»)
  const catalog = withAgentLog(models.catalog, createAgentLogRecorder(db, process.env));
  const common = { db, chatStorage, catalog, env: models.env, resolveUser: resolveCabinetUser, attachments: getChatImages("web") };
  const preview = createPreviewEndpoint({ ...common, pool, modelChoice: models.consultantChoice });
  return {
    constructor: createConstructorEndpoint({
      ...common,
      defaultChoice: models.constructorChoice,
      reopenTestConversation: (leadMagnetId) => preview.reopenPreview(leadMagnetId),
    }),
    preview,
    roleSwap: createRoleSwapEndpoint({
      db,
      chatStorage,
      catalog,
      env: models.env,
      resolveUser: resolveCabinetUser,
      modelChoice: models.consultantChoice,
      consultantWouldAnswer: (input) => preview.consultantWouldAnswer(input),
    }),
    catalog: models.catalog,
  };
}

// Одни на процесс; в `next dev` модули перезагружаются, поэтому лежат в globalThis
const shared = globalThis as typeof globalThis & { livemEditorServices?: Promise<EditorServices> };

/** Агенты редактора: конструктор, тестовый разговор и «Поменяемся ролями». */
export function getEditorServices(): Promise<EditorServices> {
  return (shared.livemEditorServices ??= createEditorServices().catch((error: unknown) => {
    shared.livemEditorServices = undefined;
    throw error;
  }));
}
