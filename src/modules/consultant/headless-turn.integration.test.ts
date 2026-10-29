import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import {
  BASE_SETTINGS,
  DEFAULT_CONSULTANT_REPLY,
  createLiveDialogKit,
  type LiveDialogKit,
} from "../../../tests/integration/live-dialog-kit";
import { createField, deleteField, type FieldDefinition } from "../people";
import { updateSettings } from "../platform/settings";

const MAX_MESSAGE_CHARS = 300;

let database: TestDatabase;
let kit: LiveDialogKit;
let person: string;
let niche: FieldDefinition;
let callReady: FieldDefinition;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { maxMessageChars: MAX_MESSAGE_CHARS });
  niche = await createField(database.db, { name: "Ниша", type: "text", description: "Чем занимается" });
  callReady = await createField(database.db, { name: "Готов к созвону", type: "boolean", description: "Да/нет" });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  kit = await createLiveDialogKit(database);
  person = `user-${randomUUID().slice(0, 8)}`;
});

async function startWith(settings: Parameters<LiveDialogKit["publish"]>[0] = {}) {
  const lead = await kit.publish(settings);
  await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  return lead;
}

async function say(text: string, extra: Parameters<LiveDialogKit["send"]>[2] = {}) {
  await kit.send(person, text, extra);
  await kit.drain();
}

