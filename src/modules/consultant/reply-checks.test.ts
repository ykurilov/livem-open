import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadMagnetToFlow } from "../flows/settings-to-flow";
import { newLeadMagnetSettings, type LeadMagnetSettings } from "../lead-magnets";
import type { DatabaseExecutor } from "../platform/db";
import { getImages } from "../images";
import { getVideos } from "../videos";
import { consultantReplyChecks } from "./reply-checks";

vi.mock("../videos", () => ({ getVideos: vi.fn() }));
vi.mock("../images", () => ({ getImages: vi.fn() }));

const db = {} as DatabaseExecutor;
const chat = { ownerId: "person-1", chatId: "chat-1" };

beforeEach(() => {
  vi.mocked(getVideos).mockReset();
  vi.mocked(getImages).mockReset().mockResolvedValue([]);
});

function settingsWithNode(): LeadMagnetSettings {
  const old = {
    ...newLeadMagnetSettings("Курс"),
    instruction: "Ты помощник Анны. Курс: https://school.example/course",
    firstMessage: "Привет! Анкета: https://forms.example/start",
    farewellMessage: "До встречи в https://t.me/annachannel",
    stages: [{ id: "build", name: "Сборка", instruction: "Дай шаблон https://bolt.new/template", transitionCondition: "Открыл", startDay: null, isSale: false }],
    videoIds: ["v1"],
    imageIds: ["i1"],
  };
  return { ...old, flow: leadMagnetToFlow(old, []) };
}

describe("проверки ответа консультанта", () => {
  it("наши тексты вне сценария — первое сообщение, прощание, названия роликов; тексты сценария добавляет SDK сам", async () => {
    vi.mocked(getVideos).mockResolvedValue([{ title: "Ролик про Notion" }] as never);
    vi.mocked(getImages).mockResolvedValue([{ title: "Кнопка Publish в appstudio" }] as never);
    const setting = consultantReplyChecks({ db, settings: settingsWithNode() });
    expect(setting.checks).toHaveLength(2);
    const known = await setting.knownTexts!(chat);
    expect(known).toEqual(expect.arrayContaining(["Привет! Анкета: https://forms.example/start", "До встречи в https://t.me/annachannel", "Ролик про Notion", "Кнопка Publish в appstudio"]));
    expect(known.join("\n")).not.toContain("https://bolt.new/template");
    expect(known.join("\n")).not.toContain("https://school.example/course");
  });

  it("короткая ссылка из text_link — результат инструмента: проверка ссылок её пропускает", async () => {
    const link = "https://lm.example.ru/i/K7mP2xQ";
    const { checks } = consultantReplyChecks({ db, settings: settingsWithNode() });
    const seenTexts = [JSON.stringify({ ok: true, link })];
    const rewrite = async () => "";
    const text = `Откройте ссылку и нажмите «Собрать»: ${link}`;
    for (const check of checks) expect(await check({ text, ownerId: "o", chatId: "c", messageId: "m", seenTexts, rewrite })).toBeUndefined();
  });

  it("сбой загрузки роликов не запоминается: следующая проверка грузит их снова", async () => {
    vi.mocked(getVideos)
      .mockRejectedValueOnce(new Error("база недоступна"))
      .mockResolvedValueOnce([{ title: "Ролик про Notion" }] as never);
    const { knownTexts } = consultantReplyChecks({ db, settings: settingsWithNode() });

    await expect(knownTexts!(chat)).rejects.toThrow("база недоступна");
    expect(await knownTexts!(chat)).toContain("Ролик про Notion");
    await knownTexts!(chat);
    expect(getVideos).toHaveBeenCalledTimes(2);
  });
});
