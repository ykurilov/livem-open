import { APP_STATE_PART_TYPE, createInMemoryChatStorage, type ChatStorage, type StoredMessage } from "@ykurilov/agent-chat-core";
import { FLOW_STATE_KEY } from "@ykurilov/agent-chat-flows";
import { asSchema } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, listVersions, saveDraft, setPreviewChat, type LeadMagnet } from "../lead-magnets";
import { FINAL_STATE_ID, LEAD_MAGNET_TOOLS, PROGRAM_NUDGES, SALE_TAG } from "../flows";
import { createField, listFields } from "../people";
import {
  CONSTRUCTOR_TOOL_NAMES,
  createConstructorTools,
  editLeadMagnet,
  editLeadMagnetInput,
  readTestConversation,
  viewLeadMagnet,
  type ConstructorToolDependencies,
} from "./tools";

let database: TestDatabase;
let chatStorage: ChatStorage;
let deps: ConstructorToolDependencies;
let lead: LeadMagnet;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  chatStorage = createInMemoryChatStorage();
  deps = { db: database.db, chatStorage };
  lead = await createLeadMagnet(database.db, { name: `Лидмагнит ${Math.random()}` });
  lead = await getLeadMagnet(database.db, lead.id).then((found) => found!);
  const instruction = "Ты консультант. Спроси про цель. Не продавай в лоб.";
  const withText = await saveDraft(
    database.db,
    lead.id,
    {
      ...lead.draft,
      instruction,
      flow: { ...lead.draft.flow, common: instruction },
      firstMessage: "Привет! Расскажите о себе.",
      endCondition: "Человек выбрал шаг",
    },
    "manual",
  );
  lead = { ...lead, draft: withText.settings, draftVersionId: withText.id };
});

async function currentDraft() {
  return (await getLeadMagnet(database.db, lead.id))!.draft;
}

describe("набор инструментов конструктора", () => {
  it("ровно три инструмента", () => {
    expect([...CONSTRUCTOR_TOOL_NAMES].sort()).toEqual(["edit_lead_magnet", "read_test_conversation", "view_lead_magnet"]);
    expect(Object.keys(createConstructorTools(deps, lead.id)).sort()).toEqual([...CONSTRUCTOR_TOOL_NAMES].sort());
  });
});

