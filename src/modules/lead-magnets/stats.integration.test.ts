// Средняя цена прохождения на карточке и отчёт лидмагнита по меткам и этапам (US8)
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { passages, type PassageStatus } from "../conversations/schema";
import { listLeadMagnetCards } from "./lead-magnets";
import { archiveEntryLink, createLabeledLink } from "./links";
import { outboundMessages } from "../channels/schema";
import { inboundMessages } from "../conversations/schema";
import { people } from "../people/schema";
import { modelUsage } from "../spending/schema";
import { newProgramSettings } from "./settings";
import { leadMagnetReport, programReport } from "./stats";
import { LEAD_MAGNET_TOOLS } from "../flows/catalog";
import { SALE_TAG } from "../flows/settings-to-flow";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("средняя цена прохождения", () => {
  it("среднее по завершённым; незавершённые не считаются; без завершённых — цены нет", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    const passageWith = async (status: PassageStatus, costUsd: string) => {
      const person = `user-${randomUUID().slice(0, 8)}`;
      await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
      await kit.drain();
      const [passage] = await kit.passagesOf(person);
      await database.db.update(passages).set({ status, costUsd }).where(eq(passages.id, passage!.id));
    };
    await passageWith("completed", "0.10");
    await passageWith("completed", "0.30");
    await passageWith("active", "5");
    await passageWith("not_completed", "7");
    const empty = await kit.publish();

    const cards = await listLeadMagnetCards(database.db);
    expect(cards.find((card) => card.id === lead.leadMagnetId)!.averagePassageCostUsd).toBeCloseTo(0.2, 6);
    expect(cards.find((card) => card.id === empty.leadMagnetId)!.averagePassageCostUsd).toBeNull();
  });
});

describe("отчёт лидмагнита", () => {
  const STAGES = [
    { id: "goal", name: "Цель", instruction: "Узнай цель", transitionCondition: "Цель названа", startDay: null, isSale: false },
    { id: "pain", name: "Где застрял", instruction: "Узнай, где застрял", transitionCondition: "Названо", startDay: null, isSale: false },
    { id: "step", name: "Следующий шаг", instruction: "Предложи шаг", transitionCondition: "Выбран", startDay: null, isSale: false },
  ];

  it("по меткам: пришло, завершило, стоимость; архивная метка остаётся в отчёте", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    const masha = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Блогер Маша" });
    const vk = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Реклама ВК" });
    const silent = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "Пока без людей" });
    const arrive = async (code: string, status: PassageStatus, costUsd: string) => {
      const person = `user-${randomUUID().slice(0, 8)}`;
      await kit.send(person, `/start ${code}`, { startCode: code });
      await kit.drain();
      const [passage] = await kit.passagesOf(person);
      await database.db.update(passages).set({ status, costUsd }).where(eq(passages.id, passage!.id));
    };
    await arrive(masha.code, "completed", "0.10");
    await arrive(masha.code, "completed", "0.20");
    await arrive(masha.code, "not_completed", "0.05");
    await arrive(vk.code, "active", "0.01");
    await arrive(lead.code, "completed", "0.50");
    await archiveEntryLink(database.db, vk.id);

    const report = await leadMagnetReport(database.db, lead.leadMagnetId);

    const row = (linkId: string) => report.byLink.find((entry) => entry.linkId === linkId);
    expect(row(masha.id)).toMatchObject({ label: "Блогер Маша", isMain: false, archived: false, arrived: 3, completed: 2 });
    expect(row(masha.id)!.costUsd).toBeCloseTo(0.35, 6);
    expect(row(vk.id)).toMatchObject({ label: "Реклама ВК", archived: true, arrived: 1, completed: 0 });
    expect(row(silent.id)).toMatchObject({ arrived: 0, completed: 0, costUsd: 0 });
    const main = report.byLink.find((entry) => entry.isMain)!;
    expect(main).toMatchObject({ label: null, arrived: 1, completed: 1 });
    expect(main.costUsd).toBeCloseTo(0.5, 6);
    // Основная ссылка — первой
    expect(report.byLink[0]!.isMain).toBe(true);
  });

  it("пришедшие без ссылки (лидмагнит по умолчанию, меню) — отдельной строкой", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    const person = `user-${randomUUID().slice(0, 8)}`;
    await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
    await kit.drain();
    const [passage] = await kit.passagesOf(person);
    await database.db.update(passages).set({ entryLinkId: null, costUsd: "0.04" }).where(eq(passages.id, passage!.id));

    const report = await leadMagnetReport(database.db, lead.leadMagnetId);

    expect(report.byLink.find((entry) => entry.linkId === null)).toMatchObject({ label: null, isMain: false, arrived: 1 });
    expect(report.byLink.find((entry) => entry.isMain)).toMatchObject({ arrived: 0 });
  });

  it("по этапам: сколько людей остановилось на каждом; завершившие и идущие не считаются", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish({ stages: STAGES });
    const stopAt = async (stageId: string | null, status: PassageStatus) => {
      const person = `user-${randomUUID().slice(0, 8)}`;
      await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
      await kit.drain();
      const [passage] = await kit.passagesOf(person);
      await database.db.update(passages).set({ status, currentStageId: stageId }).where(eq(passages.id, passage!.id));
    };
    await stopAt(null, "not_completed"); // этап ещё не сменился — значит, первый
    await stopAt("pain", "not_completed");
    await stopAt("pain", "blocked");
    await stopAt("step", "not_completed");
    await stopAt("step", "completed");
    await stopAt("goal", "active");

    const report = await leadMagnetReport(database.db, lead.leadMagnetId);

    expect(report.stoppedByStage).toEqual([
      { stageId: "goal", name: "Цель", stopped: 1 },
      { stageId: "pain", name: "Где застрял", stopped: 2 },
      { stageId: "step", name: "Следующий шаг", stopped: 1 },
    ]);
  });

  it("по нодам сценария: названия и ноды с доски, а не устаревшие этапы настроек", async () => {
    const kit = await createLiveDialogKit(database);
    // На доске «Где застрял» переименовали, а «Следующий шаг» убрали из маршрута: в старых этапах этого нет
    const lead = await kit.publish({ stages: STAGES }, (flow) => ({
      ...flow,
      states: flow.states.map((state) =>
        state.id === "pain" ? { ...state, title: "Где буксует" } : state.id === "step" ? { ...state, title: "Разбор" } : state,
      ),
    }));
    const stopAt = async (stageId: string | null) => {
      const person = `user-${randomUUID().slice(0, 8)}`;
      await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
      await kit.drain();
      const [passage] = await kit.passagesOf(person);
      await database.db.update(passages).set({ status: "not_completed", currentStageId: stageId }).where(eq(passages.id, passage!.id));
    };
    await stopAt(null);
    await stopAt("pain");

    const report = await leadMagnetReport(database.db, lead.leadMagnetId);

    expect(report.stoppedByStage).toEqual([
      { stageId: "goal", name: "Цель", stopped: 1 },
      { stageId: "pain", name: "Где буксует", stopped: 1 },
      { stageId: "step", name: "Разбор", stopped: 0 },
    ]);
  });

  it("лидмагнит без этапов — разбивки по этапам нет", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    expect((await leadMagnetReport(database.db, lead.leadMagnetId)).stoppedByStage).toEqual([]);
  });
});

