import { readFile } from "node:fs/promises";
import { standardCatalog } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { bots } from "../channels/schema";
import type { ChannelAdapters } from "../channels/channel";
import { getLeadMagnet, listVersions } from "../lead-magnets";
import { createField, listFields } from "../people";
import { createVideo } from "../videos";
import { runLeadMagnetCli, type LeadMagnetCliDependencies } from "./run";

let database: TestDatabase;
let deps: LeadMagnetCliDependencies;

const adapters = {
  telegram: { entryLink: (bot: { username: string }, code: string) => `https://t.me/${bot.username}?start=${code}` },
} as unknown as ChannelAdapters;

beforeAll(async () => {
  database = await createTestDatabase();
  deps = {
    db: database.db,
    catalog: standardCatalog,
    adapters,
    allowedEmails: new Set(["expert@example.com"]),
  };
});

afterAll(async () => {
  await database.drop();
});

async function run(args: string[], stdin = "") {
  const result = await runLeadMagnetCli(args, stdin, deps);
  return { ...result, json: result.exitCode === 0 ? JSON.parse(result.output) : null };
}

const unique = () => Math.random().toString(36).slice(2, 8);

const finish = { type: "event", event: "tool", name: "finish_dialog" };

/** Сценарий из двух нод: «Знакомство» → «Предложение» → «Итог». */
function flowInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start: "intro",
    anyState: { exits: [{ id: "finish_dialog", when: finish, to: "final" }] },
    states: [
      { id: "intro", title: "Знакомство", instructions: "Узнать цель", exits: [{ id: "intro_done", when: { type: "judge", text: "Цель названа" }, to: "offer" }] },
      { id: "offer", title: "Предложение", instructions: "Предложить разбор", exits: [{ id: "offer_finish", when: finish, to: "final" }] },
      { id: "final", title: "Итог", instructions: "Разговор закончен", noSideQuestions: true },
    ],
    ...extra,
  };
}

function fullInput(overrides: Record<string, unknown> = {}) {
  return {
    name: `Разбор ${unique()}`,
    cardDescription: "Помогает выбрать первый шаг",
    instruction: "Ты помощник Анны. Узнай цель человека. Запись: https://example.com/zapis",
    firstMessage: "Здравствуйте! Я помощник Анны. Что хотите изменить?",
    endCondition: "Человек согласился на разбор",
    farewellMessage: "Спасибо! Анна напишет вам.",
    maxPersonMessages: 40,
    videos: [],
    flow: flowInput(),
    ...overrides,
  };
}

describe("experts и list", () => {
  it("experts — почты из списка допуска", async () => {
    const { exitCode, json } = await run(["experts"]);
    expect(exitCode).toBe(0);
    expect(json).toEqual([{ email: "expert@example.com" }]);
  });

  it("list с чужой почтой — понятная ошибка", async () => {
    const { exitCode, output } = await run(["list", "--expert", "stranger@example.com"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("stranger@example.com");
    expect(output).toMatch(/нет в списке/);
  });

  it("list показывает созданный лидмагнит", async () => {
    const created = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ name: "Для списка" })));
    const { exitCode, json } = await run(["list", "--expert", "Expert@Example.com"]);
    expect(exitCode).toBe(0);
    expect(json).toContainEqual(expect.objectContaining({ id: created.json.id, name: "Для списка", published: false }));
  });
});

