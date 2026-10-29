import { describe, expect, it } from "vitest";
import { newLeadMagnetSettings, newProgramSettings, type LeadMagnetSettings } from "../lead-magnets/settings";
import { buildProgramTail, type ProgramTailInput } from "./tail";

const settings: LeadMagnetSettings = {
  ...newLeadMagnetSettings("Первое приложение"),
  stages: [
    { id: "start", name: "Знакомство", instruction: "Узнай идею.", transitionCondition: "Идея есть", startDay: null, isSale: false },
    { id: "build", name: "Сборка", instruction: "Помоги собрать.", transitionCondition: "Прислал ссылку", startDay: 2, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: 3, isSale: true },
  ],
  program: {
    ...newProgramSettings(3),
    sideTasks: [
      { id: "city", task: "Узнать город", fieldId: null, when: "" },
      { id: "review", task: "Попросить отзыв", fieldId: null, when: "когда доволен" },
    ],
  },
};

const base: ProgramTailInput = {
  settings,
  day: 2,
  // 06:40 UTC = 09:40 в Москве
  now: new Date("2026-10-13T06:40:00Z"),
  timeZone: null,
  currentStageId: "build",
  stageChangedByDay: false,
  dayLimit: "normal",
  messagesToday: 3,
  saleAnswer: null,
  sideTasks: {},
  personMessageCount: 10,
  backlogFromYesterday: false,
};

