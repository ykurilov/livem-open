import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  DEFAULT_CONSULTANT_REPLY,
  createLiveDialogKit,
  defaultConsultantReply,
  type LiveDialogKit,
  providerOutage,
} from "../../../tests/integration/live-dialog-kit";

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
  const { code } = await kit.publish();
  person = `user-${randomUUID().slice(0, 8)}`;
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();
  // Часы идут, только когда их двигает тест: окно тишины пачки закрывает `drain`
  kit.onBurstRecorded = () => {};
});

/** Сообщение человека: вебхук и сразу маршрутизация, как это делает работник. */
async function say(text: string) {
  await kit.send(person, text);
  await kit.runDue();
}

describe("склейка сообщений", () => {
  it("три сообщения за 4 секунды — один ход консультанта и один ответ", async () => {
    const before = kit.textsTo(person).length;
    await say("Я дизайнер");
    kit.clock.advance(1500);
    await say("Делаю сайты");
    kit.clock.advance(1500);
    await say("Хочу больше клиентов");
    // Ход ещё не начался: ждёт 4 секунды тишины после последнего сообщения
    expect(kit.calls).toHaveLength(0);

    await kit.drain();

    expect(kit.calls).toHaveLength(1);
    const asked = kit.calls[0]!.lastUserText;
    expect(asked.indexOf("Я дизайнер")).toBeGreaterThanOrEqual(0);
    expect(asked.indexOf("Я дизайнер")).toBeLessThan(asked.indexOf("Делаю сайты"));
    expect(asked.indexOf("Делаю сайты")).toBeLessThan(asked.indexOf("Хочу больше клиентов"));
    expect(kit.textsTo(person).slice(before)).toEqual([DEFAULT_CONSULTANT_REPLY]);

    const inbound = (await kit.inboundOf(person)).filter((row) => !row.startedPassage);
    expect(inbound).toHaveLength(3);
    expect(new Set(inbound.map((row) => row.turnId)).size).toBe(1);
    expect(inbound.every((row) => row.answeredAt !== null && row.route === "passage")).toBe(true);
    expect((await kit.passagesOf(person))[0]!.personMessageCount).toBe(3);
  });

  it("в истории чата — три отдельных сообщения человека, модель видит их одним сообщением (пачка SDK)", async () => {
    await say("Я дизайнер");
    kit.clock.advance(1500);
    await say("Делаю сайты");
    kit.clock.advance(1500);
    await say("Хочу больше клиентов");
    await kit.drain();

    const inbound = (await kit.inboundOf(person)).filter((row) => !row.startedPassage);
    const passage = (await kit.passagesOf(person))[0]!;
    const history = await kit.chatStorage.listMessages(passage.chatId);
    const said = history.filter((message) => message.role === "user" && inbound.some((row) => row.id === message.id));
    expect(said.map((message) => message.id)).toEqual(inbound.map((row) => row.id));
    expect(said.map((message) => message.parts.find((part) => part.type === "text"))).toEqual(
      ["Я дизайнер", "Делаю сайты", "Хочу больше клиентов"].map((text) => expect.objectContaining({ text })),
    );
    const prompt = kit.calls[0]!.options.prompt.filter((message) => message.role !== "system");
    const question = prompt.findLast((message) => JSON.stringify(message.content).includes("Я дизайнер"))!;
    const asked = (question.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("");
    expect(asked).toContain("Я дизайнер\n\nДелаю сайты\n\nХочу больше клиентов");
    expect(prompt.filter((message) => JSON.stringify(message.content).includes("Делаю сайты"))).toEqual([question]);
  });

  it("сообщение после ответа — новый ход", async () => {
    await say("Я дизайнер");
    await kit.drain();
    await say("А ещё пишу тексты");
    await kit.drain();

    expect(kit.calls).toHaveLength(2);
    expect(kit.calls[1]!.lastUserText).toContain("А ещё пишу тексты");
    expect(kit.calls[1]!.lastUserText).not.toContain("Я дизайнер");
    expect((await kit.passagesOf(person))[0]!.personMessageCount).toBe(2);
  });

  it("ход упал — повтор задачи отвечает на те же сообщения ровно один раз", async () => {
    let failures = 1;
    kit.reply = (call) => {
      if (failures > 0) {
        failures -= 1;
        throw providerOutage();
      }
      return defaultConsultantReply(call);
    };
    const before = kit.textsTo(person).length;
    await say("Я дизайнер");

    // Ход упал — ошибка в очередь не уходит, ход сам назначает себе повтор
    await kit.drain();

    expect(kit.textsTo(person).slice(before)).toEqual([DEFAULT_CONSULTANT_REPLY]);
    const passage = (await kit.passagesOf(person))[0]!;
    expect(passage.personMessageCount).toBe(1);
    // В истории чата одно сообщение человека, а не два
    const history = await kit.chatStorage.listMessages(passage.chatId);
    expect(history.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("второй запуск хода, когда отвечать не на что, ничего не делает", async () => {
    await say("Я дизайнер");
    await kit.drain();
    const passageId = (await kit.passagesOf(person))[0]!.id;
    await kit.dialog.runTurn(passageId);
    await kit.drain();

    expect(kit.calls).toHaveLength(1);
  });
});
