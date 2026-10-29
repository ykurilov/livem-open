import type { ModelCatalog, ModelChoice } from "@ykurilov/agent-chat-core";
import { createAppCatalog, DEFAULT_MODEL_CHOICE, STUB_MODEL_CHOICE } from "./models-catalog";

type Environment = Record<string, string | undefined>;

export interface AppModels {
  catalog: ModelCatalog;
  /** Модель конструктора. */
  constructorChoice: ModelChoice;
  /** Модель консультанта: та, что выбрана в настройках лидмагнита. */
  consultantChoice(selected: { providerId: string; modelId: string; reasoning: string | null }): ModelChoice;
  env: Environment;
}

/**
 * Модели приложения. `STUB_MODEL=scripted` — для сквозных проверок: все агенты говорят с подставной моделью
 * по сценарию, ключи настоящих провайдеров не нужны. Модуль сценария грузится только тогда.
 */
export async function loadAppModels(env: Environment = process.env): Promise<AppModels> {
  if (env.STUB_MODEL && env.NODE_ENV === "production")
    throw new Error("STUB_MODEL задана в продакшене: подставная модель только для проверок. Уберите переменную.");
  const catalog = createAppCatalog(env);
  if (env.STUB_MODEL === "scripted") {
    const { createE2eCatalog } = await import("./e2e-model");
    return {
      catalog: createE2eCatalog(catalog),
      constructorChoice: STUB_MODEL_CHOICE,
      consultantChoice: () => STUB_MODEL_CHOICE,
      env: { ...env, STUB_MODEL_API_KEY: "e2e" },
    };
  }
  return {
    catalog,
    constructorChoice: DEFAULT_MODEL_CHOICE,
    consultantChoice: ({ providerId, modelId, reasoning }) => ({ providerId, modelId, ...(reasoning && { reasoning }) }),
    env,
  };
}
