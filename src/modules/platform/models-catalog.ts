import { extendCatalog, standardCatalog } from "@ykurilov/agent-chat-core";
import type { ModelCatalog, ProviderFallbackSetting } from "@ykurilov/agent-chat-core";
import type { LanguageModel } from "ai";
import { requireEnv } from "./env";

/** Модель и провайдер по умолчанию — и для конструктора, и для новых лидмагнитов. */
export const DEFAULT_MODEL_CHOICE = { providerId: "deepseek", modelId: "deepseek-4.1-flash" } as const;

/**
 * Запасной путь SDK: сам DeepSeek перегружен или упёрся в лимит до начала ответа — ход идёт через Together, потом через
 * OpenRouter (Дмитрий 22.10: DeepSeek основной, Together запасной). Снимок страницы видят все три (SDK 0.60+).
 */
export const PROVIDER_FALLBACK: ProviderFallbackSetting = { byModel: { [DEFAULT_MODEL_CHOICE.modelId]: ["together", "openrouter"] } };

/** Часовой пояс агентов у сервисов без лимитов (конструктор, превью). */
export const AGENT_TIME_ZONE = "Europe/Moscow";

type Environment = Record<string, string | undefined>;

/** Переменная с адресом прокси для каждого провайдера, которого с московского сервера напрямую не достать. */
const PROXIED_PROVIDERS = { deepseek: "DEEPSEEK_BASE_URL", together: "TOGETHER_BASE_URL", openrouter: "OPENROUTER_BASE_URL" } as const;

/**
 * Каталог моделей приложения. С московского сервера OpenRouter и Together закрыты, поэтому при заданном адресе
 * (`OPENROUTER_BASE_URL`, `TOGETHER_BASE_URL`) запросы к ним идут через французский прокси с заголовком `X-Proxy-Token`.
 * DeepSeek с сервера доступен напрямую; `DEEPSEEK_BASE_URL` — на случай блокировки и для проверки сбоя.
 * На Маке адреса не задают — запросы идут напрямую.
 */
export function createAppCatalog(env: Environment = process.env): ModelCatalog {
  const connectProviders = Object.fromEntries(
    Object.entries(PROXIED_PROVIDERS).flatMap(([providerId, variable]) => {
      const baseURL = env[variable]?.trim();
      return baseURL ? [[providerId, { baseURL, headers: { "X-Proxy-Token": requireEnv("PROXY_TOKEN", env) } }]] : [];
    }),
  );
  return Object.keys(connectProviders).length === 0 ? standardCatalog : extendCatalog(standardCatalog, { connectProviders });
}

export const STUB_MODEL_CHOICE = { providerId: "stub", modelId: "stub-model" } as const;

/** Каталог с тестовым провайдером на подставной модели (для тестов и сквозных проверок без настоящей модели). */
export function createStubModelCatalog(base: ModelCatalog, model: LanguageModel): ModelCatalog {
  return extendCatalog(base, {
    addProviders: [
      {
        id: STUB_MODEL_CHOICE.providerId,
        displayName: "Тестовая модель",
        apiKeyEnv: "STUB_MODEL_API_KEY",
        createLanguageModel: () => model,
        requestOptions: () => ({}),
      },
    ],
    addModels: [
      {
        id: STUB_MODEL_CHOICE.modelId,
        displayName: "Тестовая модель",
        contextWindowTokens: 100_000,
        acceptsImages: false,
        reasoning: { replayPastTurns: true },
        providerModelIds: { [STUB_MODEL_CHOICE.providerId]: "stub-v1" },
        pricing: { [STUB_MODEL_CHOICE.providerId]: { inputPerMillion: 0, outputPerMillion: 0 } },
      },
    ],
  });
}
