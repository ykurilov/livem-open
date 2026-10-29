import { checkFlow, parseFlow, type AgentFlow, type FlowState } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings, newProgramSettings, type LeadMagnetSettings, type Stage } from "../lead-magnets/settings";
import type { FieldDefinition } from "../people";
import { leadMagnetFlowChecks } from "./app-checks";
import { LEAD_MAGNET_TOOLS, leadMagnetFlowCatalog } from "./catalog";
import { FIRST_APP_FIELDS, firstAppSettings } from "./first-app.fixture";
import {
  CONVERSATION_NUDGES,
  CONVERSATION_STATE_ID,
  DEADLINE_STATE_ID,
  FINAL_STATE_ID,
  HARD_DAY_FRAME_TEXT,
  LATE_START_HOURS,
  PROGRAM_DAY_START,
  SALE_TAG,
  leadMagnetToFlow,
} from "./settings-to-flow";

function stage(id: string, extra: Partial<Stage> = {}): Stage {
  return { id, name: `Этап ${id}`, instruction: `Что делать на этапе ${id}`, transitionCondition: `Условие ${id}`, startDay: null, isSale: false, ...extra };
}

function settings(patch: Partial<LeadMagnetSettings> = {}): LeadMagnetSettings {
  return { ...newLeadMagnetSettings("Разбор"), instruction: "Ты — помощник Анны.", ...patch };
}

const state = (flow: AgentFlow, id: string): FlowState => {
  const found = flow.states.find((item) => item.id === id);
  if (!found) throw new Error(`Нет ноды ${id}`);
  return found;
};

const exitsOf = (flow: AgentFlow, id: string) => state(flow, id).exits.map((exit) => ({ when: exit.when, to: exit.to }));

/** Свой выход последней рабочей ноды: без выходов SDK счёл бы её конечной и закрыл разговор при входе. */
const FINISH_EXIT = { when: { type: "event", event: "tool", name: "finish_dialog" }, to: FINAL_STATE_ID };

/** Ошибки встроенной проверки SDK и наших проверок вместе — то, что увидит доска и сервер. */
const errorsOf = (flow: AgentFlow, fields: readonly FieldDefinition[] = []) =>
  checkFlow(flow, leadMagnetFlowCatalog(fields), { checks: leadMagnetFlowChecks }).filter((issue) => issue.level === "error");

describe("leadMagnetToFlow: без этапов", () => {
  const flow = leadMagnetToFlow(settings(), []);

  it("одна нода «Разговор» с целью первой строкой, старт на ней", () => {
    expect(flow.start).toBe(CONVERSATION_STATE_ID);
    const conversation = state(flow, CONVERSATION_STATE_ID);
    expect(conversation.title).toBe("Разговор");
    expect(conversation.instructions.split("\n")[0]).toBe("Провести разговор по общей инструкции");
    expect(conversation.firstMessage).toBeNull();
  });

  it("нода «Разговор» не конечная: свой выход finish_dialog → «Итог»", () => {
    expect(exitsOf(flow, CONVERSATION_STATE_ID)).toEqual([FINISH_EXIT]);
  });

  it("основная инструкция — в «Общем», название — у сценария", () => {
    expect(flow.common).toBe("Ты — помощник Анны.");
    expect(flow.name).toBe("Разбор");
  });

  it("напоминания бросившим — касания в корне сценария, «Дней и времени» нет", () => {
    expect(flow.schedule).toBeUndefined();
    expect(flow.nudges).toEqual({
      afterSilence: [
        { amount: 15, unit: "min" },
        { amount: 1, unit: "h" },
      ],
      dailyAt: ["10:00", "19:00"],
      giveUpAfter: { amount: 3, unit: "d" },
    });
    expect(CONVERSATION_NUDGES).toEqual(flow.nudges);
    expect(state(flow, CONVERSATION_STATE_ID).nudges).toBeUndefined();
  });

  it("после конца молчим; finish_dialog из любой ноды ведёт в конечную «Итог»", () => {
    expect(flow.afterEnd).toBe("silent");
    expect(flow.anyState).toEqual({
      except: [],
      exits: [{ id: "finish_dialog", when: { type: "event", event: "tool", name: LEAD_MAGNET_TOOLS.finishDialog }, to: FINAL_STATE_ID }],
    });
    const final = state(flow, FINAL_STATE_ID);
    expect(final.title).toBe("Итог");
    expect(final.exits).toEqual([]);
  });

  it("сценарий уже в разобранном виде и без ошибок", () => {
    const parsed = parseFlow(JSON.parse(JSON.stringify(flow)));
    expect(parsed).toEqual({ ok: true, flow });
    expect(errorsOf(flow)).toEqual([]);
  });
});