describe("ход консультанта без браузера", () => {
  it("чат SDK принадлежит человеку, ответ модели уходит в мессенджер, расход записан в прохождение", async () => {
    await startWith({ instruction: "Ты консультант по дизайну." });
    await say("Привет, я дизайнер");

    const [passage] = await kit.passagesOf(person);
    const personRow = await kit.personOf(person);
    const chat = await kit.chatStorage.getChat(passage!.chatId);
    expect(chat?.ownerId).toBe(personRow!.id);

    expect(kit.calls).toHaveLength(1);
    expect(kit.calls[0]!.system).toContain("Ты консультант по дизайну.");
    expect(kit.calls[0]!.lastUserText).toContain("Привет, я дизайнер");
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);

    const usage = await kit.chatStorage.sumUsage({ chatId: passage!.chatId });
    const spent = usage.reduce((sum, row) => sum + row.costUsd, 0);
    expect(spent).toBeGreaterThan(0);
    expect(Number(passage!.costUsd)).toBeCloseTo(spent, 6);
    expect(passage!.lastPersonMessageAt).not.toBeNull();
  });

  it("модель видит первое сообщение лидмагнита в истории разговора", async () => {
    await startWith({ firstMessage: "Чем вы занимаетесь?" });
    await say("Дизайном");
    const prompt = JSON.stringify(kit.calls[0]!.options.prompt);
    expect(prompt).toContain("Чем вы занимаетесь?");
  });

  it("finish_dialog с agreed и прощанием: свой текст модели до и после вызова не уходит, человек получает только прощание", async () => {
    kit.reply = (call) => {
      if (call.lastToolResult !== undefined) return {};
      return {
        text: "Отличный план!",
        toolCalls: [
          { toolName: "finish_dialog", input: { goal: "Больше клиентов", stuckAt: "Нет заявок", chosenStep: "Созвон", outcome: "agreed" } },
        ],
      };
    };
    await startWith();
    const before = kit.textsTo(person).length;
    await say("Я выбираю созвон");

    const [passage] = await kit.passagesOf(person);
    expect(passage).toMatchObject({
      status: "completed",
      summary: { goal: "Больше клиентов", stuckAt: "Нет заявок", chosenStep: "Созвон", outcome: "agreed" },
    });
    expect(passage!.endedAt).not.toBeNull();
    const sent = kit.textsTo(person).slice(before);
    expect(sent).toEqual([BASE_SETTINGS.farewellMessage]);
  });

  it("finish_dialog с agreed и answer: человек получает ответ на свой вопрос, потом прощание, текст модели после вызова — нет", async () => {
    kit.reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Отлично! Ирина свяжется в течение рабочего дня. До встречи!" }
        : {
            toolCalls: [
              {
                toolName: "finish_dialog",
                input: { goal: "Клиенты", stuckAt: "Нет заявок", chosenStep: "Созвон", outcome: "agreed", answer: "Созвон бесплатный." },
              },
            ],
          };
    await startWith();
    const before = kit.textsTo(person).length;
    await say("Да, подходит. А созвон платный?");
    expect(kit.textsTo(person).slice(before)).toEqual([`Созвон бесплатный.\n\n${BASE_SETTINGS.farewellMessage}`]);
  });

  it("без прощания в настройках при agreed человек получает последний ответ модели, как раньше", async () => {
    kit.reply = (call) =>
      call.lastToolResult !== undefined
        ? { text: "Отлично, до встречи!" }
        : { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Клиенты", stuckAt: "Нет заявок", chosenStep: "Созвон", outcome: "agreed" } }] };
    await startWith({ farewellMessage: "" });
    const before = kit.textsTo(person).length;
    await say("Да, подходит");
    expect(kit.textsTo(person).slice(before)).toEqual(["Отлично, до встречи!"]);
  });

  it("человек отказался или ушёл — прощание из настроек не уходит, только ответ консультанта", async () => {
    for (const outcome of ["declined", "left"]) {
      person = `user-${randomUUID().slice(0, 8)}`;
      kit.reply = (call) =>
        call.lastToolResult !== undefined
          ? { text: "Поняла, удачи вам!" }
          : { toolCalls: [{ toolName: "finish_dialog", input: { goal: "Клиенты", stuckAt: "Нет заявок", chosenStep: "Пока ничего", outcome } }] };
      await startWith();
      const before = kit.textsTo(person).length;
      await say("Нет, мне не надо");

      const [passage] = await kit.passagesOf(person);
      expect(passage!.status).toBe("completed");
      expect(passage!.summary?.outcome).toBe(outcome);
      expect(kit.textsTo(person).slice(before)).toEqual(["Поняла, удачи вам!"]);
    }
  });

  it("finish_dialog без текста — человек получает только прощание", async () => {
    await startWith();
    const before = kit.textsTo(person).length;
    await say("Я готов");
    expect(kit.textsTo(person).slice(before)).toEqual([BASE_SETTINGS.farewellMessage]);
  });

  it("текст до инструмента и после — человек получает один ответ, и следующий ход видит в истории только его", async () => {
    kit.reply = (call) => {
      if (call.lastToolResult !== undefined) return { text: "Так что было в тот раз?" };
      if (call.lastUserText.includes("показывал"))
        return { text: "Вспомни последний раз, что вышло?", toolCalls: [{ toolName: "remember", input: { facts: ["Показывает другим"] } }] };
      return { text: "Понял." };
    };
    await startWith();
    const before = kit.textsTo(person).length;
    await say("Я показывал сборку приложения");

    expect(kit.textsTo(person).slice(before)).toEqual(["Так что было в тот раз?"]);

    await say("Ушёл с готовым приложением");
    const history = JSON.stringify(kit.calls.at(-1)!.options.prompt);
    expect(history).toContain("Так что было в тот раз?");
    expect(history).not.toContain("Вспомни последний раз");
  });

  it("предел сообщений: модель предупреждена, а если не завершила — разговор завершает приложение без прощания (согласия не было)", async () => {
    await startWith({ maxPersonMessages: 2 });
    await say("Первое");
    const before = kit.textsTo(person).length;
    await say("Второе");

    expect(kit.calls.at(-1)!.lastUserText).toMatch(/последнее сообщение человека/i);
    const [passage] = await kit.passagesOf(person);
    expect(passage!.status).toBe("completed");
    expect(passage!.personMessageCount).toBe(2);
    const sent = kit.textsTo(person).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent).toEqual([DEFAULT_CONSULTANT_REPLY]);
  });

  it("слишком длинное сообщение человека обрезается до max_message_chars", async () => {
    await startWith();
    const long = "а".repeat(MAX_MESSAGE_CHARS * 3);
    await say(long);

    const asked = kit.calls[0]!.lastUserText;
    expect(asked).toContain("а".repeat(MAX_MESSAGE_CHARS));
    expect(asked).not.toContain("а".repeat(MAX_MESSAGE_CHARS + 1));
  });

  it("картинка или файл от человека — пометка о вложении в хвосте, консультант отвечает текстом", async () => {
    await startWith();
    await say("", { attachment: "image" });
    expect(kit.calls[0]!.lastUserText).toMatch(/картинк/i);
    expect(kit.textsTo(person).at(-1)).toBe(DEFAULT_CONSULTANT_REPLY);

    await say("Вот мой прайс", { attachment: "file" });
    const asked = kit.calls[1]!.lastUserText;
    expect(asked).toContain("Вот мой прайс");
    expect(asked).toMatch(/файл/i);
  });

  it("карточка ноды — в запросе; заявка flow_exit с причиной, судья подтвердил — этап прохождения сменился, причина в истории", async () => {
    kit.reply = (call) => {
      if (call.lastToolResult !== undefined) return { text: "Перешли к цели." };
      if (call.lastUserText.includes("дизайнер")) return { toolCalls: [{ toolName: "flow_exit", input: { exit: 1, why: "Назвал нишу: дизайнер" } }] };
      return { text: "Хорошо." };
    };
    kit.judge = () => ["intro_done"];
    await startWith({
      stages: [
        { id: "intro", name: "Знакомство", instruction: "Узнай нишу", transitionCondition: "Ниша известна", startDay: null, isSale: false },
        { id: "goal", name: "Цель", instruction: "Узнай цель", transitionCondition: "Цель названа", startDay: null, isSale: false },
      ],
    });
    await say("Я дизайнер");
    await kit.dialog.flow.settled();
    const promptOf = (call: (typeof kit.calls)[number]) => JSON.stringify(call.options.prompt);
    expect(promptOf(kit.consultantCalls()[0]!)).toContain("Узнай нишу");
    const [passage] = await kit.passagesOf(person);
    expect(passage!.currentStageId).toBe("goal");
    expect(passage!.stageHistory).toEqual([expect.objectContaining({ stageId: "goal", reason: "Назвал нишу: дизайнер", decidedBy: "claim", by: "model" })]);

    kit.judge = () => [];
    await say("Хочу клиентов");
    expect(promptOf(kit.consultantCalls().at(-1)!)).toContain("Узнай цель");
  });

  it("flow_note: поле — в карточку человека, факт «ведёт блог» — в его факты; удалённое поле — понятный отказ, ничего не записано", async () => {
    const budget = await createField(database.db, { name: `Бюджет ${randomUUID().slice(0, 6)}`, type: "text", description: "Сколько готов вложить" });
    const results: unknown[] = [];
    kit.reply = (call) => {
      if (call.lastToolResult !== undefined) {
        results.push(call.lastToolResult);
        return { text: "Запомнил." };
      }
      if (call.lastUserText.includes("бюджет")) return { toolCalls: [{ toolName: "flow_note", input: { field: budget.id, value: "100 тысяч" } }] };
      if (call.lastUserText.includes("блог")) return { toolCalls: [{ toolName: "flow_note", input: { fact: "Ведёт блог про дизайн" } }] };
      return { toolCalls: [{ toolName: "flow_note", input: { field: niche.id, value: "Дизайн" } }] };
    };
    await startWith({ fieldIds: [niche.id, budget.id, callReady.id] });
    await say("Я дизайнер");
    await say("Ещё веду блог про дизайн");
    await deleteField(database.db, budget.id, kit.clock.now());
    await say("Мой бюджет 100 тысяч");

    const personRow = await kit.personOf(person);
    expect(personRow!.fieldValues).toEqual({ [niche.id]: "Дизайн" });
    expect(personRow!.facts.map((fact) => fact.text)).toEqual(["Ведёт блог про дизайн"]);
    const [passage] = await kit.passagesOf(person);
    expect(personRow!.facts[0]).toMatchObject({ source: passage!.id, chatId: passage!.chatId });
    expect(JSON.stringify(results[2])).toMatch(/не записано/i);
  });
});