describe("create", () => {
  it("создаёт лидмагнит целиком со сценарием, версия «agent»", async () => {
    const input = fullInput();
    const { exitCode, json } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(input));
    expect(exitCode).toBe(0);
    const lead = (await getLeadMagnet(database.db, json.id))!;
    expect(lead.draft).toMatchObject({
      name: input.name,
      firstMessage: input.firstMessage,
      endCondition: input.endCondition,
      farewellMessage: input.farewellMessage,
      maxPersonMessages: 40,
    });
    expect(lead.draft.flow.states.map((state) => state.id)).toEqual(["intro", "offer", "final"]);
    expect(lead.draft.flow).toMatchObject({ start: "intro", common: input.instruction, afterEnd: "silent" });
    // Старые поля повторяют сценарий: их ещё читает движок хода до переноса
    expect(lead.draft.instruction).toBe(input.instruction);
    const versions = await listVersions(database.db, json.id);
    expect(versions[0]!.source).toBe("agent");
    expect(lead.draftVersionId).toBe(versions[0]!.id);
    expect(json.versionId).toBe(versions[0]!.id);
    expect(json.settings.name).toBe(input.name);
    expect(lead.draft.viewsLinks).toBe(false);
  });

  it("без flow — сценарий нового лидмагнита: одна нода «Разговор»", async () => {
    const { exitCode, json } = await run(["create", "--expert", "expert@example.com"], JSON.stringify({ name: `Голый ${unique()}` }));
    expect(exitCode).toBe(0);
    expect((await getLeadMagnet(database.db, json.id))!.draft.flow.states.map((state) => state.id)).toEqual(["conversation", "final"]);
  });

  it("person_link_view у ноды — консультант смотрит ссылки; список инструментов сценария собирается сам", async () => {
    const flow = flowInput();
    (flow.states as Array<Record<string, unknown>>)[0]!.tools = ["person_link_view"];
    const on = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow })));
    expect(on.output).not.toMatch(/^Ошибка/);
    const draft = (await getLeadMagnet(database.db, on.json.id))!.draft;
    expect(draft.viewsLinks).toBe(true);
    expect(draft.flow.tools).toEqual(["person_link_view"]);
  });

  it("ошибка сценария — с путём внутри настроек, лидмагнит не создаётся", async () => {
    const before = (await run(["list"])).json.length;
    const flow = flowInput();
    (flow.states as Array<{ exits: Array<{ when: unknown }> }>)[0]!.exits[0]!.when = { type: "judge" };
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow })));
    expect(exitCode).toBe(1);
    expect(output).toContain("«flow.states[0].exits[0].when.text»");
    expect((await run(["list"])).json.length).toBe(before);
  });

  it("наша проверка сценария — с путём: две «Продажи»", async () => {
    const flow = flowInput();
    for (const state of (flow.states as Array<Record<string, unknown>>).slice(0, 2)) Object.assign(state, { tags: ["продажа"], tools: ["sale_answer"] });
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow })));
    expect(exitCode).toBe(1);
    expect(output).toMatch(/«flow\.states\[1\]»: .*только в одной ноде/);
  });

  it("основная инструкция — ключом instruction или flow.common, но не обоими сразу", async () => {
    const both = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow: { ...flowInput(), common: "Другое" } })));
    expect(both.exitCode).toBe(1);
    expect(both.output).toMatch(/instruction/);
    const common = await run(
      ["create", "--expert", "expert@example.com"],
      JSON.stringify(fullInput({ instruction: undefined, flow: { ...flowInput(), common: "Ты помощник Анны." } })),
    );
    expect(common.exitCode).toBe(0);
    expect((await getLeadMagnet(database.db, common.json.id))!.draft.instruction).toBe("Ты помощник Анны.");
  });

  it("без --expert — ошибка", async () => {
    const { exitCode, output } = await run(["create"], JSON.stringify(fullInput()));
    expect(exitCode).not.toBe(0);
    expect(output).toContain("--expert");
  });

  it("ошибка проверки настроек — лидмагнит не создаётся", async () => {
    const before = (await run(["list"])).json.length;
    const { exitCode, output } = await run(
      ["create", "--expert", "expert@example.com"],
      JSON.stringify(fullInput({ firstMessage: "Привет, {имя}!" })),
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain("{имя}");
    expect((await run(["list"])).json.length).toBe(before);
  });

  it("неизвестный ключ и неверный тип — понятный текст", async () => {
    const unknownKey = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ first_message: "x" })));
    expect(unknownKey.exitCode).not.toBe(0);
    expect(unknownKey.output).toContain("first_message");

    const wrongType = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ maxPersonMessages: "много" })));
    expect(wrongType.exitCode).not.toBe(0);
    expect(wrongType.output).toContain("maxPersonMessages");
  });

  it("ключи «//» — пояснения, их пропускают и в сценарии, и в карточке", async () => {
    const flow: Record<string, unknown> = { ...flowInput(), "//": "сценарий", clientCard: [{ "//": "поле", name: `С пояснением ${unique()}`, type: "text", about: "" }] };
    (flow.states as Array<Record<string, unknown>>)[0]!["//"] = "нода";
    const input = { ...fullInput({ flow }), "//": "пояснение", "//name": "пояснение" };
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(input));
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
  });

  it("шаблон docs/lead-magnet-template.json создаётся как есть", async () => {
    const template = await readFile(new URL("../../../docs/lead-magnet-template.json", import.meta.url), "utf8");
    const { exitCode, output, json } = await run(["create", "--expert", "expert@example.com"], template);
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    expect(json.settings.flow.schedule).toMatchObject({ lengthDays: 3, dayStart: "09:00" });
    expect(json.settings.flow.clientCard.map((field: { name: string }) => field.name)).toEqual(["Тема курса", "Продажи курса"]);
    const sale = json.settings.flow.states.filter((state: { tags?: string[] }) => state.tags?.includes("продажа"));
    expect(sale).toHaveLength(1);
  });

  it("«Твоё первое приложение» (docs/lead-magnets/first-app.json) создаётся как есть, прощание при сроке пишет модель", async () => {
    const file = await readFile(new URL("../../../docs/lead-magnets/first-app.json", import.meta.url), "utf8");
    const { exitCode, output, json } = await run(["create", "--expert", "expert@example.com"], file);
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    const { flow } = (await getLeadMagnet(database.db, json.id))!.draft;
    expect(flow.states.map((state) => state.title)).toEqual(["Идея", "Сборка", "Результат", "Курс", "Итог", "Срок вышел"]);
    expect(flow.schedule).toMatchObject({
      lengthDays: 3,
      deadlineState: "deadline",
      dayStart: "09:00",
      farewellOnDeadline: true,
    });
    // Прощание по сроку пишет Василий по разговору: отказавшемуся — без курса, поэтому готового текста нет
    expect(flow.schedule?.farewellText).toBeUndefined();
    expect(flow.states.find((state) => state.id === "deadline")?.instructions).toContain("https://school.example.com/ai_agent_course");
    // Цель ноды — первая строка инструкции, а не повтор названия
    for (const state of flow.states) expect(state.instructions.split("\n")[0]).not.toBe(state.title);
    expect(flow.sideTasks?.map((task) => task.field)).toEqual(flow.sideTasks?.map(() => expect.stringMatching(/^[0-9a-f-]{36}$/)));
  });

  it("не JSON на входе — понятная ошибка", async () => {
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], "{ не json");
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/JSON/);
  });

  it("неизвестная модель — ошибка", async () => {
    const { exitCode, output } = await run(
      ["create", "--expert", "expert@example.com"],
      JSON.stringify(fullInput({ providerId: "together", modelId: "no-such-model" })),
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain("no-such-model");
  });
});

