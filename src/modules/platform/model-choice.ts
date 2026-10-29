import type { ModelCatalog } from "@ykurilov/agent-chat-core";

/** Почему выбор модели не подходит каталогу; `null` — подходит. Текст — для эксперта. */
export function describeInvalidModelChoice(
  catalog: ModelCatalog,
  choice: { providerId: string; modelId: string; reasoning: string | null },
): string | null {
  if (!catalog.providers.some((provider) => provider.id === choice.providerId)) return `Нет провайдера «${choice.providerId}»`;
  const model = catalog.models.find((candidate) => candidate.id === choice.modelId);
  if (!model) return `Нет модели «${choice.modelId}»`;
  if (!(choice.providerId in model.providerModelIds)) return `Провайдер «${choice.providerId}» не даёт модель «${model.displayName}»`;
  if (choice.reasoning !== null && !(model.reasoning.levels ?? []).includes(choice.reasoning as never))
    return `У модели «${model.displayName}» нет уровня рассуждения «${choice.reasoning}»`;
  return null;
}
