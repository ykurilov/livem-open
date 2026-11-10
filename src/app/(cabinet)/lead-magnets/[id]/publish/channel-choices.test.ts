import { describe, expect, it } from "vitest";
import type { BotSummary } from "@/modules/channels";
import { channelChoices } from "./channel-choices";

const bot = (fields: Partial<BotSummary> & Pick<BotSummary, "id" | "title" | "username">): BotSummary => ({
  channel: "telegram",
  status: "ok",
  statusError: null,
  canSendPhotos: true,
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

  it("бот ВК без права «Фотографии» помечен в списке; лидмагнит с картинками — форма знает, что их не будет", () => {
    const bots = [
      bot({ id: "a", channel: "vk", title: "Школа", username: "school" }),
      bot({ id: "b", channel: "vk", title: "Клуб", username: "club", canSendPhotos: false }),
    ];
    const vk = (sendsImages: boolean) => channelChoices(bots, [], sendsImages).find((choice) => choice.channel === "vk")!;

    expect(vk(true).bots).toEqual([
      { value: "a", label: "Школа (@school)" },
      { value: "b", label: "Клуб (@club) — без картинок" },
    ]);
    expect(vk(true).photolessBots).toEqual(["b"]);
    // Картинок у лидмагнита нет — и предупреждать не о чем, пометка в списке остаётся
    expect(vk(false).photolessBots).toEqual([]);
    expect(vk(false).bots[1]!.label).toBe("Клуб (@club) — без картинок");
  });
});