describe("edit_lead_magnet", () => {
  it("set меняет поле и создаёт версию «constructor»", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "firstMessage", value: "Коротко: привет!" }] });
    expect(result.ok).toBe(true);
    expect((await currentDraft()).firstMessage).toBe("Коротко: привет!");
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("constructor");
  });

  it("set для предела сообщений принимает число", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "maxPersonMessages", value: 30 }] });
    expect(result.ok).toBe(true);
    expect((await currentDraft()).maxPersonMessages).toBe(30);
  });

  it("все изменения одного вызова — одна версия", async () => {
    const before = (await listVersions(database.db, lead.id)).length;
    await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "set", field: "name", value: "Новое имя" },
        { op: "set", field: "farewellMessage", value: "Пока!" },
      ],
    });
    expect(await listVersions(database.db, lead.id)).toHaveLength(before + 1);
  });

  it("replace_fragment меняет кусок текста, который встречается ровно один раз", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "replace_fragment", field: "instruction", find: "Спроси про цель.", replace: "Спроси про цель и сроки." }],
    });
    expect(result.ok).toBe(true);
    const draft = await currentDraft();
    expect(draft.flow.common).toBe("Ты консультант. Спроси про цель и сроки. Не продавай в лоб.");
    expect(draft.instruction).toBe(draft.flow.common);
  });

  it("set основной инструкции пишет «Общее» сценария", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "instruction", value: "Ты помощник Анны." }] });
    const draft = await currentDraft();
    expect(draft.flow.common).toBe("Ты помощник Анны.");
    expect(draft.instruction).toBe("Ты помощник Анны.");
  });

  it("replace_fragment: кусок не найден — ошибка, ничего не изменено", async () => {
    const before = (await listVersions(database.db, lead.id)).length;
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "replace_fragment", field: "instruction", find: "нет такого", replace: "x" }],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/ровно 1 раз/);
    expect(await listVersions(database.db, lead.id)).toHaveLength(before);
  });

  it("replace_fragment: кусок встречается дважды — ошибка", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "endCondition", value: "да и да" }] });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "replace_fragment", field: "endCondition", find: "да", replace: "нет" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ровно 1 раз/);
    expect((await currentDraft()).endCondition).toBe("да и да");
  });

  it("replace_fragment: перекрывающиеся вхождения тоже считаются («aa» в «aaa» — два раза)", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "farewellMessage", value: "aaa" }] });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "replace_fragment", field: "farewellMessage", find: "aa", replace: "b" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ровно 1 раз/);
    expect((await currentDraft()).farewellMessage).toBe("aaa");
  });

  it("replace_fragment — только для инструкции, первого сообщения, условия завершения и прощания", () => {
    for (const field of ["instruction", "firstMessage", "endCondition", "farewellMessage"])
      expect(editLeadMagnetInput.safeParse({ changes: [{ op: "replace_fragment", field, find: "a", replace: "b" }] }).success).toBe(true);
    for (const field of ["name", "cardDescription"])
      expect(editLeadMagnetInput.safeParse({ changes: [{ op: "replace_fragment", field, find: "a", replace: "b" }] }).success).toBe(false);
  });

  it("поля: подключить существующее, отключить", async () => {
    const field = await createField(database.db, { name: `Ниша ${Math.random()}`, type: "text", description: "Чем занимается" });
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "attach_field", fieldId: field.id }] });
    let draft = await currentDraft();
    expect(draft.flow.clientCard).toEqual([expect.objectContaining({ id: field.id, name: field.name, about: "Чем занимается", type: "text" })]);
    expect(draft.fieldIds).toEqual([field.id]);
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "detach_field", fieldId: field.id }] });
    draft = await currentDraft();
    expect(draft.flow.clientCard).toEqual([]);
    expect(draft.fieldIds).toEqual([]);
  });

  it("поля: подключить несуществующее — ошибка", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "attach_field", fieldId: "00000000-0000-4000-8000-000000000000" }],
    });
    expect(result.ok).toBe(false);
  });

  it("create_field заводит поле в словаре и подключает его", async () => {
    const name = `Бюджет ${Math.random()}`;
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "create_field", name, type: "choice", options: ["до 10 тыс.", "больше"], description: "Сколько готов вложить" }],
    });
    expect(result.ok).toBe(true);
    const created = (await listFields(database.db)).find((field) => field.name === name);
    expect(created).toMatchObject({ type: "choice", options: ["до 10 тыс.", "больше"] });
    expect((await currentDraft()).flow.clientCard.map((field) => field.id)).toEqual([created!.id]);
  });

  it("create_field: ошибка в соседнем изменении — поле в словаре тоже не создано", async () => {
    const name = `Откатится ${Math.random()}`;
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "create_field", name, type: "text", description: "x" },
        { op: "remove_state", stateId: "нет-такого" },
      ],
    });
    expect(result.ok).toBe(false);
    expect((await listFields(database.db)).some((field) => field.name === name)).toBe(false);
  });

  it("create_field с занятым именем (без учёта регистра) — ошибка", async () => {
    const name = `Город ${Math.random()}`;
    await createField(database.db, { name, type: "text", description: "x" });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "create_field", name: name.toUpperCase(), type: "text", description: "y" }],
    });
    expect(result.ok).toBe(false);
  });

  it("схема не принимает провайдера, модель и уровень рассуждения", () => {
    for (const field of ["providerId", "modelId", "reasoning"]) {
      expect(editLeadMagnetInput.safeParse({ changes: [{ op: "set", field, value: "x" }] }).success).toBe(false);
    }
    expect(
      editLeadMagnetInput.safeParse({ changes: [{ op: "set", field: "name", value: "x", modelId: "gpt" }] }).success,
    ).toBe(false);
    expect(editLeadMagnetInput.safeParse({ changes: [{ op: "publish" }] }).success).toBe(false);
    expect(editLeadMagnetInput.safeParse({ changes: [{ op: "set", field: "name", value: "x" }] }).success).toBe(true);
  });

  it("поле с ошибкой в имени — ошибка называет правильное имя", () => {
    const set = editLeadMagnetInput.safeParse({ changes: [{ op: "set", field: "first_message", value: "x" }] });
    expect(set.error?.message).toContain("Поле называется «firstMessage», а не «first_message»");
    const fragment = editLeadMagnetInput.safeParse({
      changes: [{ op: "replace_fragment", field: "farewell_message", find: "a", replace: "b" }],
    });
    expect(fragment.error?.message).toContain("Поле называется «farewellMessage», а не «farewell_message»");
  });
});

