import { describe, expect, it } from "vitest";
import type { BotSummary } from "@/modules/channels";
import { channelChoices } from "./channel-choices";

const bot = (fields: Partial<BotSummary> & Pick<BotSummary, "id" | "title" | "username">): BotSummary => ({
  channel: "telegram",
  status: "ok",
  statusError: null,
  noCodeMode: "nothing",
  defaultLeadMagnetId: null,
  createdAt: new Date(0),
  ...fields,
});

describe("выбор ботов публикации", () => {
  it("сломанный бот помечен в списке, и форма знает, что с ним", () => {
    const bots = [
      bot({ id: "a", title: "Школа", username: "school_bot" }),
      bot({ id: "b", title: "Старый", username: "old_bot", status: "error", statusError: "Токен отозван" }),
    ];
    const [telegram] = channelChoices(bots, [{ channel: "telegram", botId: "b" }]);

    expect(telegram!.bots).toEqual([
      { value: "a", label: "Школа (@school_bot)" },
      { value: "b", label: "Старый (@old_bot) — не работает" },
    ]);
    expect(telegram!.selected).toBe("b");
    expect(telegram!.brokenBots).toEqual({ b: "Токен отозван" });
  });
});
