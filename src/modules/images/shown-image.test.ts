import { describe, expect, it } from "vitest";
import { sentImagesOf, shownImagesOf } from "./index";

const name = (id: string) => `image-0000000${id}-0000-4000-8000-000000000000.png`;

const shownPart = (id: string, state = "output-available") => ({
  type: "tool-show_image",
  state,
  output: { картинка: { id, название: `Скриншот ${id}`, подпись: "Что на нём", адрес: `/api/images/${name(id)}`, ширина: 10, высота: 10 } },
});
const shown = (id: string) => ({ id, title: `Скриншот ${id}`, fileName: name(id) });

describe("показанные картинки в сообщении", () => {
  it("shownImagesOf — все показанные по порядку; ошибки, незаконченные вызовы, чужие адреса и текст пропускаются", () => {
    const parts = [
      { type: "text", text: "Вот" },
      shownPart("1"),
      { type: "tool-show_image", state: "output-error", errorText: "нет такой" },
      shownPart("2", "input-available"),
      { ...shownPart("4"), output: { картинка: { ...shownPart("4").output.картинка, адрес: "https://evil.example/a.png" } } },
      shownPart("3"),
    ];
    expect(shownImagesOf(parts)).toEqual([shown("1"), shown("3")]);
  });

  it("sentImagesOf — с каждым ответом только первая показанная картинка, и только если её не показывали раньше", () => {
    expect(sentImagesOf([[shownPart("1"), shownPart("2")], [{ type: "text", text: "Ответ" }], [shownPart("1")], [shownPart("2")]])).toEqual([
      shown("1"),
      null,
      null,
      shown("2"),
    ]);
  });
});
