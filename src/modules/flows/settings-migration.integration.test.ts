import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, listVersions, saveDraft, validateLeadMagnetSettings } from "../lead-magnets";
import { createField, type FieldDefinition } from "../people";
import { firstAppSettings } from "./first-app.fixture";
import { translateSettingsToFlow } from "./settings-migration";
import { CONVERSATION_STATE_ID, DEADLINE_STATE_ID, FINAL_STATE_ID } from "./settings-to-flow";

let database: TestDatabase;
let fields: FieldDefinition[];

beforeAll(async () => {
  database = await createTestDatabase();
  fields = [
    await createField(database.db, { name: "Отзыв о App Studio", type: "text", description: "Короткий отзыв" }),
    await createField(database.db, { name: "Подписан на канал", type: "boolean", description: "" }),
  ];
});

afterAll(async () => {
  await database.drop();
});

/** Старые настройки «Твоего первого приложения» с настоящими полями словаря этой базы. */
function oldFirstApp() {
  const settings = firstAppSettings();
  const { flow: _flow, ...old } = {
    ...settings,
    fieldIds: fields.map((field) => field.id),
    program: { ...settings.program!, sideTasks: [{ id: "review", task: "Попроси отзыв", fieldId: fields[0]!.id, when: "" }] },
  };
  return old;
}

/** Черновик и все версии — как до перевода: без `flow`, с этими старыми настройками. */
async function rewind(id: string, old: object) {
  await database.db.execute(sql`update app.lead_magnets set draft = ${JSON.stringify(old)}::jsonb where id = ${id}`);
  await database.db.execute(sql`update app.lead_magnet_versions set settings = ${JSON.stringify(old)}::jsonb where lead_magnet_id = ${id}`);
}

async function hasFlow(id: string): Promise<{ draft: boolean; versions: boolean[] }> {
  const draft = await database.db.execute<{ has: boolean }>(sql`select draft ? 'flow' as has from app.lead_magnets where id = ${id}`);
  const versions = await database.db.execute<{ has: boolean }>(
    sql`select settings ? 'flow' as has from app.lead_magnet_versions where lead_magnet_id = ${id}`,
  );
  return { draft: draft.rows[0]!.has, versions: versions.rows.map((row) => row.has) };
}