describe("прощание — текст для человека, а не указание консультанту", () => {
  const yogaDirection = "Коротко попрощайся: порадуйся, что человек придёт на занятие, и напомни, что по ссылке он сам выберет день и время.";

  it("указание в прощании — отказ с подсказкой: прощание уходит человеку дословно; черновик не меняется", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "farewellMessage", value: yogaDirection }] });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/«Коротко попрощайся».*дословно.*от лица помощника.*инструкци/s);
    expect((await getLeadMagnet(deps.db, lead.id))!.draft.farewellMessage).not.toBe(yogaDirection);
  });

  it("прощание «Передал Кириллу» — отказ с подсказкой без выдуманных действий эксперта", async () => {
    const handoff = "Отлично! Передал Кириллу — он подтвердит время и позвонит вам по видео. До встречи!";
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "farewellMessage", value: handoff }] });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/«Передал».*ничего не передаёт.*только по подтверждённым условиям/s);
    expect((await getLeadMagnet(deps.db, lead.id))!.draft.farewellMessage).not.toBe(handoff);
  });

  it("обычное прощание сохраняется; старое прощание-указание не мешает другим правкам", async () => {
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "farewellMessage", value: "Отлично! Анна ждёт вас на занятии. До встречи!" }] })).toMatchObject({ ok: true });
    const current = (await getLeadMagnet(deps.db, lead.id))!;
    await saveDraft(deps.db, lead.id, { ...current.draft, farewellMessage: yogaDirection }, "manual");
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "name", value: "Йога" }] })).toMatchObject({ ok: true });
  });
});

describe("ссылка с подставленным текстом", () => {
  const textLink = { template: "https://appstudio.example.com/?idea={text}&type={type}", types: ["game", "app"], maxTextLength: 450 };

  it("set_text_link сохраняет шаблон, null убирает; неверный шаблон — отказ с причиной", async () => {
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "set_text_link", textLink }] })).toMatchObject({ ok: true });
    expect((await getLeadMagnet(deps.db, lead.id))!.draft.textLink).toEqual(textLink);
    const wrong = await editLeadMagnet(deps, lead.id, { changes: [{ op: "set_text_link", textLink: { ...textLink, template: "https://appstudio.example.com/{text}" } }] });
    expect(wrong).toMatchObject({ ok: false });
    if (!wrong.ok) expect(wrong.error).toMatch(/\{text\}/);
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "set_text_link", textLink: null }] })).toMatchObject({ ok: true });
    expect((await getLeadMagnet(deps.db, lead.id))!.draft.textLink).toBeUndefined();
  });
});

describe("схема edit_lead_magnet для модели", () => {
  const schema = () => asSchema(createConstructorTools(deps, lead.id).edit_lead_magnet!.inputSchema);
  const setName = [{ op: "set", field: "name", value: "Марафон" }];

  it("модель видит ту же схему, что и раньше: changes — массив", async () => {
    expect(await schema().jsonSchema).toEqual(await asSchema(editLeadMagnetInput).jsonSchema);
  });

  it("changes строкой схема отклоняет: строку разбирает и чинит ядро SDK, вызов проверяется заново", async () => {
    expect((await schema().validate!({ changes: JSON.stringify(setName) })).success).toBe(false);
  });

  it("неверные правки схема пропускает до инструмента: короткую ошибку модели даёт он", async () => {
    expect((await schema().validate!({ changes: setName })).success).toBe(true);
    expect((await schema().validate!({ changes: [{ op: "publish" }] })).success).toBe(true);
    expect((await schema().validate!("не объект")).success).toBe(false);
  });
});

