import type { ModelCatalog, ProviderDescription } from "@ykurilov/agent-chat-core";
import type { LanguageModel } from "ai";

function wrapProvider(provider: ProviderDescription, wrap: (model: LanguageModel) => LanguageModel): ProviderDescription {
  const overrides: Partial<ProviderDescription> = {
    createLanguageModel: (providerModelId, apiKey, options) => wrap(provider.createLanguageModel(providerModelId, apiKey, options)),
  };
  if (provider.connect) overrides.connect = (connection) => wrapProvider(provider.connect!(connection), wrap);
  // Прототип сохраняется: методы провайдера-класса остаются на месте
  return Object.assign(Object.create(Object.getPrototypeOf(provider) as object) as ProviderDescription, provider, overrides);
}

/** Каталог, где каждая модель каждого провайдера обёрнута `wrap`. */
export function wrapCatalogModels(catalog: ModelCatalog, wrap: (model: LanguageModel) => LanguageModel): ModelCatalog {
  return { ...catalog, providers: catalog.providers.map((provider) => wrapProvider(provider, wrap)) };
}