describe("перевод сохранённых настроек в сценарий", () => {
  it("старый черновик с программой и все его версии и снимки → flow, который проходит проверку", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Твоё первое приложение" });
    await saveDraft(database.db, lead.id, { ...lead.draft, cardDescription: "вторая версия" }, "manual");
    await database.db.execute(sql`update app.lead_magnet_versions set is_snapshot = true where lead_magnet_id = ${lead.id}`);
    await rewind(lead.id, oldFirstApp());
    expect(await hasFlow(lead.id)).toEqual({ draft: false, versions: [false, false] });

    const result = await translateSettingsToFlow(database.db);
    expect(result).toMatchObject({ drafts: 1, versions: 2, unreadable: [], withErrors: [] });

    const { draft } = (await getLeadMagnet(database.db, lead.id))!;
    expect(() => validateLeadMagnetSettings(draft)).not.toThrow();
    expect(draft.flow.states.map((state) => state.title)).toEqual([...firstAppSettings().stages.map((stage) => stage.name), "Итог", "Срок вышел"]);
    expect(draft.flow.schedule).toMatchObject({ dayStart: "09:00", lengthDays: 3, deadlineState: DEADLINE_STATE_ID, farewellOnDeadline: false });
    expect(draft.flow.clientCard.map((field) => [field.name, field.type])).toEqual([
      ["Отзыв о App Studio", "text"],
      ["Подписан на канал", "boolean"],
    ]);
    expect(draft.flow.sideTasks).toEqual([{ id: "review", text: "Попроси отзыв", field: fields[0]!.id, maxAttempts: 2, perConversation: false }]);
    // Старые части остаются ради отката
    expect(draft.program?.days).toBe(3);
    expect(draft.stages).toHaveLength(6);

    for (const version of await listVersions(database.db, lead.id)) {
      expect(version.settings.flow).toEqual(draft.flow);
      expect(() => validateLeadMagnetSettings(version.settings)).not.toThrow();
    }
  });

  it("лидмагнит без этапов и программы → одна нода «Разговор» с напоминаниями бросившим", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Разбор" });
    const { flow: _flow, ...old } = lead.draft;
    await rewind(lead.id, old);
    await translateSettingsToFlow(database.db);
    const { draft } = (await getLeadMagnet(database.db, lead.id))!;
    expect(draft.flow.start).toBe(CONVERSATION_STATE_ID);
    expect(draft.flow.schedule).toBeUndefined();
    expect(draft.flow.nudges?.giveUpAfter).toEqual({ amount: 3, unit: "d" });
  });

  it("повторный запуск ничего не меняет; уже переведённое не трогается", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Уже со сценарием" });
    const before = (await getLeadMagnet(database.db, lead.id))!.draft;
    // Старые этапы расходятся со сценарием: перевод их не перечитывает
    await database.db.execute(
      sql`update app.lead_magnets set draft = jsonb_set(draft, '{stages}', ${JSON.stringify([{ id: "x", name: "X", instruction: "", transitionCondition: "", startDay: null, isSale: false }])}::jsonb) where id = ${lead.id}`,
    );
    expect(await translateSettingsToFlow(database.db)).toMatchObject({ drafts: 0, versions: 0 });
    expect((await getLeadMagnet(database.db, lead.id))!.draft.flow).toEqual(before.flow);
  });

  it("черновик со сценарием до правил 14.10: выход словами в «Итог» → finish_dialog, «длится N дней» в «Продажу» → день программы", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Старый сценарий" });
    await rewind(lead.id, oldFirstApp());
    await translateSettingsToFlow(database.db);
    const translated = (await getLeadMagnet(database.db, lead.id))!.draft.flow;
    const old = structuredClone(translated);
    // До 14.10: ноды первого дня — «длится 1 день» в «Доработку», из неё в «Продажу» — «длится 1 день»
    for (const state of old.states) {
      if (state.id === "stage-6") continue;
      state.exits = state.exits.map((exit) =>
        exit.to === "stage-6" && exit.when.type === "timer"
          ? state.id === "stage-5"
            ? { ...exit, when: { type: "timer", from: "state_days", days: 1 } }
            : { ...exit, when: { type: "timer", from: "state_days", days: 1 }, to: "stage-5" }
          : exit,
      );
    }
    const sale = old.states.find((state) => state.id === "stage-6")!;
    sale.exits = [{ id: "stage-6_done", when: { type: "judge", text: "Человек решил про курс" }, to: FINAL_STATE_ID }];
    await database.db.execute(sql`update app.lead_magnets set draft = jsonb_set(draft, '{flow}', ${JSON.stringify(old)}::jsonb) where id = ${lead.id}`);

    expect(await translateSettingsToFlow(database.db)).toMatchObject({ drafts: 0, versions: 0, updatedToRules: 1 });
    const draft = (await getLeadMagnet(database.db, lead.id))!.draft;
    expect(draft.flow.states.find((state) => state.id === "stage-6")!.exits).toEqual([
      { id: "stage-6_done", when: { type: "event", event: "tool", name: "finish_dialog" }, to: FINAL_STATE_ID },
    ]);
    expect(draft.flow.states.find((state) => state.id === "stage-5")!.exits.find((exit) => exit.to === "stage-6" && exit.when.type !== "judge")!.when).toEqual({
      type: "timer",
      from: "program_day",
      day: 3,
    });
    expect(await translateSettingsToFlow(database.db)).toMatchObject({ updatedToRules: 0 });
  });

  it("черновик с событием program_day_N (до SDK 0.55) — таймер «день N программы» при старте работника", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Событие дня" });
    await rewind(lead.id, oldFirstApp());
    await translateSettingsToFlow(database.db);
    const current = (await getLeadMagnet(database.db, lead.id))!.draft.flow;
    const legacy = structuredClone(current);
    for (const state of legacy.states)
      for (const exit of state.exits)
        if (exit.when.type === "timer" && exit.when.from === "program_day") exit.when = { type: "event", event: "app", name: `program_day_${exit.when.day}` };
    await database.db.execute(sql`update app.lead_magnets set draft = jsonb_set(draft, '{flow}', ${JSON.stringify(legacy)}::jsonb) where id = ${lead.id}`);

    expect(await translateSettingsToFlow(database.db)).toMatchObject({ updatedToRules: 1 });
    expect((await getLeadMagnet(database.db, lead.id))!.draft.flow).toEqual(current);
    expect(await translateSettingsToFlow(database.db)).toMatchObject({ updatedToRules: 0 });
  });

  it("настройки, которые не читаются, перевод пропускает и называет", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Сломанный" });
    await rewind(lead.id, { name: "Сломанный", stages: "не список" });
    const result = await translateSettingsToFlow(database.db);
    expect(result.unreadable).toContain(`draft:${lead.id}`);
    expect(await hasFlow(lead.id)).toEqual({ draft: false, versions: [false] });
  });
});
