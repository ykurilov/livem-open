import type { StoredMessage } from "@ykurilov/agent-chat-core";
import { describe, expect, it } from "vitest";
import { CORRECTION_CONTEXT_CHARS } from "../corrections";
import { roleSwapReviewItems } from "./review-items";

let at = 0;
function message(id: string, role: "user" | "assistant", text: string, parentId: string | null): StoredMessage {
  return {
    id,
    chatId: "chat",
    parentId,
    role,
    parts: [{ type: "text", text }],
    formatVersion: 1,
    status: "complete",
    modelId: null,
    providerId: null,
    usage: null,
    reasoningDurationsMs: {},
    error: null,
    createdAt: new Date(Date.UTC(2026, 10, 7, 10, 0, at++)).toISOString(),
  };
}

/** Ветка чата: эксперт — `user`, клиент — `assistant`; первое сообщение лидмагнита — от эксперта. */
function branch(lines: Array<[string, "expert" | "client", string]>): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const [id, who, text] of lines) messages.push(message(id, who === "expert" ? "user" : "assistant", text, messages.at(-1)?.id ?? null));
  return messages;
}

const mark = (draftVersionId: string, stageId?: string) => ({ draftVersionId, ...(stageId && { stageId }) });

describe("roleSwapReviewItems", () => {
  it("только ответы эксперта, без первого сообщения лидмагнита; история и кусок разговора — глазами консультанта", () => {
    const messages = branch([
      ["first", "expert", "Здравствуйте! Какой велосипед ищете?"],
      ["c1", "client", "Для города."],
      ["e1", "expert", "Какой у вас рост?"],
      ["c2", "client", "175."],
      ["e2", "expert", "Тогда рама M."],
    ]);
    const items = roleSwapReviewItems(messages, { e1: mark("v1"), e2: mark("v2", "size") }, "v-now");

    expect(items.map((item) => item.messageId)).toEqual(["e1", "e2"]);
    expect(items[1]).toEqual({
      messageId: "e2",
      expertText: "Тогда рама M.",
      history: [
        { role: "assistant", text: "Здравствуйте! Какой велосипед ищете?" },
        { role: "user", text: "Для города." },
        { role: "assistant", text: "Какой у вас рост?" },
        { role: "user", text: "175." },
      ],
      context: [
        { role: "assistant", text: "Здравствуйте! Какой велосипед ищете?" },
        { role: "user", text: "Для города." },
        { role: "assistant", text: "Какой у вас рост?" },
        { role: "user", text: "175." },
      ],
      stageId: "size",
      draftVersionId: "v2",
    });
    expect(items[0]).toMatchObject({ stageId: null, draftVersionId: "v1" });
  });

  it("кусок разговора — до 6 реплик и не длиннее 4000 знаков; история для пробного хода — целиком", () => {
    const lines: Array<[string, "expert" | "client", string]> = [["first", "expert", "Привет!"]];
    for (let index = 1; index <= 4; index++) lines.push([`c${index}`, "client", `Вопрос ${index}`], [`e${index}`, "expert", `Ответ ${index}`]);
    const short = roleSwapReviewItems(branch(lines), {}, "v-now").at(-1)!;
    expect(short.history).toHaveLength(8);
    expect(short.context).toHaveLength(6);
    expect(short.context[0]).toEqual({ role: "assistant", text: "Ответ 1" });

    lines.push(["long", "client", "я".repeat(CORRECTION_CONTEXT_CHARS - 10)], ["e5", "expert", "Последний ответ"]);
    const last = roleSwapReviewItems(branch(lines), {}, "v-now").at(-1)!;
    expect(last.messageId).toBe("e5");
    expect(last.history).toHaveLength(10);
    expect(last.context.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(CORRECTION_CONTEXT_CHARS);
    expect(last.context.at(-1)).toEqual({ role: "user", text: "я".repeat(CORRECTION_CONTEXT_CHARS - 10) });
  });

  it("ответ без отметки — версия черновика на момент отдачи, без ноды", () => {
    const messages = branch([
      ["first", "expert", "Привет!"],
      ["c1", "client", "Здравствуйте."],
      ["e1", "expert", "Чем помочь?"],
    ]);
    expect(roleSwapReviewItems(messages, {}, "v-now")[0]).toMatchObject({ draftVersionId: "v-now", stageId: null });
  });

  it("реплики с брошенных веток не попадают: берётся только переданная ветка, пустые ответы пропускаются", () => {
    const messages = branch([
      ["first", "expert", "Привет!"],
      ["c1", "client", "Здравствуйте."],
      ["e1-edited", "expert", "Чем помочь?"],
      ["c2", "client", "Не знаю."],
      ["e2", "expert", "   "],
    ]);
    const items = roleSwapReviewItems(messages, { "e1-original": mark("v0"), "e1-edited": mark("v1") }, "v-now");
    expect(items.map((item) => item.messageId)).toEqual(["e1-edited"]);
  });
});
