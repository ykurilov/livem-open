import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings, newProgramSettings, type LeadMagnetSettings, type Stage } from "../lead-magnets/settings";
import { passagePlacement, type PassageFacts } from "./passage-placement";
import { leadMagnetToFlow } from "./settings-to-flow";

const MSK = (iso: string) => new Date(`${iso}+03:00`);
const NSK = (iso: string) => new Date(`${iso}+07:00`);

function stage(id: string, extra: Partial<Stage> = {}): Stage {
  return { id, name: `Этап ${id}`, instruction: `Что делать на этапе ${id}`, transitionCondition: `Условие ${id}`, startDay: null, isSale: false, ...extra };
}

const flowOf = (patch: Partial<LeadMagnetSettings> = {}) => leadMagnetToFlow({ ...newLeadMagnetSettings("Разбор"), instruction: "Ты — помощник.", ...patch }, []);

const STAGES = [stage("idea"), stage("build", { startDay: 2 }), stage("sale", { startDay: 3, isSale: true })];

function passage(patch: Partial<PassageFacts> = {}): PassageFacts {
  return {
    startedAt: MSK("2026-10-12T14:00:00"),
    currentStageId: null,
    stageHistory: [],
    lastPersonMessageAt: MSK("2026-10-12T14:20:00"),
    reminderChainStartedAt: MSK("2026-10-12T14:21:00"),
    reminderStep: 0,
    programStartDate: null,
    dayMessageCount: 0,
    dayMessageCountDay: 0,
    personClosedDay: null,
    ...patch,
  };
}

const base = { timeZone: null, lastFirstMessageAt: null, firstMessagesToday: 0, now: MSK("2026-10-12T15:00:00") };

describe("место идущего прохождения в сценарии", () => {
  it("без этапов: стартовая нода, начало — начало прохождения, последние реплики и шаг напоминаний — из прохождения", () => {
    const { placement, warnings } = passagePlacement({ ...base, flow: flowOf(), passage: passage({ reminderStep: 1 }) });
    expect(placement).toEqual({
      startedAt: MSK("2026-10-12T14:00:00"),
      lastHumanAt: MSK("2026-10-12T14:20:00"),
      lastAgentAt: MSK("2026-10-12T14:21:00"),
      nudgeStep: 1,
      today: {},
    });
    expect(warnings).toEqual([]);
  });

  it("с этапами: нода текущего этапа, вход в неё — время последнего перехода в этот этап", () => {
    const { placement } = passagePlacement({
      ...base,
      flow: flowOf({ stages: STAGES.map((item) => ({ ...item, startDay: null })) }),
      passage: passage({
        currentStageId: "build",
        stageHistory: [
          { stageId: "idea", at: MSK("2026-10-12T14:00:00").toISOString() },
          { stageId: "build", at: MSK("2026-10-12T14:10:00").toISOString() },
          { stageId: "idea", at: MSK("2026-10-12T14:12:00").toISOString() },
          { stageId: "build", at: MSK("2026-10-12T14:15:00").toISOString() },
        ],
      }),
    });
    expect(placement).toMatchObject({ stateId: "build", enteredAt: MSK("2026-10-12T14:15:00") });
  });

  it("этапа нет в сценарии — чат идёт со старта сценария, с предупреждением", () => {
    const { placement, warnings } = passagePlacement({ ...base, flow: flowOf({ stages: [stage("idea")] }), passage: passage({ currentStageId: "gone" }) });
    expect(placement.stateId).toBeUndefined();
    expect(placement.enteredAt).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("gone")]);
  });

  it("с программой во второй день: начало — 9:00 первого дня по поясу человека, счёт сегодняшнего дня и пояс", () => {
    const { placement } = passagePlacement({
      flow: flowOf({ stages: STAGES, program: newProgramSettings(3) }),
      passage: passage({
        startedAt: NSK("2026-10-12T21:30:00"),
        currentStageId: "build",
        stageHistory: [{ stageId: "build", at: NSK("2026-10-13T09:00:00").toISOString() }],
        programStartDate: "2026-10-12",
        dayMessageCount: 4,
        dayMessageCountDay: 2,
        personClosedDay: 2,
      }),
      timeZone: "Asia/Novosibirsk",
      lastFirstMessageAt: null,
      firstMessagesToday: 1,
      now: NSK("2026-10-13T15:00:00"),
    });
    expect(placement).toMatchObject({
      stateId: "build",
      startedAt: NSK("2026-10-12T09:00:00"),
      enteredAt: NSK("2026-10-13T09:00:00"),
      today: { firstMessages: 1, humanMessages: 4, dayClosed: true },
      timeZone: "Asia/Novosibirsk",
    });
  });

  it("счёт дня с прошлого дня программы не переносится", () => {
    const { placement } = passagePlacement({
      ...base,
      flow: flowOf({ stages: STAGES, program: newProgramSettings(3) }),
      passage: passage({ programStartDate: "2026-10-12", dayMessageCount: 5, dayMessageCountDay: 1, personClosedDay: 1 }),
      now: MSK("2026-10-13T12:00:00"),
    });
    expect(placement.today).toEqual({ humanMessages: 0, dayClosed: false });
  });

  it("вход в ноду не раньше начала программы: прохождение началось до 9:00", () => {
    const { placement } = passagePlacement({
      ...base,
      flow: flowOf({ stages: STAGES, program: newProgramSettings(3) }),
      passage: passage({
        startedAt: MSK("2026-10-12T08:00:00"),
        currentStageId: "idea",
        stageHistory: [{ stageId: "idea", at: MSK("2026-10-12T08:00:00").toISOString() }],
        programStartDate: "2026-10-12",
      }),
    });
    expect(placement).toMatchObject({ startedAt: MSK("2026-10-12T09:00:00"), enteredAt: MSK("2026-10-12T09:00:00") });
  });

  it("последнее сообщение агента — позднее из ответа консультанта и сообщения первым", () => {
    const later = passagePlacement({ ...base, flow: flowOf(), passage: passage(), lastFirstMessageAt: MSK("2026-10-12T14:36:00") });
    expect(later.placement.lastAgentAt).toEqual(MSK("2026-10-12T14:36:00"));
    const earlier = passagePlacement({ ...base, flow: flowOf(), passage: passage(), lastFirstMessageAt: MSK("2026-10-12T14:00:00") });
    expect(earlier.placement.lastAgentAt).toEqual(MSK("2026-10-12T14:21:00"));
  });

  it("консультант ещё не отвечал: последнее сообщение агента — первое сообщение лидмагнита в начале прохождения", () => {
    const { placement } = passagePlacement({ ...base, flow: flowOf(), passage: passage({ reminderChainStartedAt: null, lastPersonMessageAt: null }) });
    expect(placement.lastAgentAt).toEqual(MSK("2026-10-12T14:00:00"));
    expect(placement.lastHumanAt).toBeUndefined();
  });

  it("сообщения первым за сегодня идут в потолок дня и без программы", () => {
    const { placement } = passagePlacement({ ...base, flow: flowOf(), passage: passage(), firstMessagesToday: 2 });
    expect(placement.today).toEqual({ firstMessages: 2 });
  });
});