describe("leadMagnetToFlow: этапы", () => {
  it("каждый этап — нода с тем же id; цель — название этапа первой строкой, дальше его инструкция", () => {
    const flow = leadMagnetToFlow(settings({ stages: [stage("a"), stage("b", { instruction: "" })] }), []);
    expect(flow.start).toBe("a");
    expect(flow.states.map((item) => item.id)).toEqual(["a", "b", FINAL_STATE_ID]);
    expect(state(flow, "a")).toMatchObject({ title: "Этап a", instructions: "Этап a\nЧто делать на этапе a" });
    expect(state(flow, "b").instructions).toBe("Этап b");
  });

  it("условие этапа — выход словами в следующую ноду, по порядку", () => {
    const flow = leadMagnetToFlow(settings({ stages: [stage("a"), stage("b"), stage("c")] }), []);
    expect(exitsOf(flow, "a")).toEqual([{ when: { type: "judge", text: "Условие a" }, to: "b" }]);
    expect(exitsOf(flow, "b")).toEqual([{ when: { type: "judge", text: "Условие b" }, to: "c" }]);
    expect(errorsOf(flow)).toEqual([]);
  });

  it("у последнего этапа выхода словами нет: ни при пустом условии, ни при заполненном — только свой finish_dialog", () => {
    const empty = leadMagnetToFlow(settings({ stages: [stage("a"), stage("b", { transitionCondition: " " })] }), []);
    expect(exitsOf(empty, "b")).toEqual([FINISH_EXIT]);
    const filled = leadMagnetToFlow(settings({ stages: [stage("a"), stage("b")] }), []);
    expect(exitsOf(filled, "b")).toEqual([FINISH_EXIT]);
    expect(errorsOf(filled)).toEqual([]);
  });

  it("пустое условие в середине — выход по цели этапа: следующие ноды достижимы, как раньше go_to_stage", () => {
    const flow = leadMagnetToFlow(settings({ stages: [stage("a", { transitionCondition: "" }), stage("b")] }), []);
    expect(exitsOf(flow, "a")).toEqual([{ when: { type: "judge", text: "Цель этапа «Этап a» достигнута" }, to: "b" }]);
    expect(errorsOf(flow)).toEqual([]);
  });

  it("id выходов не повторяются по всему сценарию", () => {
    const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);
    const ids = [...flow.states.flatMap((item) => item.exits), ...flow.anyState.exits].map((exit) => exit.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("«Продажа» — метка и sale_answer в инструментах ноды и сценария", () => {
    const flow = leadMagnetToFlow(settings({ stages: [stage("a"), stage("sale", { isSale: true })] }), []);
    expect(state(flow, "sale")).toMatchObject({ tags: [SALE_TAG], tools: [LEAD_MAGNET_TOOLS.saleAnswer] });
    expect(state(flow, "a")).toMatchObject({ tags: [], tools: [] });
    expect(flow.tools).toEqual([LEAD_MAGNET_TOOLS.saleAnswer]);
  });
});

describe("leadMagnetToFlow: дни этапов → «нода длится N дней»", () => {
  /** Выход-таймер ноды: сколько дней и куда. */
  const daysExit = (flow: AgentFlow, id: string) =>
    exitsOf(flow, id).find((exit) => exit.when.type === "timer" && exit.when.from === "state_days") ?? null;

  it("«Твоё первое приложение» (дни 1,1,1,1,2,3): у нод первого дня нет выхода в Доработку по времени — только таймер «день 3 программы» в Продажу", () => {
    const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);
    // Не собравший приложение утром продолжает с того же места, а не попадает в «Доработку» несуществующего приложения
    for (const id of ["stage-1", "stage-2", "stage-3", "stage-4", "stage-5"]) {
      expect(daysExit(flow, id)).toBeNull();
      expect(exitsOf(flow, id)).toContainEqual({ when: { type: "timer", from: "program_day", day: 3 }, to: "stage-6" });
      expect(exitsOf(flow, id).filter((exit) => exit.to === "stage-5" && exit.when.type !== "judge")).toEqual([]);
    }
    expect(exitsOf(flow, "stage-6")).toEqual([FINISH_EXIT]);
  });

  it("выход словами раньше таймера дня: по результату можно уйти раньше дня, но не позже", () => {
    const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);
    expect(state(flow, "stage-4").exits.map((exit) => exit.when.type)).toEqual(["judge", "timer"]);
  });

  it("ноды «дня N» — только по результату предыдущей: таймеров между рабочими нодами нет", () => {
    const flow = leadMagnetToFlow(
      settings({ program: newProgramSettings(5), stages: [stage("a"), stage("b", { startDay: 2 }), stage("c"), stage("d", { startDay: 5 })] }),
      [],
    );
    expect(flow.states.flatMap((item) => item.exits).filter((exit) => exit.when.type === "timer" || exit.when.type === "event" && exit.when.event === "app")).toEqual([]);
  });

  it("день «Продажи» — таймером «день N программы» из каждой ноды до неё, где день наступает позже", () => {
    const flow = leadMagnetToFlow(
      settings({
        program: newProgramSettings(5),
        stages: [stage("a"), stage("b", { startDay: 2 }), stage("c"), stage("s", { startDay: 4, isSale: true }), stage("e", { startDay: 5 })],
      }),
      [],
    );
    const day4 = { type: "timer", from: "program_day", day: 4 };
    for (const id of ["a", "b", "c"]) expect(exitsOf(flow, id)).toContainEqual({ when: day4, to: "s" });
    expect(flow.states.flatMap((item) => item.exits).some((exit) => exit.when.type === "event" && exit.when.event === "app")).toBe(false);
    expect(exitsOf(flow, "s").filter((exit) => exit.when.type !== "judge")).toEqual([]);
  });

  it("без дней у этапов таймеров нет", () => {
    const flow = leadMagnetToFlow(settings({ program: newProgramSettings(3), stages: [stage("a"), stage("b")] }), []);
    expect(flow.states.flatMap((item) => item.exits).some((exit) => exit.when.type === "timer")).toBe(false);
  });
});

