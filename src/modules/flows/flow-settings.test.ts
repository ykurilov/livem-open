import { compactFlow, parseFlow, type AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings } from "../lead-magnets/settings";
import type { FieldDefinition } from "../people";
import { LEAD_MAGNET_TOOLS } from "./catalog";
import { cardFromDictionary, completeFlowJson, withLeadMagnetFlow, withStateTools } from "./flow-settings";
import { CONVERSATION_STATE_ID, PROGRAM_FIRST_MESSAGES_BY_DAY, PROGRAM_NUDGES, SALE_TAG } from "./settings-to-flow";

const city: FieldDefinition = { id: "11111111-1111-4111-8111-111111111111", name: "Город", type: "text", options: [], description: "Где живёт" };
const level: FieldDefinition = { id: "22222222-2222-4222-8222-222222222222", name: "Уровень", type: "choice", options: ["новичок", "опытный"], description: "Опыт" };

function parsed(json: unknown): AgentFlow {
  const result = parseFlow(json);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.flow;
}

const base = newLeadMagnetSettings("Разбор");

describe("withStateTools", () => {
  it("инструменты сценария — те, что стоят у нод: SDK не пустит инструмент ноды, которого нет в списке", () => {
    const flow = structuredClone(base.flow);
    flow.states[0]!.tools = [LEAD_MAGNET_TOOLS.saleAnswer, LEAD_MAGNET_TOOLS.personLinkView];
    flow.tools = [];
    expect(withStateTools(flow).tools).toEqual([LEAD_MAGNET_TOOLS.saleAnswer, LEAD_MAGNET_TOOLS.personLinkView]);
    flow.states[0]!.tools = [];
    flow.tools = [LEAD_MAGNET_TOOLS.saleAnswer];
    expect(withStateTools(flow).tools).toEqual([]);
  });
});

describe("withLeadMagnetFlow", () => {
  it("кладёт сценарий; старые поля, которые ещё читает движок до переноса и откат, повторяют его", () => {
    const flow = structuredClone(base.flow);
    flow.common = "Ты помощник Анны.";
    flow.clientCard = [{ id: city.id, name: city.name, about: city.description, type: "text", options: [], refreshAfterMonths: null }];
    flow.states[0]!.tools = [LEAD_MAGNET_TOOLS.personLinkView];

    const next = withLeadMagnetFlow(base, flow);
    expect(next.flow.common).toBe("Ты помощник Анны.");
    expect(next.flow.tools).toEqual([LEAD_MAGNET_TOOLS.personLinkView]);
    expect(next.instruction).toBe("Ты помощник Анны.");
    expect(next.fieldIds).toEqual([city.id]);
    expect(next.viewsLinks).toBe(true);
    expect(withLeadMagnetFlow(next, base.flow).viewsLinks).toBe(false);
  });

  it("этапы и программу не трогает: они остаются для отката", () => {
    const old = { ...base, stages: [{ id: "s1", name: "Знакомство", instruction: "", transitionCondition: "", startDay: null, isSale: false }] };
    expect(withLeadMagnetFlow(old, base.flow).stages).toEqual(old.stages);
  });
});

describe("completeFlowJson", () => {
  it("дописывает то, что конструктор и агент не обязаны знать: формат, id, имя, общее, режим после конца, раскладку", () => {
    const current = { ...structuredClone(base.flow), common: "Общее", layout: { conversation: { x: 10, y: 20 } } };
    const json = { start: "a", states: [{ id: "a", title: "А", instructions: "Цель", exits: [] }] };
    const flow = parsed(completeFlowJson(json, current));
    expect(flow).toMatchObject({ format: "agent-flow", version: 2, id: current.id, name: current.name, common: "Общее", afterEnd: "silent" });
    expect(flow.layout).toEqual(current.layout);
  });

  it("заданное во входе не перекрывает", () => {
    const json = { ...compactFlow(base.flow), common: "Новое общее", name: "Другое" };
    expect(parsed(completeFlowJson(json, base.flow))).toMatchObject({ common: "Новое общее", name: "Другое" });
  });

  it("попутной задаче без id id выдаётся сам; заданный остаётся", () => {
    const json = { ...compactFlow(base.flow), sideTasks: [{ text: "Узнать город" }, { id: "t2", text: "Узнать опыт" }] };
    const flow = parsed(completeFlowJson(json, base.flow));
    expect(flow.sideTasks![0]!.id).toEqual(expect.any(String));
    expect(flow.sideTasks![1]!.id).toBe("t2");
  });

  it("«Дни и время» без касаний и потолка по дням — касания и потолок программы по умолчанию; свои остаются", () => {
    const schedule = { dayStart: "09:00", lengthDays: 3, lateStartHours: 3, farewellOnDeadline: false };
    const filled = parsed(completeFlowJson({ ...compactFlow(base.flow), schedule }, base.flow)).schedule;
    expect(filled?.nudges).toEqual(PROGRAM_NUDGES);
    expect(filled?.firstMessages).toEqual({ maxPerDayByDay: PROGRAM_FIRST_MESSAGES_BY_DAY });
    expect(PROGRAM_FIRST_MESSAGES_BY_DAY).toEqual([3, 2]);

    const own = { afterSilence: [{ amount: 5, unit: "h" as const }] };
    const firstMessages = { maxPerDay: 2, morning: false };
    const kept = parsed(completeFlowJson({ ...compactFlow(base.flow), schedule: { ...schedule, nudges: own, firstMessages } }, base.flow)).schedule;
    expect(kept?.nudges).toEqual(own);
    expect(kept?.firstMessages).toEqual({ ...firstMessages, maxPerDayByDay: [3, 2] });
    const byDay = { maxPerDayByDay: [2, 1] };
    expect(parsed(completeFlowJson({ ...compactFlow(base.flow), schedule: { ...schedule, firstMessages: byDay } }, base.flow)).schedule?.firstMessages).toEqual(byDay);
  });

  it("поле карточки можно назвать одним id: остальное возьмётся из словаря", () => {
    const json = { ...compactFlow(base.flow), clientCard: [city.id] };
    const flow = parsed(completeFlowJson(json, base.flow));
    expect(flow.clientCard.map((field) => field.id)).toEqual([city.id]);
  });
});

describe("cardFromDictionary", () => {
  it("поля карточки — из словаря «Базы»: название, описание, тип и варианты берутся оттуда", () => {
    const flow = structuredClone(base.flow);
    flow.clientCard = [{ id: level.id, name: "как-то не так", about: "", type: "text", options: [], refreshAfterMonths: 6 }];
    const result = cardFromDictionary(flow, [city, level]);
    expect(result).toEqual({
      ok: true,
      flow: expect.objectContaining({
        clientCard: [{ id: level.id, name: "Уровень", about: "Опыт", type: "choice", options: ["новичок", "опытный"], refreshAfterMonths: 6 }],
      }),
    });
  });

  it("поля нет в словаре — его id в ответе", () => {
    const flow = structuredClone(base.flow);
    flow.clientCard = [{ id: "нет-такого", name: "Х", about: "", type: "text", options: [], refreshAfterMonths: null }];
    expect(cardFromDictionary(flow, [city])).toEqual({ ok: false, missing: ["нет-такого"] });
  });
});

describe("сценарий нового лидмагнита", () => {
  it("одна нода «Разговор», «Продажи» нет", () => {
    expect(base.flow.start).toBe(CONVERSATION_STATE_ID);
    expect(base.flow.states.some((state) => state.tags.includes(SALE_TAG))).toBe(false);
  });
});
