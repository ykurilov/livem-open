import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import type { AgentLogTurn } from "./types";

/** Ключ имени модели в «Логе»: провайдер и его id модели — так вызов записан в журнал. */
export const modelNameKey = (providerId: string, providerModelId: string) => `${providerId}/${providerModelId}`;

/**
 * Имена моделей, которые эксперт видит в «Настройках», для вызовов из журнала. Журнал хранит id модели у провайдера
 * («stub-v1»), эксперт выбирал «Тестовую модель». Модели нет в каталоге — имени нет, «Лог» покажет id.
 */
export function logModelNames(catalog: ModelCatalog, turns: AgentLogTurn[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const turn of turns)
    for (const entry of turn.entries) {
      if (entry.kind !== "model") continue;
      const key = modelNameKey(entry.providerId, entry.modelId);
      if (key in names) continue;
      const profile = catalog.models.find((model) => model.providerModelIds[entry.providerId] === entry.modelId || model.id === entry.modelId);
      if (profile) names[key] = profile.displayName;
    }
  return names;
}