describe("leadMagnetToFlow: программа → «Дни и время»", () => {
  const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);

  it("день с 9:00, ночь с «не позже», срок, потолок, касания после первого дня, рамки дня с «Утром отвечу!»", () => {
    expect(flow.schedule).toEqual({
      dayStart: PROGRAM_DAY_START,
      nightFrom: "21:00",
      lateStartHours: LATE_START_HOURS,
      lengthDays: 3,
      deadlineState: DEADLINE_STATE_ID,
      farewellOnDeadline: false,
      firstMessages: { maxPerDay: 3, maxPerDayByDay: [3, 2] },
      nudges: {
        afterSilence: [
          { amount: 3, unit: "h" },
          { amount: 3, unit: "h" },
        ],
      },
      dayFrame: { softFrom: 20, hardAt: 30, hardText: HARD_DAY_FRAME_TEXT },
    });
    expect(PROGRAM_DAY_START).toBe("09:00");
    expect(LATE_START_HOURS).toBe(3);
    expect(HARD_DAY_FRAME_TEXT).toBe("Утром отвечу!");
  });

  it("«срок вышел» — своя конечная нода «Срок вышел»: доходит только по сроку, сценарий без ошибок (SDK 0.51)", () => {
    const deadline = state(flow, DEADLINE_STATE_ID);
    expect(deadline).toMatchObject({ title: "Срок вышел", exits: [], tools: [], tags: [] });
    expect(flow.states.filter((item) => item.exits.some((exit) => exit.to === DEADLINE_STATE_ID))).toEqual([]);
    expect(errorsOf(flow, FIRST_APP_FIELDS)).toEqual([]);
  });

  it("без программы ноды «Срок вышел» нет", () => {
    expect(leadMagnetToFlow(settings(), []).states.map((item) => item.id)).not.toContain(DEADLINE_STATE_ID);
  });

  it("касания сценария в корне не ставятся: их заменяют касания «Дней и времени»", () => {
    expect(flow.nudges).toBeUndefined();
  });

  it("ноды первого дня — частые касания в минутах только в день входа; потом и в нодах дальше — общие касания «Дней и времени»", () => {
    // Частый ряд — только в день входа и только в день 1 программы: вошёл в ноду первого дня позже — сразу общий ряд
    const firstDay = { afterSilence: [15, 60, 240].map((amount) => ({ amount, unit: "min" })), days: 1, untilProgramDay: 1 };
    for (const id of ["stage-1", "stage-2", "stage-3", "stage-4"]) expect(state(flow, id).nudges).toEqual(firstDay);
    expect(state(flow, "stage-5").nudges).toBeUndefined();
    expect(state(flow, "stage-6").nudges).toBeUndefined();
  });

  it("конечных нод две: «Итог» (finish_dialog) и «Срок вышел» (срок программы)", () => {
    expect(flow.states.filter((item) => item.exits.length === 0).map((item) => item.id)).toEqual([FINAL_STATE_ID, DEADLINE_STATE_ID]);
  });
});

