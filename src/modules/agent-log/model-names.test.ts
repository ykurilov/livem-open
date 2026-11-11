import type { ModelCatalog } from "@ykurilov/agent-chat-core";
import { describe, expect, it } from "vitest";
import { logModelNames, modelNameKey } from "./model-names";
import type { AgentLogTurn, ModelCallEntry } from "./types";

const catalog = {
  models: [{ id: "stub-model", displayName: "Тестовая модель", providerModelIds: { stub: "stub-v1" } }],
  providers: [],
} as unknown as ModelCatalog;

const call = (providerId: string, modelId: string) => ({ kind: "model", providerId, modelId }) as ModelCallEntry;

describe("имена моделей в «Логе»", () => {
  it("id модели у провайдера — именем из «Настроек», незнакомая — без имени", () => {
    const turns = [{ entries: [call("stub", "stub-v1"), call("other", "mystery-1")] }] as AgentLogTurn[];
    expect(logModelNames(catalog, turns)).toEqual({ [modelNameKey("stub", "stub-v1")]: "Тестовая модель" });
  });
});
