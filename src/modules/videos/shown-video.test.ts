import { describe, expect, it } from "vitest";
import { parseChapterLines, parseTimeLabel, sentVideosOf, shownVideoOf, shownVideosOf, videoMessageText } from "./index";

describe("присланный ролик", () => {
  it("YouTube с началом — ссылка с отметкой времени и «с 3:20»", () => {
    const shown = shownVideoOf({ видео: { id: "x", название: "Промпты", площадка: "youtube", код: "aircAruvnKk", начало: 200 } });
    expect(shown).toEqual({ title: "Промпты", url: "https://www.youtube.com/watch?v=aircAruvnKk&t=200s", startLabel: "3:20" });
    expect(videoMessageText(shown!)).toBe("▶ Промпты\nс 3:20\nhttps://www.youtube.com/watch?v=aircAruvnKk&t=200s");
  });

  it("Kinescope без начала — просто ссылка", () => {
    const shown = shownVideoOf({ видео: { id: "x", название: "Урок", площадка: "kinescope", код: "abc123" } });
    expect(shown).toEqual({ title: "Урок", url: "https://kinescope.io/abc123" });
    expect(videoMessageText(shown!)).toBe("▶ Урок\nhttps://kinescope.io/abc123");
  });

  it("отказ и чужие данные — не ролик", () => {
    expect(shownVideoOf({ отказ: "нет такого" })).toBeNull();
    expect(shownVideoOf({ видео: { название: "X", площадка: "vimeo", код: "1" } })).toBeNull();
    expect(shownVideoOf(null)).toBeNull();
  });
});

const shownPart = (id: string, state = "output-available") => ({
  type: "tool-show_video",
  state,
  output: { видео: { id, название: `Ролик ${id}`, площадка: "kinescope", код: `code${id}` } },
});
const link = (id: string) => ({ title: `Ролик ${id}`, url: `https://kinescope.io/code${id}` });

describe("показанные ролики в сообщении", () => {
  it("shownVideosOf — все показанные по порядку, с id; отказы, незаконченные вызовы и текст пропускаются", () => {
    const parts = [
      { type: "text", text: "Вот" },
      shownPart("a"),
      { type: "tool-show_video", state: "output-available", output: { отказ: "нет" } },
      shownPart("b", "input-available"),
      shownPart("c"),
    ];
    expect(shownVideosOf(parts)).toEqual([
      { id: "a", link: link("a") },
      { id: "c", link: link("c") },
    ]);
  });

  it("sentVideosOf — из ответа уходит только первый показанный ролик, и только если его не показывали раньше", () => {
    expect(sentVideosOf([[shownPart("a"), shownPart("b")], [{ type: "text", text: "Привет" }], [shownPart("a")], [shownPart("b")]])).toEqual([
      link("a"),
      null,
      null,
      link("b"),
    ]);
  });

  it("первый показанный — повтор: ролика в ответе нет, второй не подставляется", () => {
    expect(sentVideosOf([[shownPart("a")], [shownPart("a"), shownPart("b")]])).toEqual([link("a"), null]);
  });
});

describe("время в форме ролика", () => {
  it("понимает секунды, минуты и часы", () => {
    expect(parseTimeLabel("45")).toBe(45);
    expect(parseTimeLabel("3:20")).toBe(200);
    expect(parseTimeLabel("1:02:05")).toBe(3725);
    expect(parseTimeLabel("3:75")).toBeNull();
    expect(parseTimeLabel("три")).toBeNull();
  });

  it("главы — по строке «3:20 Название», пустые строки пропускаются", () => {
    expect(parseChapterLines("0:00 Вступление\n\n3:20 Примеры")).toEqual([
      { title: "Вступление", startSeconds: 0 },
      { title: "Примеры", startSeconds: 200 },
    ]);
    expect(() => parseChapterLines("Примеры")).toThrow("Строка «Примеры»: начните с времени, например «3:20 Примеры»");
  });
});