/** Сценарий из двух нод: «Знакомство» → «Цель», из «Цели» — в «Итог». */
function twoStates(): Record<string, unknown> {
  return {
    start: "intro",
    anyState: { exits: [{ id: "finish_dialog", when: { type: "event", event: "tool", name: "finish_dialog" }, to: FINAL_STATE_ID }] },
    states: [
      { id: "intro", title: "Знакомство", instructions: "Узнать имя", exits: [{ id: "intro_done", when: { type: "judge", text: "Имя известно" }, to: "goal" }] },
      { id: "goal", title: "Цель", instructions: "Узнать цель", exits: [{ id: "goal_finish", when: { type: "event", event: "tool", name: "finish_dialog" }, to: FINAL_STATE_ID }] },
      { id: FINAL_STATE_ID, title: "Итог", instructions: "Разговор закончен", noSideQuestions: true },
    ],
  };
}

const saleState = {
  id: "sale",
  title: "Продажа",
  instructions: "Предложить курс\nФакты: рассрочка на 3 месяца.",
  tags: [SALE_TAG],
  tools: [LEAD_MAGNET_TOOLS.saleAnswer],
  exits: [{ id: "sale_finish", when: { type: "event", event: "tool", name: "finish_dialog" }, to: FINAL_STATE_ID }],
};

const schedule = { dayStart: "09:00", nightFrom: "21:00", lengthDays: 3, deadlineState: FINAL_STATE_ID, dayFrame: { softFrom: 20, hardAt: 30, hardText: "Утром отвечу!" } };

