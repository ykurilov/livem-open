import { SpendingLimitReachedError, type AskModelInput, type RecordExternalUsageInput } from "@ykurilov/agent-chat-core";
import { describe, expect, it } from "vitest";
import { createVoiceSpendingService, type VoiceChargeService } from "./spending";

function fakeService(name: string, calls: string[], overLimit = false): VoiceChargeService {
  return {
    async assertWithinLimit(ownerId, chatId) {
      calls.push(`${name}:limit:${ownerId}:${chatId}`);
      if (overLimit) throw new SpendingLimitReachedError({ scope: "user", period: "day", resetsAt: null });
    },
    async recordUsage(input: RecordExternalUsageInput) {
      calls.push(`${name}:record:${input.source}:${input.chatId}`);
    },
    async assertOwnChat() {},
    async askModel(input: AskModelInput) {
      calls.push(`${name}:ask:${input.source}:${input.chatId}`);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

const usage = (chatId: string): RecordExternalUsageInput => ({ ownerId: "o", chatId, source: "voice_input", cost: 0.001, inputTokens: 30, outputTokens: 0, modelId: "stt" });
const ask = (chatId: string): AskModelInput => ({ ownerId: "o", chatId, model: { providerId: "p", modelId: "m" }, prompt: "т", source: "voice_polish" });

describe("расход диктовки — по тем же правилам, что у переписки", () => {
  it("боевой чат: дневной лимит человека, запись и чистка — через службу с лимитами", async () => {
    const calls: string[] = [];
    const service = createVoiceSpendingService({
      live: fakeService("live", calls),
      preview: fakeService("preview", calls),
      isLiveChat: async (chatId) => chatId === "passage-chat",
      emergencyStopped: async () => false,
    });
    await service.assertWithinLimit("person", "passage-chat");
    await service.recordUsage(usage("passage-chat"));
    await service.askModel(ask("passage-chat"));
    expect(calls).toEqual(["live:limit:person:passage-chat", "live:record:voice_input:passage-chat", "live:ask:voice_polish:passage-chat"]);
  });

  it("лимит человека исчерпан — диктовка не начинается", async () => {
    const service = createVoiceSpendingService({
      live: fakeService("live", [], true),
      preview: fakeService("preview", []),
      isLiveChat: async () => true,
      emergencyStopped: async () => false,
    });
    await expect(service.assertWithinLimit("person", "passage-chat")).rejects.toBeInstanceOf(SpendingLimitReachedError);
  });

  it("аварийная остановка по месячному бюджету: консультант молчит — и диктовка с чисткой тоже", async () => {
    const calls: string[] = [];
    const service = createVoiceSpendingService({
      live: fakeService("live", calls),
      preview: fakeService("preview", calls),
      isLiveChat: async () => true,
      emergencyStopped: async () => true,
    });
    await expect(service.assertWithinLimit("person", "passage-chat")).rejects.toBeInstanceOf(SpendingLimitReachedError);
    await expect(service.askModel(ask("passage-chat"))).rejects.toBeInstanceOf(SpendingLimitReachedError);
    expect(calls).toEqual([]);
  });

  it("«Проверка» и чат без прохождения — без лимитов, как тестовый разговор; расход всё равно пишется", async () => {
    const calls: string[] = [];
    const service = createVoiceSpendingService({
      live: fakeService("live", calls),
      preview: fakeService("preview", calls),
      isLiveChat: async () => false,
      emergencyStopped: async () => true,
    });
    await service.assertWithinLimit("cabinet", "preview-chat");
    await service.recordUsage(usage("preview-chat"));
    await service.askModel(ask("preview-chat"));
    expect(calls).toEqual(["preview:limit:cabinet:preview-chat", "preview:record:voice_input:preview-chat", "preview:ask:voice_polish:preview-chat"]);
  });
});