describe("старый формат: этапы и программа", () => {
  const legacy = {
    name: `Старый ${Math.random()}`,
    instruction: "Ты помощник.",
    stages: [
      { name: "Идея", instruction: "Помоги выбрать", transitionCondition: "Выбрал" },
      { name: "Продажа", instruction: "Предложи интенсив", transitionCondition: "", startDay: 3, isSale: true },
    ],
    program: { days: 3 },
  };

  it("create переводит этапы и программу в сценарий; сами этапы остаются для отката", async () => {
    const { exitCode, output, json } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(legacy));
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    const draft = (await getLeadMagnet(database.db, json.id))!.draft;
    expect(draft.stages.map((stage) => stage.name)).toEqual(["Идея", "Продажа"]);
    expect(draft.program?.days).toBe(3);
    expect(draft.flow.schedule?.lengthDays).toBe(3);
    // Срок в «Продажу» — день программы, а не «нода длится 2 дня»
    expect(draft.flow.states[0]!.exits).toContainEqual(expect.objectContaining({ when: { type: "timer", from: "program_day", day: 3 } }));
    expect(draft.flow.common).toBe("Ты помощник.");
  });

  it("update старыми ключами — ошибка с подсказкой про flow: правка не сотрёт сценарий", async () => {
    const lead = (await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput()))).json;
    const values = { stages: legacy.stages, program: legacy.program, fields: [], viewsLinks: true };
    for (const [key, value] of Object.entries(values)) {
      const { exitCode, output } = await run(["update", lead.id], JSON.stringify({ [key]: value }));
      expect(exitCode).toBe(1);
      expect(output).toContain(key);
      expect(output).toMatch(/flow/);
    }
  });

  it("flow вместе со старыми ключами — ошибка", async () => {
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], JSON.stringify({ ...fullInput(), stages: legacy.stages }));
    expect(exitCode).toBe(1);
    expect(output).toMatch(/stages/);
  });
});

