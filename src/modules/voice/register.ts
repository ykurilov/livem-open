import { createChatService } from "@ykurilov/agent-chat-core";
import { createVoiceRelay, type VoiceRelay } from "@ykurilov/agent-chat-voice/server";
import { eq } from "drizzle-orm";
import { getUser } from "../../auth";
import { parseCookies } from "../../auth/cookies";
import { parseAllowedEmails } from "../access/access";
import { AccessError, requireUserFromCookie } from "../access/require-user";
import { readPreviewConversation } from "../consultant/preview-store";
import { passages } from "../conversations/schema";
import { findLeadMagnetByPreviewChat, getLeadMagnet } from "../lead-magnets";
import { loadAppModels } from "../platform/app-models";
import { getChatStorage, getRunningAnswerRegistry } from "../platform/chat-storage";
import { systemClock } from "../platform/clock";
import { getDatabase } from "../platform/db";
import { requireEnv } from "../platform/env";
import { createDailyLimits, readBudgetStatus } from "../spending";
import { findWebChatVisitor, webChatVoiceInput, webChatVoicePayer } from "../web-chat";
import { WEB_CHAT_COOKIE } from "../web-chat/cookie";
import { createVoiceSpendingChat, createVoiceUserResolver, type VoiceAccessPorts } from "./access";
import { SONIOX_USD_PER_HOUR, voiceConfigured, voiceRelayConnection } from "./relay-options";
import { createVoiceSpendingService, type VoiceChargeService } from "./spending";

type Env = Record<string, string | undefined>;

/**
 * Ретранслятор голоса для сервера приложения (`src/server/app-server.ts`). Нет ключа Soniox — ретранслятора нет,
 * соединения голоса получают 503, а страницы не показывают микрофон.
 * Секунды звука и чистка текста пишутся в журнал расхода SDK по тем же правилам, что переписка (`./spending`).
 */
export async function createAppVoiceRelay(env: Env = process.env): Promise<VoiceRelay | null> {
  if (!voiceConfigured(env)) {
    console.log("[голос] выключен: на сервере нет SONIOX_API_KEY");
    return null;
  }
  console.log("[голос] включён");
  const models = await loadAppModels(env);
  const ports = appVoicePorts();
  const charges = voiceCharges(env, models);
  return createVoiceRelay({
    resolveUser: createVoiceUserResolver(ports),
    env,
    ...voiceRelayConnection(env),
    languageHints: ["ru"],
    spending: { service: charges, recognitionUsdPerHour: SONIOX_USD_PER_HOUR, chatId: createVoiceSpendingChat(ports) },
    // Та же дешёвая модель, что у конструктора и запасного судьи: русский знает, рассуждений не нужно
    polish: { askModel: charges.askModel, model: models.constructorChoice },
    logError: (message) => console.error(`[голос] ${message}`),
  });
}

/** Службы расхода открываются при первой диктовке: запуск сервера к базе не ходит. */
function voiceCharges(env: Env, models: Awaited<ReturnType<typeof loadAppModels>>): VoiceChargeService {
  let opened: Promise<{ live: VoiceChargeService; preview: VoiceChargeService }> | null = null;
  const db = () => getDatabase().db;
  const services = () =>
    (opened ??= getChatStorage(requireEnv("DATABASE_URL", env)).then((storage) => {
      const base = { storage, catalog: models.catalog, env: models.env, registry: getRunningAnswerRegistry(), agent: { instructions: "" } };
      return {
        live: createChatService({ ...base, limits: createDailyLimits({ db: db(), chatStorage: storage, catalog: models.catalog, clock: systemClock }) }),
        preview: createChatService(base),
      };
    })).catch((error: unknown) => {
      opened = null;
      throw error;
    });
  const lazy = (pick: "live" | "preview"): VoiceChargeService => ({
    assertWithinLimit: async (...args) => (await services())[pick].assertWithinLimit(...args),
    recordUsage: async (...args) => (await services())[pick].recordUsage(...args),
    assertOwnChat: async (...args) => (await services())[pick].assertOwnChat(...args),
    askModel: async (...args) => (await services())[pick].askModel(...args),
  });
  return createVoiceSpendingService({
    live: lazy("live"),
    preview: lazy("preview"),
    async isLiveChat(chatId) {
      const [passage] = await db().select({ id: passages.id }).from(passages).where(eq(passages.chatId, chatId)).limit(1);
      return passage !== undefined;
    },
    emergencyStopped: async () =>
      (await readBudgetStatus({ db: db(), chatStorage: await getChatStorage(requireEnv("DATABASE_URL", env)), clock: systemClock })).emergencyStopped,
  });
}

function appVoicePorts(): VoiceAccessPorts {
  const db = () => getDatabase().db;
  return {
    async webChatVisitorId(request) {
      const token = parseCookies(request.headers.get("cookie"))[WEB_CHAT_COOKIE];
      return (await findWebChatVisitor(db(), token))?.id ?? null;
    },
    webChatPayer: (visitorId, code) => webChatVoicePayer(db(), visitorId, code),
    webChatVoiceEnabled: (code) => webChatVoiceInput(db(), code),
    async cabinetUser(request) {
      try {
        return await requireUserFromCookie(request.headers.get("cookie"), {
          allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
          getUser: (cookieHeader) => getUser(cookieHeader),
        });
      } catch (error) {
        if (error instanceof AccessError) return null;
        throw error;
      }
    },
    async previewVoiceEnabled(chatId) {
      const lead =
        (await findLeadMagnetByPreviewChat(db(), chatId)) ??
        (await readPreviewConversation(db(), chatId).then((preview) => (preview ? getLeadMagnet(db(), preview.leadMagnetId) : null)));
      return lead?.draft.voiceInput === true;
    },
  };
}
