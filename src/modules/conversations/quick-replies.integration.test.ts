import { randomUUID } from "node:crypto";
import { SUGGESTIONS_SHOWN_AFTER_ANSWER } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

const QUESTION = "Вам удобнее созвониться или переписываться?";

/** Модель задаёт вопрос и прикладывает готовые ответы; `finish` — тем же ходом завершает разговор. */
function askingWithButtons({ finish = false } = {}) {
  kit.reply = (call) => {
    if (call.lastToolResult !== undefined) return {};
    return {
      text: QUESTION,
      toolCalls: [
        { toolName: "suggest_replies", input: { replies: ["Созвониться", "Переписываться"] } },
        ...(finish ? [{ toolName: "finish_dialog", input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed" } }] : []),
      ],
    };
  };
}

async function talk(text: string) {
  const lead = await kit.publish({});
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  const before = kit.channel.messagesTo(person).length;
  await kit.send(person, text);
  await kit.drain();
  return kit.channel.messagesTo(person).slice(before).map((entry) => entry.message);
}

describe("готовые ответы консультанта в мессенджере", () => {
  it("консультант видит инструмент готовых ответов", async () => {
    await talk("Привет");
    expect(kit.calls[0]!.toolNames).toContain("suggest_replies");
  });

  it("ответ с готовыми ответами уходит человеку с кнопками под ним", async () => {
    askingWithButtons();
    const [answer] = await talk("Привет");
    expect(answer).toMatchObject({ text: QUESTION, quickReplies: ["Созвониться", "Переписываться"] });
  });

  it("ответ с кнопками закрыт: человек получает сам вопрос, дописка после кнопок не уходит", async () => {
    const results: unknown[] = [];
    kit.reply = (call) => {
      if (call.lastToolResult === undefined)
        return { text: QUESTION, toolCalls: [{ toolName: "suggest_replies", input: { replies: ["Созвониться", "Переписываться"] } }] };
      results.push(call.lastToolResult);
      return { text: "Жду ваш выбор." };
    };
    const sent = await talk("Привет");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: QUESTION, quickReplies: ["Созвониться", "Переписываться"] });
    expect(JSON.stringify(results)).toContain(SUGGESTIONS_SHOWN_AFTER_ANSWER);
  });

  it("запись о человеке после кнопок не теряется, а вопрос с кнопками уходит без дописки", async () => {
    kit.reply = (call) => {
      if (call.lastToolResult === undefined)
        return { text: QUESTION, toolCalls: [{ toolName: "suggest_replies", input: { replies: ["Созвониться", "Переписываться"] } }] };
      if (JSON.stringify(call.lastToolResult).includes(SUGGESTIONS_SHOWN_AFTER_ANSWER)) return { toolCalls: [{ toolName: "flow_note", input: { fact: "Любит переписку" } }] };
      return { text: "Записал, жду ваш выбор." };
    };
    const sent = await talk("Привет");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: QUESTION, quickReplies: ["Созвониться", "Переписываться"] });
    expect((await kit.personOf(person))!.facts.map((fact) => fact.text)).toEqual(["Любит переписку"]);
  });

  it("ответ без них несёт пустой список: мессенджер уберёт прежние кнопки", async () => {
    kit.reply = () => ({ text: "Расскажите подробнее." });
    const [answer] = await talk("Привет");
    expect(answer?.quickReplies).toEqual([]);
  });

  it("разговор завершён этим ходом — кнопок нет", async () => {
    askingWithButtons({ finish: true });
    const sent = await talk("Привет");
    expect(sent.length).toBeGreaterThan(0);
    for (const message of sent) expect(message.quickReplies ?? []).toEqual([]);
  });

  it("следующий ход после ответа с кнопками идёт обычно: человек нажал кнопку — консультант отвечает, кнопки убраны", async () => {
    askingWithButtons();
    await talk("Привет");
    kit.reply = () => ({ text: "Тогда созвонимся." });
    await kit.send(person, "Созвониться");
    await kit.drain();
    const answer = kit.channel.messagesTo(person).at(-1)!.message;
    expect(answer).toMatchObject({ text: "Тогда созвонимся.", quickReplies: [] });
  });
});