describe("поля карточки по названию", () => {
  it("существующее поле подключается, новое создаётся", async () => {
    const existing = await createField(database.db, { name: `Цель ${unique()}`, type: "text", description: "Чего хочет" });
    const newName = `Бюджет ${unique()}`;
    const clientCard = [existing.name.toUpperCase(), { name: newName, type: "choice", options: ["до 10 тысяч", "больше"], about: "Сколько готов вложить" }];
    const { exitCode, output, json } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow: { ...flowInput(), clientCard } })));
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    const dictionary = await listFields(database.db);
    const created = dictionary.find((field) => field.name === newName)!;
    expect(created).toMatchObject({ type: "choice", options: ["до 10 тысяч", "больше"], description: "Сколько готов вложить" });
    const lead = (await getLeadMagnet(database.db, json.id))!;
    expect(lead.draft.flow.clientCard.map((field) => field.id)).toEqual([existing.id, created.id]);
    expect(lead.draft.fieldIds).toEqual([existing.id, created.id]);
    expect(json.settings.flow.clientCard).toEqual([
      { name: existing.name, type: "text", about: "Чего хочет" },
      { name: newName, type: "choice", options: ["до 10 тысяч", "больше"], about: "Сколько готов вложить" },
    ]);
  });

  it("поля в попутных задачах, «узнать здесь» и условиях по данным — тоже по названию", async () => {
    const city = await createField(database.db, { name: `Город ${unique()}`, type: "text", description: "Где живёт" });
    const flow: Record<string, unknown> = {
      ...flowInput({ schedule: { dayStart: "09:00", lengthDays: 3, deadlineState: "final" } }),
      clientCard: [city.name],
      sideTasks: [{ text: "Узнать город", field: city.name }],
    };
    const intro = (flow.states as Array<Record<string, unknown>>)[0]!;
    intro.learn = [city.name];
    intro.exits = [{ id: "intro_city", when: { type: "data", field: city.name, op: "filled" }, to: "offer" }];
    const { exitCode, output, json } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow })));
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    const saved = (await getLeadMagnet(database.db, json.id))!.draft.flow;
    expect(saved.sideTasks![0]!.field).toBe(city.id);
    expect(saved.states[0]!.learn).toEqual([city.id]);
    expect(saved.states[0]!.exits[0]!.when).toMatchObject({ field: city.id });
    // show — обратно названиями
    expect(json.settings.flow.sideTasks[0].field).toBe(city.name);
    expect(json.settings.flow.states[0].learn).toEqual([city.name]);
    expect(json.settings.flow.states[0].exits[0].when.field).toBe(city.name);
  });

  it("поле попутной задачи не из карточки — ошибка с путём", async () => {
    const flow = { ...flowInput(), sideTasks: [{ text: "Узнать", field: "Нет такого поля" }] };
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow })));
    expect(exitCode).toBe(1);
    expect(output).toContain("«flow.sideTasks[0]»");
  });

  it("неизвестное поле без типа — ошибка, ничего не создано", async () => {
    const name = `Без типа ${unique()}`;
    const { exitCode, output } = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ flow: { ...flowInput(), clientCard: [name] } })));
    expect(exitCode).not.toBe(0);
    expect(output).toContain(name);
    expect(output).toContain("type");
  });

  it("тип не совпадает с полем из словаря — ошибка", async () => {
    const existing = await createField(database.db, { name: `Возраст ${unique()}`, type: "number", description: "" });
    const { exitCode, output } = await run(
      ["create", "--expert", "expert@example.com"],
      JSON.stringify(fullInput({ flow: { ...flowInput(), clientCard: [{ name: existing.name, type: "text" }] } })),
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain(existing.name);
  });

  it("сбой после создания поля откатывает и поле", async () => {
    const name = `Откатится ${unique()}`;
    const { exitCode } = await run(
      ["create", "--expert", "expert@example.com"],
      JSON.stringify(fullInput({ flow: { ...flowInput(), clientCard: [{ name, type: "text" }] }, farewellMessage: "Пока, {имя}" })),
    );
    expect(exitCode).not.toBe(0);
    expect((await listFields(database.db)).some((field) => field.name === name)).toBe(false);
  });
});

