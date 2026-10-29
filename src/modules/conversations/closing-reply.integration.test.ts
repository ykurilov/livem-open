// Последний ответ согласившемуся, склеенный с прощанием: часть answer проверяется на чужие слова, прощание — нет
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { BASE_SETTINGS, createLiveDialogKit, defaultConsultantReply, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";

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

describe("последний ответ с прощанием", () => {
  it("чужие слова в answer переписываются, прощание эксперта уходит как есть", async () => {
    const farewell = "Thanks! Спасибо за разговор, до встречи.";
    const rewrites: string[] = [];
    kit.reply = (call) => {
      if (call.lastUserText.includes("Чужие слова:")) {
        rewrites.push(call.lastUserText);
        return { text: "На самом деле созвон бесплатный." };
      }
      if (call.lastToolResult === undefined && call.lastUserText.toLowerCase().includes("готов"))
        return {
          toolCalls: [
            {
              toolName: "finish_dialog",
              input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed", answer: "Actually, созвон бесплатный." },
            },
          ],
        };
      return defaultConsultantReply(call);
    };
    const lead = await kit.publish({ ...BASE_SETTINGS, farewellMessage: farewell });
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();

    await kit.send(person, "Я готов, а созвон платный?");
    await kit.drain();

    expect(kit.textsTo(person).at(-1)).toBe(`На самом деле созвон бесплатный.\n\n${farewell}`);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toContain("Actually, созвон бесплатный.");
    expect(rewrites[0]).not.toContain("Thanks");
    // Расход переписки — в журнале чата тем же видом, что и у проверок SDK
    const [passage] = await kit.passagesOf(person);
    expect(await kit.chatStorage.sumUsage({ chatId: passage!.chatId, source: "answer_correction" })).toHaveLength(1);
  });

  it("выдуманная ссылка в answer вырезается, ссылка из прощания эксперта остаётся", async () => {
    const farewell = "Подробности: https://expert.example.com/next";
    kit.reply = (call) => {
      if (call.lastUserText.includes("Ссылки не из инструкции:")) return { text: call.lastUserText.split("\n")[0]! };
      if (call.lastToolResult === undefined && call.lastUserText.toLowerCase().includes("готов"))
        return {
          toolCalls: [
            {
              toolName: "finish_dialog",
              input: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон", outcome: "agreed", answer: "Запись тут: https://fake-site.ru/form — созвон бесплатный." },
            },
          ],
        };
      return defaultConsultantReply(call);
    };
    const lead = await kit.publish({ ...BASE_SETTINGS, farewellMessage: farewell });
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();

    await kit.send(person, "Я готов, а созвон платный?");
    await kit.drain();

    const last = kit.textsTo(person).at(-1)!;
    expect(last).not.toContain("fake-site.ru");
    expect(last).toContain("созвон бесплатный");
    expect(last.endsWith(farewell)).toBe(true);
  });
});
