import { describe, expect, it } from "vitest";
import type { AgentFlow, ClientCardField, FlowState } from "@ykurilov/agent-chat-flows/format";
import { FINAL_STATE_ID, LEAD_MAGNET_TOOLS, SALE_TAG } from "../flows";
import { newLeadMagnetSettings, type LeadMagnetSettings } from "../lead-magnets";
import { constructorTail, describeManualEdits } from "./manual-edits";

const before = {
  ...newLeadMagnetSettings("Разбор"),
  firstMessage: "Привет!",
  instruction: "Ты консультант.",
};

function withFlow(settings: LeadMagnetSettings, flow: AgentFlow): LeadMagnetSettings {
  return { ...settings, flow };
}

function withCard(settings: LeadMagnetSettings, ids: string[]): LeadMagnetSettings {
  const clientCard: ClientCardField[] = ids.map((id) => ({ id, name: id, about: "", type: "text", options: [], refreshAfterMonths: null }));
  return withFlow(settings, { ...settings.flow, clientCard });
}

describe("заметки о ручной правке", () => {
  it("короткое поле: «было → стало» целиком", () => {
    const notes = describeManualEdits(before, { ...before, firstMessage: "Здравствуйте!" }, new Map());
    expect(notes).toEqual(["Первое сообщение: было «Привет!» → стало «Здравствуйте!»"]);
  });

  it("без изменений — заметок нет", () => {
    expect(describeManualEdits(before, { ...before }, new Map())).toEqual([]);
  });

  it("длинный текст: только изменённый кусок с соседним контекстом", () => {
    const head = "Начало инструкции. ".repeat(40);
    const tail = " Конец инструкции.".repeat(40);
    const long = withFlow(before, { ...before.flow, common: `${head}Говори на «вы».${tail}` });
    const [note] = describeManualEdits(long, withFlow(long, { ...long.flow, common: `${head}Говори на «ты».${tail}` }), new Map());

    expect(note).toContain("Основная инструкция");
    expect(note).toContain("вы");
    expect(note).toContain("ты");
    expect(note!.length).toBeLessThan(400);
    expect(note).not.toContain(head);
  });

  it("числа и модель тоже попадают в заметки", () => {
    const after = { ...before, maxPersonMessages: 40, modelId: "glm-5.3-flash" };
    const notes = describeManualEdits(before, after, new Map()).join("\n");
    expect(notes).toContain("Предел сообщений человека: было «60» → стало «40»");
    expect(notes).toContain("glm-5.3-flash");
  });

  it("основная инструкция — это «Общее» сценария", () => {
    const after = withFlow(before, { ...before.flow, common: "Ты помощник Анны." });
    expect(describeManualEdits(withFlow(before, { ...before.flow, common: "Ты консультант." }), after, new Map())).toEqual([
      "Основная инструкция: было «Ты консультант.» → стало «Ты помощник Анны.»",
    ]);
  });

  it("поля карточки названы по имени, а не по служебному номеру", () => {
    const names = new Map([
      ["f-budget", "Бюджет"],
      ["f-city", "Город"],
    ]);
    const notes = describeManualEdits(withCard(before, ["f-city"]), withCard(before, ["f-budget"]), names);
    expect(notes).toContain("Поля: подключено поле «Бюджет»");
    expect(notes).toContain("Поля: отключено поле «Город»");
    expect(notes.join("\n")).not.toContain("f-");
  });

  it("имени поля нет (поле удалили) — понятная пометка без номера", () => {
    const notes = describeManualEdits(withCard(before, ["f-gone"]), withCard(before, []), new Map());
    expect(notes).toEqual(["Поля: отключено удалённое поле"]);
  });

  it("ролики, включённые и выключенные вручную, названы по названию", () => {
    const titles = new Map([
      ["v-prices", "Цены на услуги"],
      ["v-pack", "Упаковка экспертизы"],
    ]);
    const notes = describeManualEdits({ ...before, videoIds: ["v-pack"] }, { ...before, videoIds: ["v-prices"] }, new Map(), titles);
    expect(notes).toEqual(["Видео: включён ролик «Цены на услуги»", "Видео: выключен ролик «Упаковка экспертизы»"]);
  });

  it("удалённый из архива ролик пропал из списка — это не правка эксперта, заметки нет", () => {
    expect(describeManualEdits({ ...before, videoIds: ["v-gone"] }, { ...before, videoIds: [] }, new Map(), new Map())).toEqual([]);
  });

  it("картинки, включённые и выключенные вручную, названы по названию; удалённая из архива — без заметки", () => {
    const titles = new Map([
      ["i-app", "Готовое приложение"],
      ["i-editor", "Редактор"],
    ]);
    const notes = describeManualEdits({ ...before, imageIds: ["i-editor", "i-gone"] }, { ...before, imageIds: ["i-app"] }, new Map(), new Map(), titles);
    expect(notes).toEqual(["Картинки: включена картинка «Готовое приложение»", "Картинки: выключена картинка «Редактор»"]);
  });

  it("хвост конструктора собирает заметки под общим заголовком", () => {
    const tail = constructorTail(["Первое сообщение: было «а» → стало «б»", "Название: было «x» → стало «y»"]);
    expect(tail).toMatch(/^Эксперт вручную изменил:/);
    expect(tail).toContain("— Первое сообщение: было «а» → стало «б»");
    expect(tail).toContain("— Название: было «x» → стало «y»");
  });

  it("нет заметок — нет хвоста", () => {
    expect(constructorTail([])).toBeNull();
  });
});

