import type { StoredMessage } from "@ykurilov/agent-chat-core";
import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings } from "../lead-magnets";
import { QUICK_REPLIES_RULE, buildConsultantInstruction } from "./instruction";
import { quickRepliesOf } from "./quick-replies";

type Part = StoredMessage["parts"][number];

const suggest = (replies: unknown): Part =>
  ({ type: "tool-suggest_replies", toolCallId: `c${Math.random()}`, state: "output-available", input: { replies }, output: "показано" }) as Part;
const text = (value: string): Part => ({ type: "text", text: value }) as Part;

describe("готовые ответы из ответа консультанта", () => {
  it("кнопки — из вызова suggest_replies, по порядку", () => {
    expect(quickRepliesOf([text("Как вам удобнее?"), suggest(["Утром", "Вечером"])])).toEqual(["Утром", "Вечером"]);
  });

  it("вызовов несколько — берётся последний", () => {
    expect(quickRepliesOf([suggest(["Старое"]), text("Вопрос"), suggest(["Да", "Нет"])])).toEqual(["Да", "Нет"]);
  });

  it("без вызова — пусто", () => {
    expect(quickRepliesOf([text("Расскажите о себе")])).toEqual([]);
  });

  it("пустые строки, не строки и повторы отбрасываются, лишние сверх четырёх — тоже", () => {
    expect(quickRepliesOf([suggest([" Да ", "", 5, "Да", "Нет", "Может", "Позже", "Никогда"])])).toEqual(["Да", "Нет", "Может", "Позже"]);
  });

  it("вход не тот (нет списка) — пусто", () => {
    expect(quickRepliesOf([suggest("Да")])).toEqual([]);
  });
});

describe("правило про готовые ответы в инструкции", () => {
  const instruction = buildConsultantInstruction(newLeadMagnetSettings("Кнопки"));

  it("в постоянной части: когда кнопки уместны и когда нет", () => {
    expect(instruction).toContain(QUICK_REPLIES_RULE);
    expect(QUICK_REPLIES_RULE).toMatch(/suggest_replies/);
    expect(QUICK_REPLIES_RULE).toMatch(/понятными вариантами ответа/);
    expect(QUICK_REPLIES_RULE).toMatch(/открытый вопрос/);
  });

  it("без образцов кнопок и готовых формулировок", () => {
    expect(QUICK_REPLIES_RULE).not.toMatch(/[«"]/);
  });
});