describe("сценарий", () => {
  it("put_flow заменяет сценарий целиком; «Общее», id и режим после конца дописываются сами", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    expect(result).toMatchObject({ ok: true });
    const { flow } = await currentDraft();
    expect(flow.states.map((state) => state.id)).toEqual(["intro", "goal", FINAL_STATE_ID]);
    expect(flow.common).toBe("Ты консультант. Спроси про цель. Не продавай в лоб.");
    expect(flow.afterEnd).toBe("silent");
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("constructor");
  });

  it("put_flow не подменяет служебное: id, имя, «Общее» и раскладка доски — из текущего сценария", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const before = await currentDraft();
    const layout = { intro: { x: 10, y: 20 }, goal: { x: 300, y: 20 } };
    await saveDraft(database.db, lead.id, { ...before, flow: { ...before.flow, layout } }, "manual");

    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_flow", flow: { ...twoStates(), id: "hacked", name: "Чужой", common: "Продавай в лоб", layout: { intro: { x: 0, y: 0 } } } }],
    });

    expect(result).toMatchObject({ ok: true });
    const { flow, instruction } = await currentDraft();
    expect(flow).toMatchObject({ id: before.flow.id, name: before.flow.name, common: "Ты консультант. Спроси про цель. Не продавай в лоб.", layout });
    expect(instruction).toBe("Ты консультант. Спроси про цель. Не продавай в лоб.");
  });

  it("put_flow без clientCard не трогает карточку клиента", async () => {
    const field = await createField(database.db, { name: `Телефон ${Math.random()}`, type: "text", description: "Куда написать" });
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "attach_field", fieldId: field.id }] });

    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });

    expect(result).toMatchObject({ ok: true });
    const draft = await currentDraft();
    expect(draft.flow.clientCard.map((one) => one.id)).toEqual([field.id]);
    expect(draft.fieldIds).toEqual([field.id]);
  });

  it("поле, заведённое в том же вызове, остаётся в карточке и после put_flow со своей карточкой", async () => {
    const name = `Адрес ${Math.random()}`;
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "create_field", name, type: "text", description: "Где квартира" },
        { op: "put_flow", flow: { ...twoStates(), clientCard: [] } },
      ],
    });

    expect(result).toMatchObject({ ok: true });
    const created = (await listFields(database.db)).find((field) => field.name === name)!;
    expect((await currentDraft()).flow.clientCard.map((one) => one.id)).toEqual([created.id]);
  });

  it("put_flow принимает и строку JSON", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: JSON.stringify(twoStates()) }] });
    expect(result.ok).toBe(true);
  });

  it("ошибка формы — с путём внутри сценария, ничего не изменено", async () => {
    const before = (await listVersions(database.db, lead.id)).length;
    const flow = twoStates();
    (flow.states as Array<{ exits?: Array<{ when: unknown }> }>)[0]!.exits![0]!.when = { type: "judge" };
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("«flow.states[0].exits[0].when.text»");
    expect(await listVersions(database.db, lead.id)).toHaveLength(before);
  });

  it("ошибка связей — с путём; недостижимая нода не сохраняется", async () => {
    const flow = twoStates();
    (flow.states as Array<{ exits?: unknown[] }>)[0]!.exits = [];
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/«flow\.states\[1\]»/);
  });

  it("put_state добавляет ноду после указанной и заменяет по id; инструменты сценария подтягиваются сами", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "put_state", state: saleState, afterStateId: "goal" },
        {
          op: "put_state",
          state: { id: "goal", title: "Цель", instructions: "Узнать цель", exits: [{ id: "goal_done", when: { type: "judge", text: "Цель ясна" }, to: "sale" }] },
        },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    const { flow } = await currentDraft();
    expect(flow.states.map((state) => state.id)).toEqual(["intro", "goal", "sale", FINAL_STATE_ID]);
    expect(flow.states[1]!.exits).toEqual([{ id: "goal_done", when: { type: "judge", text: "Цель ясна" }, to: "sale" }]);
    expect(flow.states[2]).toMatchObject({ kind: "state", firstMessage: null, tags: [SALE_TAG] });
    expect(flow.tools).toEqual([LEAD_MAGNET_TOOLS.saleAnswer]);
  });

  it("наши проверки: вторая «Продажа» — ошибка с путём", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const goal = { ...saleState, id: "goal", title: "Цель" };
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "put_state", state: { ...goal, exits: [{ id: "goal_done", when: { type: "judge", text: "Ясно" }, to: "sale" }] } },
        { op: "put_state", state: saleState },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/«flow\.states\[\d\]»: «.+»: «Продажа» — только в одной ноде/);
  });

  it("remove_state убирает ноду и выходы в неё; стартовую не убирает", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "remove_state", stateId: "goal" },
        {
          op: "put_state",
          state: { id: "intro", title: "Знакомство", instructions: "Узнать имя", exits: [{ id: "intro_finish", when: { type: "event", event: "tool", name: "finish_dialog" }, to: FINAL_STATE_ID }] },
        },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    expect((await currentDraft()).flow.states.map((state) => state.id)).toEqual(["intro", FINAL_STATE_ID]);

    const start = await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_state", stateId: "intro" }] });
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.error).toMatch(/set_start/);
  });

  it("remove_state: в ноду вёл единственный выход — нода без выходов, ошибка проверки, ничего не изменено", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_state", stateId: "goal" }] });
    // «Знакомство» осталось без выходов: оно стало конечной нодой, а «Итог» — недостижимым
    expect(result.ok).toBe(false);
    expect((await currentDraft()).flow.states).toHaveLength(3);
  });

  it("set_start меняет стартовую ноду; неизвестная — ошибка", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "set_start", stateId: "nowhere" }] })).toMatchObject({ ok: false });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "set_start", stateId: "goal" }, { op: "remove_state", stateId: "intro" }],
    });
    expect(result).toMatchObject({ ok: true });
    expect((await currentDraft()).flow.start).toBe("goal");
  });

  it("put_schedule включает «Дни и время» целиком, remove_schedule выключает и возвращает общие касания", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const on = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_schedule", schedule }] });
    expect(on).toMatchObject({ ok: true });
    expect((await currentDraft()).flow.schedule).toMatchObject({ lengthDays: 3, dayStart: "09:00", farewellOnDeadline: false });

    const off = await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_schedule" }] });
    expect(off).toMatchObject({ ok: true });
    const { flow } = await currentDraft();
    expect(flow.schedule).toBeUndefined();
    expect(flow.nudges?.giveUpAfter).toBeDefined();
  });

  it("put_schedule без касаний и потолка — умолчания программы: касания через 3 ч и потолок по дням «3, 2»", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_schedule", schedule }] });
    expect((await currentDraft()).flow.schedule).toMatchObject({ nudges: PROGRAM_NUDGES, firstMessages: { maxPerDayByDay: [3, 2] } });

    const own = { afterSilence: [{ amount: 5, unit: "h" as const }] };
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_schedule", schedule: { ...schedule, nudges: own } }] });
    expect((await currentDraft()).flow.schedule?.nudges).toEqual(own);
  });

  it("put_schedule: срок вне 2–14 — ошибка с путём", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_schedule", schedule: { ...schedule, lengthDays: 20 } }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("«flow.schedule.lengthDays»");
  });

  it("таймер «нода длится N дней» без «Дней и времени» — ошибка", async () => {
    const flow = twoStates();
    (flow.states as Array<{ exits: unknown[] }>)[0]!.exits.push({ id: "intro_days", when: { type: "timer", from: "state_days", days: 1 }, to: "goal" });
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow }] })).toMatchObject({ ok: false });
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: { ...flow, schedule } }] })).toMatchObject({ ok: true });
  });

  it("put_side_tasks: список целиком, id выдаётся сам; поле — из карточки", async () => {
    const field = await createField(database.db, { name: `Профессия ${Math.random()}`, type: "text", description: "Чем занимается" });
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "attach_field", fieldId: field.id },
        { op: "put_side_tasks", sideTasks: [{ text: "К слову узнать, чем занимается", field: field.id, when: "когда выбираете идею" }] },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    const [task] = (await currentDraft()).flow.sideTasks!;
    expect(task).toMatchObject({ text: "К слову узнать, чем занимается", field: field.id, maxAttempts: 2 });
    expect(task!.id).toEqual(expect.any(String));

    const unknown = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_side_tasks", sideTasks: [{ text: "x", field: "нет-поля" }] }] });
    expect(unknown.ok).toBe(false);
  });

  it("replace_fragment по инструкции ноды", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "replace_fragment", stateId: "goal", find: "Узнать цель", replace: "Узнать цель и срок" }] });
    expect(result).toMatchObject({ ok: true });
    expect((await currentDraft()).flow.states[1]!.instructions).toBe("Узнать цель и срок");
    const missing = await editLeadMagnet(deps, lead.id, { changes: [{ op: "replace_fragment", stateId: "nowhere", find: "a", replace: "b" }] });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/Нет ноды/) });
  });

  it("put_flow с полем карточки не из словаря — ошибка с подсказкой", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_flow", flow: { ...twoStates(), clientCard: ["00000000-0000-4000-8000-000000000000"] } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/create_field|attach_field/);
  });

  it("detach_field поля, на которое ссылается попутная задача, — ошибка проверки", async () => {
    const field = await createField(database.db, { name: `Город ${Math.random()}`, type: "text", description: "Где живёт" });
    await editLeadMagnet(deps, lead.id, {
      changes: [
        { op: "attach_field", fieldId: field.id },
        { op: "put_side_tasks", sideTasks: [{ text: "Узнать город", field: field.id }] },
      ],
    });
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "detach_field", fieldId: field.id }] })).toMatchObject({ ok: false });
  });

  it("старых операций этапов и программы больше нет", () => {
    for (const op of ["add_stage", "update_stage", "remove_stage", "set_program", "remove_program", "add_side_task"])
      expect(editLeadMagnetInput.safeParse({ changes: [{ op }] }).success).toBe(false);
  });

  it("view_lead_magnet: раздел flow — сжатый сценарий без «Общего» и раскладки, с замечаниями, если они есть", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: { ...twoStates(), schedule: { ...schedule, nudges: { afterSilence: [{ amount: 3, unit: "h" }] } }, nudges: { afterSilence: [{ amount: 1, unit: "h" }] } } }] });
    const view = (await viewLeadMagnet(deps, lead.id, { sections: ["flow", "overview"] })) as { flow: Record<string, unknown>; overview: Record<string, unknown> };
    expect(view.flow.common).toBeUndefined();
    expect(view.flow.layout).toBeUndefined();
    expect((view.flow.states as Array<Record<string, unknown>>)[0]).not.toHaveProperty("kind");
    expect(view.flow.issues).toEqual([expect.objectContaining({ level: "warning" })]);
    expect(view.overview).toMatchObject({ stateCount: 3, days: 3 });
  });
});

