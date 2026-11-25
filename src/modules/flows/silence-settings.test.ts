import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { describe, expect, it } from "vitest";
import { CONVERSATION_NUDGES, leadMagnetToFlow, NEW_CONVERSATION_NUDGES } from "./settings-to-flow";
import { silenceOf, withSilence } from "./silence-settings";

const conversation = (nudges: AgentFlow["nudges"]): AgentFlow => ({
  ...leadMagnetToFlow({ name: "Разбор", instruction: "", stages: [], program: null, fieldIds: [], viewsLinks: false }, []),
  nudges,
});

describe("«Напоминать» и «Ждать ответа» в сценарии", () => {
  it("новый лидмагнит: напоминать 3 дня, ждать без срока", () => {
    expect(NEW_CONVERSATION_NUDGES).toMatchObject({ stopAfter: { amount: 3, unit: "d" } });
    expect(NEW_CONVERSATION_NUDGES.giveUpAfter).toBeUndefined();
    expect(silenceOf(conversation(NEW_CONVERSATION_NUDGES))).toEqual({ remindDays: 3, waitDays: null });
  });

  it("прежний сценарий без «Напоминать»: напоминания идут до «не завершил» — оба срока равны", () => {
    expect(silenceOf(conversation(CONVERSATION_NUDGES))).toEqual({ remindDays: 3, waitDays: 3 });
  });

  it("сроки в часах — в днях с дробью", () => {
    expect(silenceOf(conversation({ afterSilence: [], stopAfter: { amount: 36, unit: "h" } }))).toEqual({ remindDays: 1.5, waitDays: null });
  });

  it("запись: касания сценария те же, сроки — в днях; ждать без срока убирает «не завершил»", () => {
    const flow = withSilence(conversation(CONVERSATION_NUDGES), { remindDays: 5, waitDays: 30 });
    expect(flow.nudges).toEqual({ ...CONVERSATION_NUDGES, stopAfter: { amount: 5, unit: "d" }, giveUpAfter: { amount: 30, unit: "d" } });
    const open = withSilence(flow, { remindDays: 5, waitDays: null });
    expect(open.nudges).toEqual({ afterSilence: CONVERSATION_NUDGES.afterSilence, dailyAt: CONVERSATION_NUDGES.dailyAt, stopAfter: { amount: 5, unit: "d" } });
  });

  it("у сценария без своих касаний — касания нового лидмагнита", () => {
    const { nudges: _none, ...bare } = conversation(CONVERSATION_NUDGES);
    expect(withSilence(bare as AgentFlow, { remindDays: 2, waitDays: null }).nudges).toEqual({ ...NEW_CONVERSATION_NUDGES, stopAfter: { amount: 2, unit: "d" } });
  });

  it("у воронки на несколько дней сроков молчания нет: разговор кончается сроком воронки", () => {
    const program = { ...conversation(undefined), schedule: { dayStart: "09:00", lateStartHours: 3, lengthDays: 3 } } as AgentFlow;
    expect(silenceOf(program)).toBeNull();
    expect(() => withSilence(program, { remindDays: 3, waitDays: null })).toThrow(/воронк/);
  });
});
