import { describe, expect, it } from "vitest";
import type { StoredMessage } from "@ykurilov/agent-chat-core";
import { textOf } from "../../../evals/chat-parts";
import { keepLastReply, lastReplyParts } from "./single-reply";

type Part = { type: string; text?: string };
const text = (value: string): Part => ({ type: "text", text: value });
const tool = (name: string): Part => ({ type: `tool-${name}` });
const reply = (parts: Part[]) =>
  keepLastReply(parts, {
    textOf: (part) => (part.type === "text" ? part.text! : null),
    isToolCall: (part) => part.type.startsWith("tool-"),
  });

describe("один ответ за ход", () => {
  it("текст → инструмент → текст: остаётся текст после инструмента, сам вызов на месте", () => {
    expect(reply([text("Вопрос 1?"), tool("remember"), text("Вопрос 2?")])).toEqual([tool("remember"), text("Вопрос 2?")]);
  });

  it("после последнего инструмента пусто — остаётся последний непустой ответ до него", () => {
    expect(reply([text("Отличный план!"), tool("finish_dialog")])).toEqual([text("Отличный план!"), tool("finish_dialog")]);
    expect(reply([text("Вопрос 1?"), tool("remember"), text("Итог."), tool("finish_dialog"), text("  ")])).toEqual([
      tool("remember"),
      text("Итог."),
      tool("finish_dialog"),
      text("  "),
    ]);
  });

  it("инструменты сначала, потом один ответ — без изменений", () => {
    const parts = [{ type: "step-start" }, tool("remember"), tool("go_to_stage"), { type: "step-start" }, text("Вопрос?")];
    expect(reply(parts)).toEqual(parts);
  });

  it("несколько кусков текста в последнем ответе остаются вместе", () => {
    expect(reply([text("Раз."), tool("remember"), text("Два."), text("Три?")])).toEqual([tool("remember"), text("Два."), text("Три?")]);
  });

  it("текста нет совсем — ничего не убирается", () => {
    const parts = [tool("finish_dialog"), text("")];
    expect(reply(parts)).toEqual(parts);
  });

  it("служебные части SDK (`data-frozen-context` несколько раз, `data-step-limit`) остаются на месте, в текст ответа не попадают", () => {
    const parts = [
      { type: "data-frozen-context", data: { blocks: ["memory"] } },
      { type: "text", text: "Вопрос 1?" },
      { type: "tool-remember", toolCallId: "c1", state: "output-available", input: {}, output: "ок" },
      { type: "data-frozen-context", data: { blocks: ["today"] } },
      { type: "text", text: "Вопрос 2?" },
      { type: "data-step-limit", data: {} },
    ] as unknown as StoredMessage["parts"];
    const kept = lastReplyParts(parts);
    expect(kept.map((part) => part.type)).toEqual(["data-frozen-context", "tool-remember", "data-frozen-context", "text", "data-step-limit"]);
    expect(textOf([{ parts: kept }])).toBe("Вопрос 2?");
  });
});
