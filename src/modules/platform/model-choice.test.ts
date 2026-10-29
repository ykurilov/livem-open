import { describe, expect, it } from "vitest";
import { createAppCatalog, DEFAULT_MODEL_CHOICE } from "./models-catalog";
import { describeInvalidModelChoice } from "./model-choice";

const catalog = createAppCatalog({});
const reasoningModel = catalog.models.find((model) => (model.reasoning.levels?.length ?? 0) > 0)!;
const reasoningProvider = Object.keys(reasoningModel.providerModelIds)[0]!;

describe("выбор модели консультанта по каталогу", () => {
  it("модель по умолчанию подходит", () => {
    expect(describeInvalidModelChoice(catalog, { ...DEFAULT_MODEL_CHOICE, reasoning: null })).toBeNull();
  });

  it("неизвестный провайдер или модель — понятная ошибка", () => {
    expect(describeInvalidModelChoice(catalog, { providerId: "nope", modelId: DEFAULT_MODEL_CHOICE.modelId, reasoning: null })).toMatch(/провайдер/i);
    expect(describeInvalidModelChoice(catalog, { providerId: DEFAULT_MODEL_CHOICE.providerId, modelId: "nope", reasoning: null })).toMatch(/модел/i);
  });

  it("провайдер не даёт эту модель — ошибка", () => {
    const otherProvider = catalog.providers.find((provider) => !(provider.id in reasoningModel.providerModelIds));
    if (!otherProvider) return;
    expect(describeInvalidModelChoice(catalog, { providerId: otherProvider.id, modelId: reasoningModel.id, reasoning: null })).not.toBeNull();
  });

  it("уровень рассуждения — только из уровней модели", () => {
    const level = reasoningModel.reasoning.levels![0]!;
    expect(describeInvalidModelChoice(catalog, { providerId: reasoningProvider, modelId: reasoningModel.id, reasoning: level })).toBeNull();
    expect(describeInvalidModelChoice(catalog, { providerId: reasoningProvider, modelId: reasoningModel.id, reasoning: "ultra" })).toMatch(/рассужд/i);
  });
});
