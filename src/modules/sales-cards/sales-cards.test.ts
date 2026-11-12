import { describe, expect, it } from "vitest";
import { InvalidLeadMagnetSettingsError, validateLeadMagnetSettings } from "../lead-magnets/settings";
import { buildConsultantInstruction } from "../consultant/instruction";
import { leadMagnetKnownTexts } from "../consultant/known-texts";
import { commonCardsSection, SALES_CARDS_BLOCK_KEY, stageCardsBlock, withoutSalesCard, withSalesCard } from "./sales-cards";
import { doubtCard, priceCard, settingsWithCards } from "./test-settings";

describe("заготовки эксперта: хранение в настройках", () => {
  it("настройки без поля читаются с пустым списком заготовок", () => {
    const { salesCards: _cards, ...old } = settingsWithCards([]);
    expect(validateLeadMagnetSettings(old).salesCards).toEqual([]);
  });

  it("заготовка этапа и общая шпаргалка сохраняются как есть", () => {
    const checked = validateLeadMagnetSettings(settingsWithCards([priceCard, doubtCard]));
    expect(checked.salesCards).toEqual([priceCard, doubtCard]);
  });

  it("у заготовки нужны название, «когда уместна» и текст", () => {
    expect(() => validateLeadMagnetSettings(settingsWithCards([{ ...priceCard, title: " " }]))).toThrow(InvalidLeadMagnetSettingsError);
    expect(() => validateLeadMagnetSettings(settingsWithCards([{ ...priceCard, when: "" }]))).toThrow(/когда/i);
    expect(() => validateLeadMagnetSettings(settingsWithCards([{ ...priceCard, text: "" }]))).toThrow(/текст/i);
  });

  it("id заготовок не повторяются", () => {
    expect(() => validateLeadMagnetSettings(settingsWithCards([priceCard, { ...doubtCard, id: priceCard.id }]))).toThrow(/повторя/);
  });

  it("заготовка удалённого этапа не теряется: переходит в общую шпаргалку", () => {
    const checked = validateLeadMagnetSettings(settingsWithCards([{ ...priceCard, stateId: "gone" }]));
    expect(checked.salesCards).toEqual([{ ...priceCard, stateId: null }]);
  });
});

describe("заготовки в контексте консультанта", () => {
  const settings = settingsWithCards([priceCard, doubtCard]);

  it("общая шпаргалка — в неизменной инструкции: id, название и «когда уместна», без текста", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).toContain(commonCardsSection(settings.salesCards));
    expect(instruction).toContain(doubtCard.id);
    expect(instruction).toContain(doubtCard.title);
    expect(instruction).toContain(doubtCard.when);
    expect(instruction).not.toContain(doubtCard.text);
  });

  it("заготовки этапа в инструкцию не попадают: инструкция одна на версию", () => {
    const instruction = buildConsultantInstruction(settings);
    expect(instruction).not.toContain(priceCard.title);
    expect(instruction).not.toContain(priceCard.text);
  });

  it("без заготовок инструкция прежняя: ни правила, ни списка", () => {
    const without = buildConsultantInstruction(settingsWithCards([]));
    expect(without).not.toMatch(/заготов/i);
  });

  it("правило о заготовках есть и тогда, когда у версии только заготовки этапов", () => {
    expect(buildConsultantInstruction(settingsWithCards([priceCard]))).toMatch(/sales_card/);
  });

  it("список этапа — блок контекста текущего этапа: названия и «когда уместна», без текста", () => {
    const block = stageCardsBlock(settings, "sale");
    expect(block?.key).toBe(SALES_CARDS_BLOCK_KEY);
    expect(block?.text).toContain(priceCard.id);
    expect(block?.text).toContain(priceCard.title);
    expect(block?.text).toContain(priceCard.when);
    expect(block?.text).not.toContain(priceCard.text);
    expect(block?.text).not.toContain(doubtCard.title);
  });

  it("у этапа без заготовок блока нет", () => {
    expect(stageCardsBlock(settings, "intro")).toBeNull();
  });

  it("тексты заготовок — тексты эксперта: ссылка и цена из заготовки не считаются выдумкой", () => {
    const known = leadMagnetKnownTexts(settings);
    expect(known).toContain(priceCard.text);
    expect(known).toContain(doubtCard.text);
  });
});

describe("заготовки эксперта: добавить, поправить, убрать", () => {
  const stages = new Set(["intro", "sale"]);
  const input = { stateId: "sale", title: "Цена", when: "Спросили цену", text: "9 900 ₽", verbatim: true };

  it("новая заготовка — в конец, с новым id", () => {
    const result = withSalesCard([doubtCard], stages, input);
    expect(result).toMatchObject({ ok: true, cards: [doubtCard, { ...input, id: expect.any(String) }] });
    if (result.ok) expect(result.card.id).not.toBe(doubtCard.id);
  });

  it("заготовка с id встаёт на своё место", () => {
    expect(withSalesCard([priceCard, doubtCard], stages, { ...priceCard, text: "10 000 ₽" })).toEqual({
      ok: true,
      card: { ...priceCard, text: "10 000 ₽" },
      cards: [{ ...priceCard, text: "10 000 ₽" }, doubtCard],
    });
  });

  it("неизвестный этап или id — ошибка словами", () => {
    expect(withSalesCard([], stages, { ...input, stateId: "gone" })).toMatchObject({ ok: false, error: expect.stringMatching(/этап/) });
    expect(withSalesCard([], stages, { ...input, id: "gone" })).toMatchObject({ ok: false, error: expect.stringMatching(/заготовк/) });
  });

  it("убрать — по id; неизвестный id — ошибка", () => {
    expect(withoutSalesCard([priceCard, doubtCard], priceCard.id)).toEqual({ ok: true, cards: [doubtCard] });
    expect(withoutSalesCard([priceCard], "gone")).toMatchObject({ ok: false, error: expect.stringMatching(/заготовк/) });
  });
});
