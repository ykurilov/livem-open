// «Люди → Откуда пришли»: сколько людей привёл каждый источник, сколько из них дошли до конца и купили
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { passages, type PassageStatus } from "../conversations/schema";
import { archiveEntryLink, createLabeledLink } from "../lead-magnets/links";
import { countPeople, listPeople } from "./filters";
import { mskDayStart, sourcesReport, type SourcesReport } from "./sources";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const DAY = 24 * 60 * 60 * 1000;
/** День по Москве `days` дней назад — так экран задаёт начало периода. */
const mskDayAgo = (days: number) => new Date(Date.now() + 3 * 60 * 60 * 1000 - days * DAY).toISOString().slice(0, 10);

interface Outcome {
  status?: PassageStatus;
  costUsd?: string;
  purchased?: boolean;
  daysAgo?: number;
}

/** Человек начинает лидмагнит по коду; прохождению ставятся статус, расход, покупка и дата начала. */
async function arrive(kit: LiveDialogKit, code: string, outcome: Outcome & { person?: string } = {}): Promise<string> {
  const person = outcome.person ?? `user-${randomUUID().slice(0, 8)}`;
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.drain();
  const passage = (await kit.passagesOf(person)).at(-1)!;
  await database.db
    .update(passages)
    .set({
      status: outcome.status ?? "completed",
      costUsd: outcome.costUsd ?? "0",
      purchasedAt: outcome.purchased ? new Date() : null,
      startedAt: new Date(Date.now() - (outcome.daysAgo ?? 0) * DAY),
    })
    .where(eq(passages.id, passage.id));
  return person;
}

/** Ещё одно прохождение того же лидмагнита: «Начать заново», возврат через меню (`entryLinkId: null`) или снова по ссылке. */
async function startAgain(kit: LiveDialogKit, person: string, again: Outcome & { entryLinkId: string | null }) {
  const [first] = await kit.passagesOf(person);
  await database.db.insert(passages).values({
    personId: first!.personId,
    leadMagnetId: first!.leadMagnetId,
    snapshotId: first!.snapshotId,
    entryLinkId: again.entryLinkId,
    chatId: `again-${randomUUID()}`,
    status: again.status ?? "not_completed",
    costUsd: again.costUsd ?? "0",
    purchasedAt: again.purchased ? new Date() : null,
    startedAt: new Date(Date.now() - (again.daysAgo ?? 0) * DAY),
  });
}

const table = (report: SourcesReport) => report.rows.map((row) => [row.label, row.kind, row.arrived, row.completed, row.purchased]);

