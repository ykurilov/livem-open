import { describe, expect, it } from "vitest";
import { CORRECTION_INTENTS, correctionIntentOf, shownCorrectionIntent } from "./intent";

describe("выбор «Что сделать с правкой» из полей окна правки", () => {
  it("известный выбор читается как есть", () => {
    for (const intent of CORRECTION_INTENTS) expect(correctionIntentOf({ intent })).toBe(intent);
  });

  it("нет выбора или он чужой — не задан: решает конструктор, у повторной правки остаётся прежний", () => {
    expect(correctionIntentOf(undefined)).toBeUndefined();
    expect(correctionIntentOf({ reason: "так лучше" })).toBeUndefined();
    expect(correctionIntentOf({ intent: "delete_everything" })).toBeUndefined();
    expect(correctionIntentOf({ intent: 1 })).toBeUndefined();
  });
});

describe("выбор, который видит эксперт в окне «Поправить»", () => {
  it("повторная правка неразобранного ответа показывает сохранённый выбор — тот, что сервер и оставит", () => {
    expect(shownCorrectionIntent({}, "formula")).toBe("formula");
  });

  it("новая правка без выбора — «Пусть конструктор решит»", () => {
    expect(shownCorrectionIntent({}, undefined)).toBe("auto");
  });

  it("выбор эксперта в окне главнее сохранённого", () => {
    expect(shownCorrectionIntent({ intent: "auto" }, "card")).toBe("auto");
  });
});
