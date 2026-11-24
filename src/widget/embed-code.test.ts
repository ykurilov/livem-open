import { describe, expect, it } from "vitest";
import { WIDGET_STYLE_EXAMPLE, widgetEmbedCode } from "./embed-code";

describe("код вставки виджета", () => {
  it("кнопка: скрипт с адреса приложения и элемент с кодом ссылки", () => {
    expect(widgetEmbedCode({ origin: "https://livem.example", code: "abc123", mode: "button", position: "right" })).toBe(
      '<script src="https://livem.example/widget.js" async></script>\n<livem-chat code="abc123" mode="button"></livem-chat>',
    );
  });

  it("кнопка слева — с позицией; у блока позиции нет", () => {
    expect(widgetEmbedCode({ origin: "https://livem.example", code: "abc", mode: "button", position: "left" })).toContain('mode="button" position="left"');
    expect(widgetEmbedCode({ origin: "https://livem.example", code: "abc", mode: "inline", position: "left" })).toContain('<livem-chat code="abc" mode="inline"></livem-chat>');
  });

  it("код с кавычками не ломает разметку", () => {
    expect(widgetEmbedCode({ origin: "https://livem.example", code: 'a"b<', mode: "inline", position: "right" })).toContain('code="a&quot;b&lt;"');
  });

  it("пример CSS называет все переменные и части", () => {
    for (const name of ["--livem-color", "--livem-color-text", "--livem-text", "--livem-background", "--livem-font", "--livem-radius", "--livem-button-size", "--livem-window-width", "--livem-window-height", "--livem-offset-x", "--livem-offset-y", "--livem-z-index"])
      expect(WIDGET_STYLE_EXAMPLE).toContain(`${name}:`);
    for (const part of ["button", "window", "header", "feed", "message-bot", "message-person", "composer", "quick-reply"]) expect(WIDGET_STYLE_EXAMPLE).toContain(`::part(${part})`);
  });
});