describe("отчёт «Откуда пришли»", () => {
  it("строка — люди, а не прохождения: повторный старт и возврат через меню не добавляют ни прихода, ни строки", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish({ name: "Разбор воронки" });
    const masha = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "блогер_маша" });
    const vk = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "vk_video_01" });
    await arrive(kit, masha.code, { costUsd: "0.10", purchased: true });
    const twice = await arrive(kit, masha.code, { costUsd: "0.20" });
    // Дошёл до конца дважды: «Начать заново» по той же метке и ещё раз через меню бота
    await startAgain(kit, twice, { entryLinkId: masha.id, status: "completed", costUsd: "0.03" });
    await startAgain(kit, twice, { entryLinkId: null, costUsd: "0.02" });
    await arrive(kit, masha.code, { status: "not_completed", costUsd: "0.05" });
    await arrive(kit, vk.code, { status: "active", costUsd: "0.01" });
    await arrive(kit, lead.code, { costUsd: "0.50" });
    await arrive(kit, lead.code, { status: "not_completed" });

    const report = await sourcesReport(database.db, { sinceDay: null, leadMagnetId: lead.leadMagnetId });

    expect(table(report)).toEqual([
      ["блогер_маша", "label", 3, 2, 1],
      [null, "main", 2, 1, 0],
      ["vk_video_01", "label", 1, 0, 0],
    ]);
    expect(report.rows[0]).toMatchObject({ linkId: masha.id, leadMagnetId: lead.leadMagnetId, leadMagnetName: "Разбор воронки", archived: false });
    // Расход — все разговоры этих людей в лидмагните, и повторные тоже
    expect(report.rows[0]!.costUsd).toBeCloseTo(0.4, 6);
    expect(report.totals).toEqual({ arrived: 6, completed: 3, purchased: 1 });
  });

  it("приход — первый старт человека: в периоде считаются пришедшие в нём; купили — те из них, кто купил к сегодняшнему дню", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    const fresh = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "свежая" });
    const old = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "старая" });
    await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "тишина" });
    const gone = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "убрана" });
    await archiveEntryLink(database.db, gone.id);
    // Пришёл 40 дней назад, вчера начал заново по той же ссылке и сегодня купил: в «30 дней» он не новый приход
    const veteran = await arrive(kit, old.code, { daysAgo: 40 });
    await startAgain(kit, veteran, { entryLinkId: old.id, daysAgo: 1, purchased: true });
    // Пришёл неделю назад, купил сегодня — покупка засчитана его приходу
    await arrive(kit, fresh.code, { daysAgo: 7, purchased: true });

    const month = await sourcesReport(database.db, { sinceDay: mskDayAgo(29), leadMagnetId: lead.leadMagnetId });
    expect(table(month)).toEqual([
      ["свежая", "label", 1, 1, 1],
      ["старая", "label", 0, 0, 0],
      ["тишина", "label", 0, 0, 0],
    ]);
    expect(month.totals).toEqual({ arrived: 1, completed: 1, purchased: 1 });

    const always = await sourcesReport(database.db, { sinceDay: null, leadMagnetId: lead.leadMagnetId });
    expect(table(always)).toEqual([
      ["свежая", "label", 1, 1, 1],
      ["старая", "label", 1, 1, 1],
      ["тишина", "label", 0, 0, 0],
    ]);
  });

  it("период — календарные дни по Москве: начало дня, а не «сейчас минус сутки»", async () => {
    expect(mskDayStart("2026-11-11").toISOString()).toBe("2026-11-10T21:00:00.000Z");
  });

  it("архивная метка с людьми остаётся с отметкой; первый старт без ссылки — отдельной строкой", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    const archived = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "весна" });
    await arrive(kit, archived.code);
    await archiveEntryLink(database.db, archived.id);
    const person = await arrive(kit, lead.code);
    const [passage] = await kit.passagesOf(person);
    await database.db.update(passages).set({ entryLinkId: null }).where(eq(passages.id, passage!.id));

    const report = await sourcesReport(database.db, { sinceDay: null, leadMagnetId: lead.leadMagnetId });
    expect(report.rows).toContainEqual(expect.objectContaining({ linkId: archived.id, label: "весна", archived: true, arrived: 1 }));
    expect(report.rows).toContainEqual(expect.objectContaining({ linkId: null, kind: "none", leadMagnetId: lead.leadMagnetId, arrived: 1 }));
    expect(report.rows.some((row) => row.kind === "main")).toBe(false);
  });

  it("без фильтра — все лидмагниты; человек в двух лидмагнитах в итоге один раз", async () => {
    const kit = await createLiveDialogKit(database);
    const first = await kit.publish({ name: "Первый" });
    const second = await kit.publish({ name: "Второй" });
    const before = await sourcesReport(database.db, { sinceDay: null });
    const person = await arrive(kit, first.code);
    await arrive(kit, second.code, { person });

    const report = await sourcesReport(database.db, { sinceDay: null });
    const ours = report.rows.filter((row) => row.leadMagnetId === first.leadMagnetId || row.leadMagnetId === second.leadMagnetId);
    expect(ours.map((row) => [row.leadMagnetName, row.arrived]).sort()).toEqual([
      ["Второй", 1],
      ["Первый", 1],
    ]);
    expect(report.totals.arrived - before.totals.arrived).toBe(1);
  });

  it("число «Пришли» открывает ровно этих людей: фильтр списка по приходу совпадает с каждой строкой", async () => {
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish();
    const ad = await createLabeledLink(database.db, { leadMagnetId: lead.leadMagnetId, label: "реклама" });
    await arrive(kit, ad.code, { daysAgo: 2 });
    const back = await arrive(kit, ad.code, { daysAgo: 3 });
    await startAgain(kit, back, { entryLinkId: null });
    const veteran = await arrive(kit, ad.code, { daysAgo: 60 });
    await startAgain(kit, veteran, { entryLinkId: ad.id, daysAgo: 1 });
    const direct = await arrive(kit, lead.code, { daysAgo: 1 });
    const [directPassage] = await kit.passagesOf(direct);
    await database.db.update(passages).set({ entryLinkId: null }).where(eq(passages.id, directPassage!.id));

    const sinceDay = mskDayAgo(29);
    const report = await sourcesReport(database.db, { sinceDay, leadMagnetId: lead.leadMagnetId });
    expect(report.rows.map((row) => [row.kind, row.arrived])).toEqual([
      ["label", 2],
      ["none", 1],
    ]);
    for (const row of report.rows) {
      const filter = { arrival: { leadMagnetId: row.leadMagnetId, linkId: row.linkId, sinceDay } };
      expect(await countPeople(database.db, filter)).toBe(row.arrived);
      expect(await listPeople(database.db, filter)).toHaveLength(row.arrived);
    }
  });
});
