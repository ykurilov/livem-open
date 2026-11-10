import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "@/modules/people";
import { conditionFromDraft, toDraft, type DraftCondition } from "./field-condition-draft";

const age: FieldDefinition = { id: "age", name: "Возраст", type: "number", options: [], description: "" };
const draft = (change: Partial<DraftCondition>): DraftCondition => ({ key: 0, fieldId: "age", equals: "true", options: [], min: "", max: "", contains: "", ...change });

describe("условие по числовому полю из формы", () => {
  it("числа с запятой и пустые границы", () => {
    expect(conditionFromDraft(draft({ min: "1,5" }), age)).toEqual({ condition: { fieldId: "age", kind: "number", min: 1.5 } });
    expect(conditionFromDraft(draft({ min: " ", max: "10" }), age)).toEqual({ condition: { fieldId: "age", kind: "number", max: 10 } });
  });

  it("опечатка — ошибка у своей границы, а не условие без неё", () => {
    expect(conditionFromDraft(draft({ min: "abc", max: "10" }), age)).toEqual({ errors: { min: expect.any(String) } });
    expect(conditionFromDraft(draft({ max: "1o" }), age)).toEqual({ errors: { max: expect.any(String) } });
  });

  it("«от» больше «до» — ошибка у «до», а не условие, которое сервер отбросит", () => {
    expect(conditionFromDraft(draft({ min: "100", max: "10" }), age)).toEqual({ errors: { max: expect.any(String) } });
    expect(conditionFromDraft(draft({ min: "10", max: "10" }), age)).toEqual({ condition: { fieldId: "age", kind: "number", min: 10, max: 10 } });
  });
});

describe("условие без значения", () => {
  const plan: FieldDefinition = { id: "plan", name: "Тариф", type: "choice", options: ["база", "про"], description: "" };
  const city: FieldDefinition = { id: "city", name: "Город", type: "text", options: [], description: "" };

  it("вариант не выбран — ошибка, а не фильтр шире формы", () => {
    expect(conditionFromDraft(draft({ fieldId: "plan" }), plan)).toEqual({ errors: { option: expect.any(String) } });
    expect(conditionFromDraft(draft({ fieldId: "plan", options: ["про"] }), plan)).toEqual({ condition: { fieldId: "plan", kind: "choice", anyOf: ["про"] } });
  });

  it("пустой текст — ошибка", () => {
    expect(conditionFromDraft(draft({ fieldId: "city", contains: "  " }), city)).toEqual({ errors: { contains: expect.any(String) } });
    expect(conditionFromDraft(draft({ fieldId: "city", contains: " Казань " }), city)).toEqual({ condition: { fieldId: "city", kind: "text", contains: "Казань" } });
  });
});

describe("условие по удалённому полю", () => {
  it("ошибка у поля, а не фильтр без условия — иначе «Показать» откроет всю базу", () => {
    expect(conditionFromDraft(draft({ fieldId: "gone", options: ["про"] }), undefined)).toEqual({ errors: { field: expect.any(String) } });
  });
});

describe("условие выбора с несколькими вариантами", () => {
  const plan: FieldDefinition = { id: "plan", name: "Тариф", type: "choice", options: ["база", "про", "бизнес"], description: "" };

  it("открытое в форме, собирается обратно со всеми вариантами", () => {
    const opened = toDraft({ fieldId: "plan", kind: "choice", anyOf: ["про", "бизнес"] }, 0);
    expect(conditionFromDraft(opened, plan)).toEqual({ condition: { fieldId: "plan", kind: "choice", anyOf: ["про", "бизнес"] } });
  });
});
