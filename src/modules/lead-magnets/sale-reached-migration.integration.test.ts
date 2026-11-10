// Миграция 0048: отметка «дошёл до продажи на прежней версии» у прохождений, переведённых до неё (по строкам «Лога»)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { passages } from "../conversations/schema";
import { LEAD_MAGNET_TOOLS } from "../flows/catalog";
import { migrateLiveChats } from "../flows/chat-migration";
import { SALE_TAG } from "../flows/settings-to-flow";
import { getLeadMagnet, saveDraft } from "./lead-magnets";
import { publishLeadMagnet } from "./publish";
import { newProgramSettings } from "./settings";
import { programReport } from "./stats";

/** Колонка уже создана миграциями тестовой базы — повторяем только заполнение. */
const BACKFILL = readFileSync(path.join(process.cwd(), "drizzle", "0048_sale_reached_earlier.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => /^UPDATE\b/im.test(statement.replace(/^(--.*\n)+/gm, "").trim()));

const STAGES = [
  { id: "intro", name: "Знакомство", instruction: "Знакомься", transitionCondition: "Познакомились", startDay: null, isSale: false },
  { id: "offer", name: "Предложение", instruction: "Предложи", transitionCondition: "Ответил", startDay: 2, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи", transitionCondition: "Ответил", startDay: 3, isSale: true },
];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("миграция 0048: дошедшие до продажи на прежней версии", () => {
  it("переведённый раньше прошедший продажу получает отметку; кто был в той ноде уже на новой версии или не был в продаже — нет", async () => {
    expect(BACKFILL).toHaveLength(1);
    const kit = await createLiveDialogKit(database);
    const lead = await kit.publish({ stages: STAGES, program: newProgramSettings(3) });
    const arrive = async () => {
      const person = `user-${randomUUID().slice(0, 8)}`;
      await kit.send(person, `/start ${lead.code}`, { startCode: lead.code });
      await kit.drain();
      return (await kit.passagesOf(person))[0]!;
    };
    const sold = await arrive();
    const walking = await arrive();
    const soldLater = await arrive();

    // Вторая версия: «Продажа» в «Предложении»
    const current = (await getLeadMagnet(database.db, lead.leadMagnetId))!;
    const flow: AgentFlow = {
      ...current.draft.flow,
      states: current.draft.flow.states.map((state) => {
        if (state.id === "offer") return { ...state, tags: [SALE_TAG], tools: [...state.tools, LEAD_MAGNET_TOOLS.saleAnswer] };
        if (state.id === "sale") return { ...state, tags: [], tools: state.tools.filter((tool) => tool !== LEAD_MAGNET_TOOLS.saleAnswer) };
        return state;
      }),
    };
    await saveDraft(database.db, lead.leadMagnetId, { ...current.draft, flow }, "manual");
    await publishLeadMagnet(database.db, lead.leadMagnetId);

    const now = Date.now();
    const migratedAt = new Date(now + 60 * 60_000);
    const stageAt = (stageId: string, at: number) => [{ stageId, at: new Date(at).toISOString(), by: "day" as const }];
    const set = (passage: { id: string }, patch: Partial<typeof passages.$inferInsert>) =>
      database.db.update(passages).set({ programStartDate: "2026-10-01", ...patch }).where(eq(passages.id, passage.id));
    await set(sold, { currentStageId: "sale", stageHistory: stageAt("sale", now) });
    await set(walking, { currentStageId: "intro", stageHistory: stageAt("intro", now) });
    await set(soldLater, { currentStageId: "intro" });
    await migrateLiveChats(database.db, { leadMagnetId: lead.leadMagnetId, map: {}, by: { email: "expert@example.com" }, at: migratedAt });
    // Перевод до миграции: снимок сменился, отметки не было. В «sale» пришёл уже на второй версии, где это не продажа
    await database.db.update(passages).set({ saleReachedEarlier: false }).where(eq(passages.leadMagnetId, lead.leadMagnetId));
    await set(soldLater, { currentStageId: "sale", stageHistory: stageAt("sale", now + 2 * 60 * 60_000) });
    expect((await programReport(database.db, kit.chatStorage, lead.leadMagnetId))!.reachedSale).toBe(0);

    for (const statement of BACKFILL) await database.db.execute(sql.raw(statement));

    const marks = await database.db.select({ id: passages.id, saleReachedEarlier: passages.saleReachedEarlier }).from(passages).where(eq(passages.leadMagnetId, lead.leadMagnetId));
    expect(new Map(marks.map((mark) => [mark.id, mark.saleReachedEarlier]))).toEqual(
      new Map([
        [sold.id, true],
        [walking.id, false],
        [soldLater.id, false],
      ]),
    );
    expect((await programReport(database.db, kit.chatStorage, lead.leadMagnetId))!.reachedSale).toBe(1);
  });
});