describe("leadMagnetToFlow: поля, попутные задачи, ссылки", () => {
  const flow = leadMagnetToFlow(firstAppSettings(), FIRST_APP_FIELDS);

  it("поля лидмагнита → карточка клиента в их порядке: id словаря, описание, тип и варианты", () => {
    expect(flow.clientCard.map((field) => field.name)).toEqual(FIRST_APP_FIELDS.map((field) => field.name));
    expect(flow.clientCard[1]).toEqual({
      id: FIRST_APP_FIELDS[1]!.id,
      name: "Опыт создания приложений",
      about: "Опыт человека в создании сайтов и приложений",
      type: "choice",
      options: ["ничего не создавал", "пробовал конструкторы сайтов", "программирую"],
      refreshAfterMonths: null,
    });
  });

  it("поле «да/нет» → boolean; поле, которого нет в словаре, пропускается", () => {
    const yesNo: FieldDefinition = { id: "00000000-0000-4000-8000-0000000000b1", name: "Подписан", type: "boolean", options: [], description: "" };
    const gone = "00000000-0000-4000-8000-0000000000dd";
    const card = leadMagnetToFlow(settings({ fieldIds: [gone, yesNo.id] }), [yesNo]).clientCard;
    expect(card).toEqual([{ id: yesNo.id, name: "Подписан", about: "", type: "boolean", options: [], refreshAfterMonths: null }]);
  });

  it("попутные задачи: текст, когда уместно, поле карточки; попыток 2 на человека", () => {
    expect(flow.sideTasks?.[0]).toEqual({
      id: "task-1",
      text: "Когда человек радуется своему приложению, попроси пару слов отзыва о App Studio: что получилось и что понравилось",
      when: "После того как приложение собрано или опубликовано и человек доволен",
      field: FIRST_APP_FIELDS[3]!.id,
      maxAttempts: 2,
      perConversation: false,
    });
  });

  it("задача без поля и без условия — без этих ключей; поле, которого нет в словаре, у задачи убирается", () => {
    const program = { ...newProgramSettings(3), sideTasks: [{ id: "t", task: "Предложить канал", fieldId: "00000000-0000-4000-8000-0000000000dd", when: "" }] };
    expect(leadMagnetToFlow(settings({ program }), []).sideTasks).toEqual([
      { id: "t", text: "Предложить канал", maxAttempts: 2, perConversation: false },
    ]);
  });

  it("без программы попутных задач нет", () => {
    expect(leadMagnetToFlow(settings(), []).sideTasks).toBeUndefined();
  });

  it("просмотр ссылок → person_link_view во всех рабочих нодах и в инструментах сценария", () => {
    for (const item of flow.states.filter((s) => s.exits.length > 0))
      expect(item.tools).toContain(LEAD_MAGNET_TOOLS.personLinkView);
    expect(flow.tools).toEqual([LEAD_MAGNET_TOOLS.saleAnswer, LEAD_MAGNET_TOOLS.personLinkView]);
    const plain = leadMagnetToFlow(settings({ viewsLinks: false, stages: [stage("a")] }), []);
    expect(plain.tools).toEqual([]);
    expect(state(plain, "a").tools).toEqual([]);
  });

  it("«Твоё первое приложение» после перевода проходит проверку SDK и наши проверки", () => {
    expect(errorsOf(flow, FIRST_APP_FIELDS)).toEqual([]);
    expect(parseFlow(JSON.parse(JSON.stringify(flow)))).toEqual({ ok: true, flow });
  });
});
