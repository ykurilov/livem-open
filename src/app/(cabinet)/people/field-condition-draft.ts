import type { FieldCondition, FieldDefinition } from "@/modules/people";

/** Условие в форме: числа — строками, пока человек их набирает. */
export interface DraftCondition {
  key: number;
  fieldId: string;
  equals: string;
  /** Варианты поля с выбором. Форма выбирает один, но условие из ссылки или черновика может держать несколько. */
  options: string[];
  min: string;
  max: string;
  contains: string;
}

/** Ошибки ввода у своих полей условия. */
export type DraftConditionErrors = Partial<Record<"field" | "option" | "contains" | "min" | "max", string>>;

/** Опечатка или пустое значение — ошибка у своего поля: условие без него показало бы больше людей, чем видно в форме. */
export type DraftConditionResult = { condition: FieldCondition } | { errors: DraftConditionErrors };

/** Поля больше нет в словаре: без условия фильтр показал бы всю базу, а не тех, кого выбирали. */
export const FIELD_DELETED = "Поле удалено — уберите условие или выберите другое поле";
const NOT_A_NUMBER = "Введите число";
const NO_OPTION = "Выберите вариант";
const NO_TEXT = "Введите текст";
const MAX_BELOW_MIN = "«До» меньше, чем «от»";

export function toDraft(condition: FieldCondition, key: number): DraftCondition {
  return {
    key,
    fieldId: condition.fieldId,
    equals: condition.kind === "boolean" ? String(condition.equals) : "true",
    options: condition.kind === "choice" ? condition.anyOf : [],
    min: condition.kind === "number" && condition.min !== undefined ? String(condition.min) : "",
    max: condition.kind === "number" && condition.max !== undefined ? String(condition.max) : "",
    contains: condition.kind === "text" ? condition.contains : "",
  };
}

export function conditionFromDraft(draft: DraftCondition, field: FieldDefinition | undefined): DraftConditionResult {
  if (!field) return { errors: { field: FIELD_DELETED } };
  const number = (value: string) => (value.trim() === "" ? undefined : Number(value.trim().replace(",", ".")));
  switch (field.type) {
    case "boolean":
      return { condition: { fieldId: field.id, kind: "boolean", equals: draft.equals === "true" } };
    case "choice":
      return draft.options.length > 0
        ? { condition: { fieldId: field.id, kind: "choice", anyOf: draft.options } }
        : { errors: { option: NO_OPTION } };
    case "number": {
      const min = number(draft.min);
      const max = number(draft.max);
      const errors = {
        ...(min !== undefined && !Number.isFinite(min) && { min: NOT_A_NUMBER }),
        ...(max !== undefined && !Number.isFinite(max) && { max: NOT_A_NUMBER }),
      };
      if (Object.keys(errors).length > 0) return { errors };
      if (min !== undefined && max !== undefined && min > max) return { errors: { max: MAX_BELOW_MIN } };
      return { condition: { fieldId: field.id, kind: "number", ...(min !== undefined && { min }), ...(max !== undefined && { max }) } };
    }
    case "text":
      return draft.contains.trim() ? { condition: { fieldId: field.id, kind: "text", contains: draft.contains.trim() } } : { errors: { contains: NO_TEXT } };
  }
}