describe("view_lead_magnet", () => {
  it("отдаёт только выбранные разделы", async () => {
    const view = await viewLeadMagnet(deps, lead.id, { sections: ["firstMessage", "modelInfo"] });
    expect(Object.keys(view).sort()).toEqual(["firstMessage", "modelInfo"]);
    expect(view.firstMessage).toBe("Привет! Расскажите о себе.");
    expect(view.modelInfo).toMatchObject({ providerId: "deepseek", modelId: "deepseek-4.1-flash" });
  });

  it("обзор, инструкция, сценарий, завершение", async () => {
    const view = await viewLeadMagnet(deps, lead.id, { sections: ["overview", "instruction", "flow", "ending"] });
    expect(view.overview).toMatchObject({ name: lead.draft.name, maxPersonMessages: 60, stateCount: 2, days: null, fieldCount: 0 });
    expect(view.instruction).toContain("Ты консультант");
    expect(view.flow).toMatchObject({ start: "conversation", states: [expect.objectContaining({ id: "conversation" }), expect.objectContaining({ id: FINAL_STATE_ID })] });
    expect(view.ending).toMatchObject({ endCondition: "Человек выбрал шаг" });
  });

  it("поля лидмагнита и весь словарь полей", async () => {
    const attached = await createField(database.db, { name: `Опыт ${Math.random()}`, type: "number", description: "Лет в профессии" });
    const other = await createField(database.db, { name: `Другое ${Math.random()}`, type: "boolean", description: "y" });
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "attach_field", fieldId: attached.id }] });

    const view = await viewLeadMagnet(deps, lead.id, { sections: ["fields", "fieldDictionary"] });
    expect(view.fields).toEqual([expect.objectContaining({ id: attached.id, name: attached.name, type: "number" })]);
    const dictionaryIds = (view.fieldDictionary as Array<{ id: string }>).map((field) => field.id);
    expect(dictionaryIds).toEqual(expect.arrayContaining([attached.id, other.id]));
  });
});