describe("отчёт «Программа»", () => {
  const STAGES = [
    { id: "intro", name: "Знакомство", instruction: "Знакомься", transitionCondition: "Познакомились", startDay: null, isSale: false },
    { id: "sale", name: "Продажа", instruction: "Предложи", transitionCondition: "Ответил", startDay: 3, isSale: true },
  ];
  const at = (iso: string) => new Date(iso);

  async function arrive(kit: Awaited<ReturnType<typeof createLiveDialogKit>>, code: string, patch: Partial<typeof passages.$inferInsert>) {
    const person = `user-${randomUUID().slice(0, 8)}`;
    await kit.send(person, `/start ${code}`, { startCode: code });
    await kit.drain();
    const [passage] = await kit.passagesOf(person);
    await database.db.update(passages).set({ programStartDate: "2026-10-01", ...patch }).where(eq(passages.id, passage!.id));
    // Первое сообщение человека (старт) было в день начала, до всех сообщений бота первым
    await database.db.update(inboundMessages).set({ receivedAt: at("2026-10-01T09:00:00Z") }).where(eq(inboundMessages.passageId, passage!.id));
    return passage!;
  }

  it("до продажи — по метке «продажа» у ноды сценария, а не по старому этапу", async () => {
    const kit = await createLiveDialogKit(database);
    const stages = [
      STAGES[0]!,
      { id: "offer", name: "Предложение", instruction: "Предложи", transitionCondition: "Ответил", startDay: 2, isSale: false },
      STAGES[1]!,
    ];
    // На доске «Продажу» перенесли в «Предложение»: в старых этапах продажа всё ещё в «sale»
    const lead = await kit.publish({ stages, program: newProgramSettings(3) }, (flow) => ({
      ...flow,
      states: flow.states.map((state) => {
        if (state.id === "offer") return { ...state, tags: [SALE_TAG], tools: [...state.tools, LEAD_MAGNET_TOOLS.saleAnswer] };
        if (state.id === "sale") return { ...state, tags: [], tools: state.tools.filter((tool) => tool !== LEAD_MAGNET_TOOLS.saleAnswer) };
        return state;
      }),
    }));
    await arrive(kit, lead.code, { furthestDay: 2, stageHistory: [{ stageId: "offer", at: "2026-10-02T10:00:00Z", by: "day" }] });
    await arrive(kit, lead.code, { furthestDay: 2, stageHistory: [{ stageId: "offer", at: "2026-10-02T10:00:00Z", by: "model" }] });
    await arrive(kit, lead.code, { furthestDay: 3, stageHistory: [{ stageId: "sale", at: "2026-10-03T10:00:00Z", by: "day" }] });

    expect((await programReport(database.db, kit.chatStorage, lead.leadMagnetId))!.reachedSale).toBe(2);
  });

  it("лидмагнит без программы — отчёта «Программа» нет", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    expect(await programReport(database.db, kit.chatStorage, lead.leadMagnetId)).toBeNull();
  });

  it("дни, продажа, возвраты после сообщений первым, причины отказа, цена касаний и судьи", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish({ stages: STAGES, program: newProgramSettings(3) });
    const day1 = await arrive(kit, lead.code, { furthestDay: 1 });
    const day2 = await arrive(kit, lead.code, { furthestDay: 2 });
    const sold = await arrive(kit, lead.code, {
      furthestDay: 3,
      stageHistory: [{ stageId: "sale", at: "2026-10-03T10:00:00Z", by: "day" }],
      saleAnswer: { reason: "price", firm: true, softHandled: true, lastOfferDay: 3 },
    });
    const doubtful = await arrive(kit, lead.code, {
      furthestDay: 3,
      stageHistory: [{ stageId: "sale", at: "2026-10-03T10:00:00Z", by: "model", reason: "показал готовность" }],
      saleAnswer: { reason: "doubt", firm: false, softHandled: false, lastOfferDay: 3 },
    });
    // Без программы: в отчёт не попадает
    await arrive(kit, lead.code, { furthestDay: 3, programStartDate: null });

    const outreachFor = async (passage: typeof day1, createdAt: Date) => {
      const [{ personId, botId }] = (await database.db
        .select({ personId: passages.personId, botId: outboundMessages.botId })
        .from(passages)
        .leftJoin(outboundMessages, eq(outboundMessages.passageId, passages.id))
        .where(eq(passages.id, passage.id))
        .limit(1)) as [{ personId: string; botId: string | null }];
      await database.db.insert(outboundMessages).values({
        botId: botId!, personId, passageId: passage.id, kind: "outreach", text: "Как дела?", status: "sent",
        idempotencyKey: randomUUID(), createdAt,
      });
    };
    const answerFrom = async (passage: typeof day1, receivedAt: Date) => {
      const [row] = await database.db.select({ botId: inboundMessages.botId, personId: inboundMessages.personId }).from(inboundMessages).where(eq(inboundMessages.passageId, passage.id)).limit(1);
      await database.db.insert(inboundMessages).values({
        botId: row!.botId, kind: "message", dedupeKey: randomUUID(), externalUserId: "x", text: "я тут", personId: row!.personId, passageId: passage.id, receivedAt,
      });
    };
    // day2: два сообщения первым; на первое ответил, на второе молчит
    await outreachFor(day2, at("2026-10-02T10:00:00Z"));
    await answerFrom(day2, at("2026-10-02T11:00:00Z"));
    await outreachFor(day2, at("2026-10-02T14:00:00Z"));
    // day1: сообщение первым без ответа
    await outreachFor(day1, at("2026-10-02T10:00:00Z"));
    // sold: сообщение первым, ответ после него
    await outreachFor(sold, at("2026-10-02T10:00:00Z"));
    await answerFrom(sold, at("2026-10-02T12:00:00Z"));
    // Ответ человека ДО сообщения первым не считается возвратом
    await outreachFor(doubtful, at("2026-10-02T10:00:00Z"));
    // Цена касаний — журнал SDK, строка first_message; судья сценария — строка judge; ответы на человека — не в счёт
    await kit.spend(day2.personId, 0.01, day2.chatId, "first_message");
    await kit.spend(day2.personId, 0.02, day2.chatId, "first_message");
    await kit.spend(sold.personId, 0.005, sold.chatId, "first_message");
    await kit.spend(day2.personId, 9, day2.chatId);
    await kit.spend(day1.personId, 0.004, day1.chatId, "judge");
    await kit.spend(sold.personId, 0.003, sold.chatId, "judge");
    // Сообщения первым программы до сценариев (своя запись расхода) — тоже касания; тексты напоминаний — нет
    await database.db.insert(modelUsage).values([
      { kind: "program_message", passageId: doubtful.id, costUsd: "0.001000", createdAt: at("2026-10-02T10:00:00Z") },
      { kind: "reminder_text", passageId: day1.id, costUsd: "9.000000", createdAt: at("2026-10-02T10:00:00Z") },
    ]);

    const report = (await programReport(database.db, kit.chatStorage, lead.leadMagnetId))!;

    expect(report.days).toBe(3);
    expect(report.passages).toBe(4);
    expect(report.reachedDay).toEqual([
      { day: 1, count: 4 },
      { day: 2, count: 3 },
      { day: 3, count: 2 },
    ]);
    expect(report.reachedSale).toBe(2);
    expect(report.outreach.messages).toBe(5);
    expect(report.outreach.messagesAnswered).toBe(2);
    expect(report.outreach.people).toBe(4);
    expect(report.outreach.peopleReturned).toBe(2);
    expect(report.outreach.costUsd).toBeCloseTo(0.036, 6);
    expect(report.judgeCostUsd).toBeCloseTo(0.007, 6);
    expect(report.refusalReasons).toEqual([
      { reason: "price", count: 1 },
      { reason: "doubt", count: 1 },
    ]);
  });
});