describe("хвост хода программы", () => {
  it("день из срока и местное время; пояс неизвестен — по Москве", () => {
    const tail = buildProgramTail(base);
    expect(tail).toMatch(/День 2 из 3/);
    expect(tail).toMatch(/09:40/);
    expect(tail).toMatch(/пояс неизвестен[^\n]*Москв/i);
  });

  it("известный пояс — время по нему", () => {
    const tail = buildProgramTail({ ...base, timeZone: "Asia/Novosibirsk" });
    expect(tail).toMatch(/13:40/);
    expect(tail).toContain("Asia/Novosibirsk");
    expect(tail).not.toMatch(/пояс неизвестен/i);
  });

  it("последний день отмечен", () => {
    expect(buildProgramTail({ ...base, day: 3, currentStageId: "sale" })).toMatch(/День 3 из 3[^\n]*последний/i);
    expect(buildProgramTail(base)).not.toMatch(/последний день/i);
  });

  it("последний день: прощание человека — конец программы, finish_dialog с итогом", () => {
    expect(buildProgramTail({ ...base, day: 3, currentStageId: "sale" })).toMatch(/прощание[^\n]*конец программы[^\n]*finish_dialog/i);
    expect(buildProgramTail(base)).not.toMatch(/конец программы/i);
  });

  it("сообщение первым молчуну — готовый следующий шаг, который можно просто скопировать", () => {
    for (const outreach of ["morning", "silence"] as const)
      expect(buildProgramTail({ ...base, outreach })).toMatch(/готов[^\n]*скопировать/i);
  });

  it("текущий этап, его инструкция и условие перехода", () => {
    const tail = buildProgramTail(base);
    expect(tail).toMatch(/Текущий этап: Сборка \(id: build\)/);
    expect(tail).toContain("Помоги собрать.");
    expect(tail).toContain("Прислал ссылку");
    expect(tail).not.toContain("Узнай идею.");
  });

  it("следующий этап включится сам в свой день", () => {
    expect(buildProgramTail(base)).toMatch(/«Продажа»[^\n]*сам[^\n]*день 3/i);
  });

  it("этап сменился по дню — сказано", () => {
    expect(buildProgramTail({ ...base, stageChangedByDay: true })).toMatch(/этап сменился сам[^\n]*день 2/i);
    expect(buildProgramTail(base)).not.toMatch(/сменился сам/i);
  });

  it("рамки дня: мягкая — прощаться до завтра, последнее сообщение — до утра", () => {
    expect(buildProgramTail(base)).not.toMatch(/до завтра|до утра/i);
    expect(buildProgramTail({ ...base, dayLimit: "soft", messagesToday: 22 })).toMatch(/22[^\n]*по-доброму[^\n]*до завтра/i);
    const last = buildProgramTail({ ...base, dayLimit: "last", messagesToday: 30 });
    expect(last).toMatch(/последнее сообщение человека на сегодня/i);
    expect(last).toMatch(/продолжим утром/i);
    expect(last).toMatch(/finish_dialog не вызывай/i);
  });

  it("новый день после рамки — сначала ответь на вчерашнее", () => {
    expect(buildProgramTail({ ...base, backlogFromYesterday: true })).toMatch(/новый день[^\n]*сначала ответь[^\n]*вчера/i);
    expect(buildProgramTail(base)).not.toMatch(/вчера/i);
  });

  it("продажа: твёрдое «нет» — не продавай", () => {
    const tail = buildProgramTail({
      ...base,
      currentStageId: "sale",
      saleAnswer: { reason: "not_interested", firm: true, softHandled: false, lastOfferDay: 2 },
    });
    expect(tail).toMatch(/твёрдо[^\n]*не продавай/i);
  });

  it("продажа: мягкое «нет» ещё не разобрано — разобраться один раз", () => {
    const tail = buildProgramTail({
      ...base,
      currentStageId: "sale",
      saleAnswer: { reason: "price", firm: false, softHandled: false, lastOfferDay: 2 },
    });
    expect(tail).toMatch(/мягк[^\n]*цена[^\n]*один раз/i);
  });

  it("продажа: мягкий отказ разобран — не продавай, пока сам не упрётся; в последний день — одно предложение с новой стороны", () => {
    const answer = { reason: "time" as const, firm: false, softHandled: true, lastOfferDay: 2 };
    const day2 = buildProgramTail({ ...base, currentStageId: "sale", saleAnswer: answer });
    expect(day2).toMatch(/мягкий отказ уже разобран[^\n]*не продавай[^\n]*упрётся/i);
    expect(day2).not.toMatch(/новой стороны/i);
    const lastDay = buildProgramTail({ ...base, day: 3, currentStageId: "sale", saleAnswer: answer });
    expect(lastDay).toMatch(/последний день[^\n]*одно предложение[^\n]*новой стороны/i);
    const offeredToday = buildProgramTail({ ...base, day: 3, currentStageId: "sale", saleAnswer: { ...answer, lastOfferDay: 3 } });
    expect(offeredToday).not.toMatch(/новой стороны/i);
  });

  it("сообщение первым после мягкого «нет» не продаёт; в последний день — одно предложение только утром", () => {
    const fresh = { reason: "doubt" as const, firm: false, softHandled: false, lastOfferDay: 2 };
    for (const outreach of ["morning", "silence"] as const) {
      const tail = buildProgramTail({ ...base, currentStageId: "sale", saleAnswer: fresh, outreach });
      expect(tail).toMatch(/отказал[^\n]*не продавай[^\n]*цен/i);
      expect(tail).not.toMatch(/разберись/i);
    }
    const handled = { ...fresh, softHandled: true };
    expect(buildProgramTail({ ...base, currentStageId: "sale", saleAnswer: handled, outreach: "silence" })).toMatch(/не продавай[^\n]*цен/i);
    const lastMorning = buildProgramTail({ ...base, day: 3, currentStageId: "sale", saleAnswer: handled, outreach: "morning" });
    expect(lastMorning).toMatch(/последний день[^\n]*одно предложение[^\n]*новой стороны/i);
    const lastSilence = buildProgramTail({ ...base, day: 3, currentStageId: "sale", saleAnswer: handled, outreach: "silence" });
    expect(lastSilence).not.toMatch(/новой стороны/i);
    expect(lastSilence).toMatch(/не продавай/i);
  });

  it("попутные задачи — открытые по id (текст и условия в инструкции); после вопроса — не раньше чем через 5 сообщений", () => {
    const open = buildProgramTail(base);
    expect(open).toMatch(/попутн[^\n]*city, review/i);
    expect(open).not.toContain("Узнать город");
    const justAsked = buildProgramTail({ ...base, sideTasks: { lastAskedAtMessage: 8 } });
    expect(justAsked).not.toMatch(/попутн/i);
    const done = buildProgramTail({ ...base, sideTasks: { done: ["city"], lastAskedAtMessage: 2 } });
    expect(done).toMatch(/попутн[^\n]*review/i);
    expect(done).not.toMatch(/city/);
  });

  it("без этапов — только день, время и рамки", () => {
    const tail = buildProgramTail({ ...base, settings: { ...settings, stages: [] }, currentStageId: null });
    expect(tail).toMatch(/День 2 из 3/);
    expect(tail).not.toMatch(/этап/i);
  });

  it("ход «писать первым»: утром — тема дня, при молчании — новое после прошлых; пустое «вы тут?» нельзя", () => {
    const morning = buildProgramTail({ ...base, outreach: "morning" });
    expect(morning).toMatch(/Утро нового дня[^\n]*напиши первым[^\n]*по теме дня/);
    expect(morning).toMatch(/«вы тут\?»[^\n]*нельзя/);
    const silence = buildProgramTail({ ...base, outreach: "silence" });
    expect(silence).toMatch(/молчит[^\n]*напиши первым[^\n]*нов/);
    expect(silence).toMatch(/не повторяй/);
    expect(buildProgramTail(base)).not.toMatch(/напиши первым/);
  });

  it("хвост не длиннее места SDK (4000 знаков) при длинных инструкциях", () => {
    const long = "а".repeat(1500);
    const tail = buildProgramTail({
      ...base,
      settings: {
        ...settings,
        stages: settings.stages.map((s) => ({ ...s, instruction: long })),
        program: { ...settings.program!, sideTasks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, task: long.slice(0, 300), fieldId: null, when: long.slice(0, 300) })) },
      },
      dayLimit: "soft",
      saleAnswer: { reason: "price", firm: false, softHandled: true, lastOfferDay: 2 },
    });
    expect(tail.length).toBeLessThanOrEqual(4000);
    expect(tail).toContain(long);
  });
});