describe("проверка ответа в мессенджере", () => {
  it("чужие слова: человеку уходит только исправленный текст, расход переписки — в журнале чата", async () => {
    kit.reply = (call) => {
      if (call.lastUserText.includes("Чужие слова:")) return { text: "Это часть истории вашей семьи." };
      return { text: "Это часть 歷史 вашей семьи." };
    };
    await startWith();
    const before = kit.textsTo(person).length;
    await say("Расскажите о роде");

    expect(kit.textsTo(person).slice(before)).toEqual(["Это часть истории вашей семьи."]);
    const [passage] = await kit.passagesOf(person);
    expect(await kit.chatStorage.sumUsage({ chatId: passage!.chatId, source: "answer_correction" })).toHaveLength(1);
    const stored = (await kit.chatStorage.listMessages(passage!.chatId)).filter((message) => message.role === "assistant").at(-1)!;
    expect(JSON.stringify(stored.parts)).not.toContain("歷史");
  });

  it("выдуманная ссылка вырезается, ссылка эксперта из инструкции остаётся", async () => {
    kit.reply = (call) => {
      if (call.lastUserText.includes("Ссылки не из инструкции:")) return { text: "Запись: https://irina.example.com/zapis." };
      return { text: "Запись: https://irina.example.com/zapis и https://fake-site.ru/form." };
    };
    await startWith({ instruction: "Ты консультант. Запись на разбор: https://irina.example.com/zapis" });
    const before = kit.textsTo(person).length;
    await say("Как записаться?");

    expect(kit.textsTo(person).slice(before)).toEqual(["Запись: https://irina.example.com/zapis."]);
  });
});