describe("заметки о сценарии: «было → стало» по id нод и выходов", () => {
  const finish = { id: "x_finish", when: { type: "event" as const, event: "tool" as const, name: "finish_dialog" }, to: FINAL_STATE_ID };
  const node = (id: string, title: string, extra: Partial<FlowState> = {}): FlowState => ({
    id,
    kind: "state",
    title,
    instructions: `${title}\nКак вести`,
    firstMessage: null,
    learn: [],
    noSideQuestions: false,
    tools: [],
    tags: [],
    exits: [{ ...finish, id: `${id}_finish` }],
    ...extra,
  });
  const intro = node("intro", "Знакомство", { exits: [{ id: "intro_done", when: { type: "judge", text: "Имя известно" }, to: "goal" }] });
  const goal = node("goal", "Цель");
  const flow: AgentFlow = { ...before.flow, start: "intro", states: [intro, goal, node(FINAL_STATE_ID, "Итог", { exits: [] })] };
  const base = withFlow(before, flow);
  const edited = (change: (flow: AgentFlow) => AgentFlow) => withFlow(before, change(structuredClone(flow)));

  it("нода добавлена и удалена — по названию", () => {
    const sale = node("sale", "Продажа");
    const added = edited((f) => ({ ...f, states: [...f.states, sale] }));
    expect(describeManualEdits(base, added, new Map())).toEqual(["Сценарий: добавлена нода «Продажа»"]);
    expect(describeManualEdits(added, base, new Map())).toEqual(["Сценарий: удалена нода «Продажа»"]);
  });

  it("переименование ноды не путается с удалением: сравнение по id", () => {
    const renamed = edited((f) => ({ ...f, states: f.states.map((s) => (s.id === "goal" ? { ...s, title: "Задача" } : s)) }));
    expect(describeManualEdits(base, renamed, new Map())).toEqual(["Нода «Цель»: название было «Цель» → стало «Задача»"]);
  });

  it("инструкция ноды, метка «Продажа» и инструменты", () => {
    const changed = edited((f) => ({
      ...f,
      states: f.states.map((s) =>
        s.id === "goal" ? { ...s, instructions: "Цель\nКак вести иначе", tags: [SALE_TAG], tools: [LEAD_MAGNET_TOOLS.saleAnswer] } : s,
      ),
    }));
    expect(describeManualEdits(base, changed, new Map())).toEqual([
      "Нода «Цель»: инструкция было «Цель\nКак вести» → стало «Цель\nКак вести иначе»",
      "Нода «Цель»: отмечена как «Продажа»",
      `Нода «Цель»: инструменты было «нет» → стало «${LEAD_MAGNET_TOOLS.saleAnswer}»`,
    ]);
  });

  it("выход: условие изменено, добавлен, удалён — с названием цели", () => {
    const changed = edited((f) => ({
      ...f,
      states: f.states.map((s) =>
        s.id === "intro"
          ? { ...s, exits: [{ id: "intro_done", when: { type: "judge", text: "Имя и город известны" }, to: "goal" }] }
          : s.id === "goal"
            ? { ...s, exits: [{ id: "goal_days", when: { type: "timer", from: "state_days", days: 1 }, to: FINAL_STATE_ID }] }
            : s,
      ),
    }));
    expect(describeManualEdits(base, changed, new Map())).toEqual([
      "Нода «Знакомство», переход в «Цель»: было «судья: Имя известно» → стало «судья: Имя и город известны»",
      "Нода «Цель»: удалён переход в «Итог» (инструмент finish_dialog)",
      "Нода «Цель»: добавлен переход в «Итог» (нода длится 1 дн.)",
    ]);
  });

  it("стартовая нода", () => {
    const changed = edited((f) => ({ ...f, start: "goal" }));
    expect(describeManualEdits(base, changed, new Map())).toEqual(["Сценарий: стартовая нода было «Знакомство» → стало «Цель»"]);
  });

  it("«Дни и время»: включены, изменены, выключены", () => {
    const schedule = { dayStart: "09:00", lateStartHours: 3, lengthDays: 3, farewellOnDeadline: false };
    const on = edited((f) => ({ ...f, schedule }));
    expect(describeManualEdits(base, on, new Map())).toEqual(["Дни и время: включены, срок 3 дн."]);
    expect(describeManualEdits(on, base, new Map())).toEqual(["Дни и время: выключены, разговор снова один"]);
    const longer = edited((f) => ({ ...f, schedule: { ...schedule, lengthDays: 5, farewellOnDeadline: true } }));
    expect(describeManualEdits(on, longer, new Map())).toEqual([
      "Дни и время: lengthDays было «3» → стало «5»",
      "Дни и время: farewellOnDeadline было «false» → стало «true»",
    ]);
  });

  it("попутные задачи: добавлена, изменена, удалена; поле названо по имени", () => {
    const task = { id: "t1", text: "Узнать город", field: "f-city", maxAttempts: 2, perConversation: false };
    const names = new Map([["f-city", "Город"]]);
    const withTask = edited((f) => ({ ...f, sideTasks: [task] }));
    expect(describeManualEdits(base, withTask, names)).toEqual(["Попутные задачи: добавлена «Узнать город» (поле «Город»)"]);
    expect(describeManualEdits(withTask, base, names)).toEqual(["Попутные задачи: удалена «Узнать город»"]);
    const changed = edited((f) => ({ ...f, sideTasks: [{ ...task, text: "Узнать город и пояс", when: "к слову" }] }));
    expect(describeManualEdits(withTask, changed, names)).toEqual([
      "Попутная задача: текст было «Узнать город» → стало «Узнать город и пояс»",
      "Попутная задача «Узнать город и пояс»: условие было «» → стало «к слову»",
    ]);
  });

  it("касания сценария", () => {
    const changed = edited((f) => ({ ...f, nudges: { afterSilence: [{ amount: 30, unit: "min" }] } }));
    expect(describeManualEdits(base, changed, new Map())[0]).toMatch(/^Касания сценария: было «.*» → стало «30 мин»$/);
  });

  it("без изменений сценария — заметок нет", () => {
    expect(describeManualEdits(base, structuredClone(base), new Map())).toEqual([]);
  });
});