describe("read_test_conversation", () => {
  let chatId: string;

  async function insert(message: Partial<StoredMessage> & Pick<StoredMessage, "id" | "role" | "parts">, parentId: string | null) {
    await chatStorage.insertMessage({
      chatId,
      parentId,
      formatVersion: 1,
      status: "complete",
      modelId: null,
      providerId: null,
      usage: null,
      reasoningDurationsMs: {},
      error: null,
      createdAt: new Date(Date.UTC(2026, 9, 3, 10, 0, Number(message.id.replace(/\D/g, "")))).toISOString(),
      ...message,
    });
  }

  beforeEach(async () => {
    chatId = `preview-chat-${lead.id}`;
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_flow", flow: twoStates() }] });
    await chatStorage.createChat({ id: chatId, ownerId: "cabinet", modelId: "stub-model", providerId: "stub" });
    await setPreviewChat(database.db, lead.id, chatId);

    await insert({ id: "m1", role: "assistant", parts: [{ type: "text", text: "Привет! Как вас зовут?" }] }, null);
    await insert({ id: "m2", role: "user", parts: [{ type: "text", text: "Аня" }] }, "m1");
    await insert(
      {
        id: "m3",
        role: "assistant",
        parts: [
          // Переход сценария: SDK пишет место чата записью состояния в ответе хода
          { type: APP_STATE_PART_TYPE, data: { set: { [FLOW_STATE_KEY]: { state: "goal", path: [{ state: "intro" }, { state: "goal" }] } } } },
          { type: "text", text: "Аня, какая у вас цель?" },
        ] as StoredMessage["parts"],
      },
      "m2",
    );
    await insert({ id: "m4", role: "user", parts: [{ type: "text", text: "Запустить курс" }] }, "m3");
  });

  it("реплики по порядку с отметками этапов", async () => {
    const text = await readTestConversation(deps, lead.id, {});
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toEqual([
      "[этап: Знакомство]",
      "Консультант: Привет! Как вас зовут?",
      "Человек: Аня",
      "[этап: Цель]",
      "Консультант: Аня, какая у вас цель?",
      "Человек: Запустить курс",
    ]);
  });

  it("lastMessages — только последние реплики", async () => {
    const text = await readTestConversation(deps, lead.id, { lastMessages: 2 });
    expect(text).toContain("Человек: Запустить курс");
    expect(text).toContain("Консультант: Аня, какая у вас цель?");
    expect(text).not.toContain("Как вас зовут");
  });

  it("тестового разговора ещё нет — так и говорит", async () => {
    const fresh = await createLeadMagnet(database.db, { name: "Без разговора" });
    expect(await readTestConversation(deps, fresh.id, {})).toMatch(/не было|нет/i);
  });
});