describe("ролики по названию", () => {
  it("находит ролик архива, ненайденный — ошибка со списком", async () => {
    const title = `Как начать ${unique()}`;
    const video = await createVideo(database.db, { title, url: "https://youtu.be/dQw4w9WgXcQ", description: "Первый шаг" });
    const ok = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ videos: [` ${title.toLowerCase()} `] })));
    expect(ok.exitCode).toBe(0);
    expect((await getLeadMagnet(database.db, ok.json.id))!.draft.videoIds).toEqual([video.id]);
    expect(ok.json.settings.videos).toEqual([title]);

    const missing = await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput({ videos: ["Нет такого ролика"] })));
    expect(missing.exitCode).not.toBe(0);
    expect(missing.output).toContain("Нет такого ролика");
    expect(missing.output).toContain(title);
  });

  it("videos — список архива", async () => {
    const { exitCode, json } = await run(["videos"]);
    expect(exitCode).toBe(0);
    expect(json[0]).toEqual(expect.objectContaining({ title: expect.any(String), description: expect.any(String) }));
  });
});

describe("show и update", () => {
  async function created(overrides: Record<string, unknown> = {}) {
    return (await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput(overrides)))).json;
  }

  it("show — сценарий без значений по умолчанию, поля и ролики по названиям", async () => {
    const field = await createField(database.db, { name: `Ниша ${unique()}`, type: "text", description: "Чем занимается" });
    const lead = await created({ flow: { ...flowInput(), clientCard: [field.name] } });
    const { exitCode, json } = await run(["show", lead.id]);
    expect(exitCode).toBe(0);
    expect(json).toMatchObject({ id: lead.id, published: false });
    expect(json.settings.flow.clientCard).toEqual([{ name: field.name, type: "text", about: "Чем занимается" }]);
    expect(json.settings.flow.states[0]).toEqual(expect.objectContaining({ id: "intro", title: "Знакомство" }));
    expect(json.settings.flow.states[0]).not.toHaveProperty("kind");
    expect(json.settings.flow.common).toBe(fullInput().instruction);
    for (const key of ["fieldIds", "videoIds", "stages", "program", "viewsLinks", "instruction", "fields"]) expect(json.settings).not.toHaveProperty(key);
  });

  it("show несуществующего — ошибка", async () => {
    const missing = await run(["show", "00000000-0000-4000-8000-000000000000"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.output).toMatch(/не найден/);
    const notUuid = await run(["show", "abc"]);
    expect(notUuid.exitCode).not.toBe(0);
    expect(notUuid.output).toMatch(/не найден/);
  });

  it("update без flow не трогает сценарий; версия «agent», заметка конструктору", async () => {
    const lead = await created();
    const before = (await getLeadMagnet(database.db, lead.id))!.draft.flow;
    const { exitCode, json } = await run(["update", lead.id], JSON.stringify({ firstMessage: "Добрый день! Я помощник Анны." }));
    expect(exitCode).toBe(0);
    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draft.firstMessage).toBe("Добрый день! Я помощник Анны.");
    expect(after.draft.flow).toEqual(before);
    const versions = await listVersions(database.db, lead.id);
    expect(versions[0]!.source).toBe("agent");
    expect(json.versionId).toBe(versions[0]!.id);
    expect(after.pendingManualEdits.map((note) => note.text).join("\n")).toContain("Первое сообщение");
  });

  it("update с flow заменяет сценарий целиком; заметка конструктору по нодам", async () => {
    const lead = await created();
    const flow = flowInput();
    (flow.states as Array<Record<string, unknown>>)[1]!.instructions = "Предложить разбор на 30 минут";
    const { exitCode, output } = await run(["update", lead.id], JSON.stringify({ flow }));
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    const after = (await getLeadMagnet(database.db, lead.id))!;
    expect(after.draft.flow.states[1]!.instructions).toBe("Предложить разбор на 30 минут");
    // «Общее» не передано — остаётся прежним
    expect(after.draft.flow.common).toBe(fullInput().instruction);
    expect(after.pendingManualEdits.map((note) => note.text).join("\n")).toContain("Нода «Предложение»: инструкция");
  });

  it("update instruction пишет «Общее» сценария", async () => {
    const lead = await created();
    await run(["update", lead.id], JSON.stringify({ instruction: "Ты помощник Бориса." }));
    const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    expect(draft.flow.common).toBe("Ты помощник Бориса.");
    expect(draft.instruction).toBe("Ты помощник Бориса.");
  });

  it("ошибка в update — черновик и история прежние", async () => {
    const lead = await created();
    const versionsBefore = (await listVersions(database.db, lead.id)).length;
    const { exitCode, output } = await run(["update", lead.id], JSON.stringify({ name: "  " }));
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/название/);
    expect((await listVersions(database.db, lead.id)).length).toBe(versionsBefore);
  });

  it("пустой update — ошибка", async () => {
    const lead = await created();
    const { exitCode } = await run(["update", lead.id], "{}");
    expect(exitCode).not.toBe(0);
  });

  it("вывод show подходит как вход update после правки", async () => {
    const field = await createField(database.db, { name: `Опыт ${unique()}`, type: "number", description: "Лет" });
    const lead = await created({ flow: { ...flowInput(), clientCard: [field.name], sideTasks: [{ text: "Узнать опыт", field: field.name }] } });
    const shown = (await run(["show", lead.id])).json;
    const { exitCode, output } = await run(["update", lead.id], JSON.stringify({ ...shown.settings, cardDescription: "Новое описание" }));
    expect(output).not.toMatch(/^Ошибка/);
    expect(exitCode).toBe(0);
    const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    expect(draft.cardDescription).toBe("Новое описание");
    expect(draft.flow.sideTasks![0]!.field).toBe(field.id);
  });
});

