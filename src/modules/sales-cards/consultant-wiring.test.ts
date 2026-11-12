import { describe, expect, it } from "vitest";
import { consultantAgentSettings } from "../consultant/services";
import type { ConversationStore } from "../consultant/preview-store";
import { SALES_CARD_TOOL } from "./tool";
import { SALES_CARDS_BLOCK_KEY } from "./sales-cards";
import { doubtCard, priceCard, settingsWithCards } from "./test-settings";

const store = {} as ConversationStore;
const agentOf = (cards: Parameters<typeof settingsWithCards>[0]) =>
  consultantAgentSettings({ settings: settingsWithCards(cards), store, videos: {} as never, images: {} as never });
const model = { chatId: "chat", ownerId: "owner", state: { get: () => undefined, set() {}, unset() {} } } as never;
const blocksInput = (stateId: string) => ({ chatId: "chat", ownerId: "owner", messageId: "m", chat: {}, state: { flow: { state: stateId } }, channel: "web", audience: "private" }) as never;

describe("заготовки у консультанта", () => {
  it("инструмент заготовок есть у версии с заготовками и один и тот же на любом этапе", async () => {
    const tools = await (agentOf([priceCard, doubtCard]).tools as (m: never) => Promise<Record<string, unknown>> | Record<string, unknown>)(model);
    expect(Object.keys(tools)).toContain(SALES_CARD_TOOL);
  });

  it("без заготовок инструмента нет", async () => {
    const tools = await (agentOf([]).tools as (m: never) => Promise<Record<string, unknown>> | Record<string, unknown>)(model);
    expect(Object.keys(tools)).not.toContain(SALES_CARD_TOOL);
  });

  it("список заготовок этапа — блок контекста по текущему этапу чата", async () => {
    const agent = agentOf([priceCard, doubtCard]);
    const onSale = await agent.contextBlocks!(blocksInput("sale"));
    expect((onSale?.find((block) => block.key === SALES_CARDS_BLOCK_KEY) as { text?: string } | undefined)?.text).toContain(priceCard.title);
    const onIntro = await agent.contextBlocks!(blocksInput("intro"));
    expect(onIntro?.some((block) => block.key === SALES_CARDS_BLOCK_KEY) ?? false).toBe(false);
  });
});
