import type { ModelCatalog, ModelChoice, ReasoningLevelId } from "@ykurilov/agent-chat-core";
import { APICallError } from "ai";
import { PROVIDER_FALLBACK } from "./models-catalog";

type DirectModelDeps = { catalog: ModelCatalog; env?: Record<string, string | undefined> };

/**
 * Модель из каталога для запроса мимо сервиса SDK: напоминание, переписка ответа. `reasoning` — уровень рассуждений,
 * если модель его умеет; нет — как у модели по умолчанию.
 */
export function directModel(
  deps: DirectModelDeps,
  choice: ModelChoice,
  chatId: string,
  reasoning?: ReasoningLevelId,
) {
  const profile = deps.catalog.models.find((model) => model.id === choice.modelId);
  const provider = deps.catalog.providers.find((candidate) => candidate.id === choice.providerId);
  const providerModelId = profile?.providerModelIds[choice.providerId];
  if (!profile || !provider || !providerModelId) throw new Error(`Нет модели «${choice.modelId}» у провайдера «${choice.providerId}»`);
  const apiKey = (deps.env ?? process.env)[provider.apiKeyEnv];
  if (!apiKey) throw new Error(`Нет ключа ${provider.apiKeyEnv}`);
  const request = provider.requestOptions({ chatId });
  const thinking =
    reasoning && profile.reasoning.levels?.includes(reasoning) ? provider.reasoningRequest?.(reasoning, { profile, providerModelId }) : undefined;
  return {
    providerId: provider.id,
    model: provider.createLanguageModel(providerModelId, apiKey),
    price: profile.pricing?.[provider.id],
    providerOptions: { ...profile.providerOptions, ...request.providerOptions, ...thinking?.providerOptions },
    headers: request.headers,
    ...(thinking?.reasoning && { reasoning: thinking.reasoning }),
  };
}

export type DirectModel = ReturnType<typeof directModel>;

/**
 * Вызов модели мимо SDK с тем же запасным путём, что у ходов: основной провайдер перегружен, упёрся в лимит или недоступен
 * по сети — к запасным из `PROVIDER_FALLBACK` по порядку (с ключом на сервере). Цену и провайдера расхода берите из `direct`.
 * Неверный ключ, плохой запрос, отмена и срок ожидания — ошибка сразу: у запасного они не помогут или время уже ушло.
 */
export async function withDirectModel<T>(
  deps: DirectModelDeps,
  choice: ModelChoice,
  chatId: string,
  call: (direct: DirectModel) => Promise<T>,
  reasoning?: ReasoningLevelId,
): Promise<T> {
  const fallbacks = fallbackProviders(deps, choice);
  let providerId = choice.providerId;
  for (;;) {
    try {
      return await call(directModel(deps, { ...choice, providerId }, chatId, reasoning));
    } catch (error) {
      const next = fallbacks.shift();
      if (!next || !isOverload(error)) throw error;
      console.warn(`[запасной провайдер] чат=${chatId} модель=${choice.modelId} с=${providerId} на=${next} мимо SDK`);
      providerId = next;
    }
  }
}

function fallbackProviders(deps: DirectModelDeps, choice: ModelChoice): string[] {
  const order = PROVIDER_FALLBACK === false ? undefined : PROVIDER_FALLBACK.byModel?.[choice.modelId];
  if (!order) return [];
  const profile = deps.catalog.models.find((model) => model.id === choice.modelId);
  const env = deps.env ?? process.env;
  return order.filter((providerId) => {
    const provider = deps.catalog.providers.find((candidate) => candidate.id === providerId);
    return providerId !== choice.providerId && profile?.providerModelIds[providerId] && provider && env[provider.apiKeyEnv];
  });
}

function isOverload(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return false;
  const cause = error instanceof Error && error.name === "AI_RetryError" ? ((error as { lastError?: unknown }).lastError ?? error) : error;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    return status === undefined ? cause.isRetryable : status === 429 || status >= 500;
  }
  // Сеть: соединение не установилось или оборвалось
  return cause instanceof TypeError || (cause instanceof Error && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(cause.message));
}