describe("links, bots и publish", () => {
  it("публикует через привязанного бота и отдаёт ссылку запуска", async () => {
    const lead = (await run(["create", "--expert", "expert@example.com"], JSON.stringify(fullInput()))).json;
    const [bot] = await database.db
      .insert(bots)
      .values({
        channel: "telegram",
        title: "Помощник",
        username: `helper_${unique()}_bot`,
        externalId: unique(),
        tokenEncrypted: "x",
        webhookSecret: unique(),
      })
      .returning();

    const listed = await run(["bots"]);
    expect(listed.json).toContainEqual(expect.objectContaining({ id: bot!.id, channel: "telegram", username: bot!.username }));

    const before = await run(["links", lead.id]);
    expect(before.json).toMatchObject({ published: false, main: [] });

    const noBot = await run(["publish", lead.id]);
    expect(noBot.exitCode).not.toBe(0);
    expect(noBot.output).toMatch(/бот/);

    const published = await run(["publish", lead.id, "--telegram", bot!.id]);
    expect(published.exitCode).toBe(0);
    expect(published.json.published).toBe(true);
    expect(published.json.main[0].url).toMatch(new RegExp(`^https://t\\.me/${bot!.username}\\?start=`));

    const links = await run(["links", lead.id]);
    expect(links.json.main).toEqual(published.json.main);
  });
});

describe("разбор команды", () => {
  it("неизвестная команда — подсказка", async () => {
    const { exitCode, output } = await run(["delete"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("experts");
  });
});
