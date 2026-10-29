import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import previous from "../../../docs/lead-magnets/history/first-app-six-states.json";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { applyAgentInput, parseAgentInput } from "../lead-magnet-cli/agent-settings";
import { getLeadMagnet, getVersion, lockLeadMagnet, saveDraft } from "../lead-magnets";
import { publishLeadMagnet } from "../lead-magnets/publish";
import { migrateLiveChats } from "./chat-migration";
import { firstAppExpected, FIRST_APP_STATE_MAP, FIRST_APP_DURABLE_GATE_READY, simplifiedFirstAppSettings, runFirstAppRollout } from "./first-app-rollout";
import { applyChatMigration } from "./chat-migration";
import { saveEditBesideConstructor } from "../constructor/manual-edits";
import { newLeadMagnetSettings } from "../lead-magnets/settings";

vi.mock("./first-app-readiness", () => ({ FIRST_APP_DURABLE_GATE_READY: false }));

let database: TestDatabase;
let kit: LiveDialogKit;
let id: string;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database.drop(); });
beforeEach(async () => {
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
  // Этот тест проверяет перенос; стандартная подделка реагирует на слово «готов» в приложенном контексте ноды.
  kit.reply = () => ({ text: "Продолжаем." });
  const settings = await applyAgentInput(database.db, newLeadMagnetSettings("first-app"), parseAgentInput(JSON.stringify(previous)), { creating: true });
  const lead = await kit.publish(settings);
  id = lead.leadMagnetId;
});
const lead = async () => (await getLeadMagnet(database.db, id))!;
async function run(mode: "plan" | "draft" | "publish" | "migrate", expected?: ReturnType<typeof firstAppExpected>) {
  return runFirstAppRollout(database.db, { mode, expected: expected ?? firstAppExpected(await lead()), by: { email: "expert@example.com" }, at: kit.clock.now(), leadMagnetId: id });
}
// Независимый путь подготовки изолированных fixtures; production rollout не имеет force/env/test bypass.
async function saveCandidateFixture(expected?: ReturnType<typeof firstAppExpected>) {
  const target = expected ?? firstAppExpected(await lead());
  await database.db.transaction(async (tx) => {
    const current = (await lockLeadMagnet(tx, id))!;
    if (JSON.stringify(firstAppExpected(current)) !== JSON.stringify(target)) throw new Error("expected изменились");
    if (current.draftVersionId !== current.publishedSnapshotId) throw new Error("Есть неопубликованные правки");
    await saveEditBesideConstructor(tx, current, simplifiedFirstAppSettings(current.draft), "agent");
  });
}
async function startAt(to: "idea" | "first_version" | "build" | "publish" | "polish" | "course") {
  const user = randomUUID();
  const { ensureMainEntryLink } = await import("../lead-magnets/links");
  const code = (await ensureMainEntryLink(database.db, id)).code;
  await kit.send(user, `/start ${code}`, { startCode: code }); await kit.runDue(); await kit.dialog.flow.settled();
  const route = ["idea", "first_version", "build", "publish", "polish", "course"];
  const exits = ["idea_done", "first_version_done", "build_done", "publish_done", "polish_done"];
  for (let i = 0; i < route.indexOf(to); i++) {
    const exit = exits[i]!;
    kit.judge = () => [exit];
    // Claim применяет переход внутри хода. afterTurn judge только ставит pending до следующего хода.
    kit.reply = (call) => call.lastToolResult === undefined
      ? { toolCalls: [{ toolName: "flow_exit", input: { exit: 1, why: `Подтверждён ${exit}` } }] }
      : { text: "Продолжаем." };
    await kit.send(user, i === 3 ? "Вот моё приложение https://mine.apps.example.com" : `Подтверждаю ${exit}`); await kit.runDue(); await kit.dialog.flow.settled();
    kit.reply = () => ({ text: "Продолжаем." });
  }
  kit.judge = () => [];
  const passage = (await kit.passagesOf(user))[0]!;
  const run = await kit.dialog.flow.readRun((await kit.personOf(user))!.id, passage.chatId);
  expect(passage.status).toBe("active");
  expect(run?.state).toBe(to);
  return user;
}

describe("guarded first-app rollout", () => {
  it.each(["draft", "publish", "migrate"] as const)("%s закрыт с актуальными expected/by: ни одной версии или правки", async (mode) => {
    expect(FIRST_APP_DURABLE_GATE_READY).toBe(false);
    const before = await lead();
    const oldSnapshot = await getVersion(database.db, before.publishedSnapshotId!);
    const versions = () => database.pool.query("select count(*)::int as count from app.lead_magnet_versions where lead_magnet_id = $1", [id]);
    const count = (await versions()).rows[0].count;
    const transaction = vi.spyOn(database.db, "transaction");
    await expect(run(mode, firstAppExpected(before))).rejects.toThrow(/draft\/publish\/migrate.*durable/);
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
    expect(await lead()).toEqual(before); // draft, published, settings и updatedAt.
    expect(await getVersion(database.db, before.publishedSnapshotId!)).toEqual(oldSnapshot);
    expect((await versions()).rows[0].count).toBe(count);
  });
  it("plan только читает и считает живые чаты с явным mapping, не создаёт версий", async () => {
    await startAt("first_version"); await startAt("polish");
    const before = await lead();
    const report = await run("plan");
    expect(report.liveChats).toBe(2);
    expect(report.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "first_version", to: "idea", chats: 1 }),
      expect.objectContaining({ from: "polish", to: "result", chats: 1 }),
    ]));
    expect(await lead()).toEqual(before);
  });
  it("не затирает новую правку: CAS проверяется под блокировкой строки", async () => {
    const before = await lead();
    await saveDraft(database.db, id, { ...before.draft, firstMessage: "Чужая новая правка" }, "manual");
    await expect(saveCandidateFixture(firstAppExpected(before))).rejects.toThrow(/изменились/);
    expect((await lead()).draft.firstMessage).toBe("Чужая новая правка");
    await expect(saveCandidateFixture()).rejects.toThrow(/неопубликованные правки/);
  });
  it("меняет только рабочие ноды черновика, прежний опубликованный snapshot/settings неизменны", async () => {
    const before = await lead();
    const oldVersion = await getVersion(database.db, before.publishedSnapshotId!);
    await saveCandidateFixture();
    const after = await lead();
    expect(after.draftVersionId).not.toBe(before.draftVersionId);
    expect(after.publishedSnapshotId).toBe(before.publishedSnapshotId);
    expect(await getVersion(database.db, before.publishedSnapshotId!)).toEqual(oldVersion);
    const { states: _, layout: __, ...unchanged } = after.draft.flow;
    const { states: ___, layout: ____, ...oldUnchanged } = before.draft.flow;
    expect(unchanged).toEqual(oldUnchanged);
    expect(after.draft.productLinks).toEqual(before.draft.productLinks);
    expect(after.draft.textLink).toEqual(before.draft.textLink);
    await expect(saveCandidateFixture()).rejects.toThrow(/неопубликованные правки/);
  });
  it("изолированные CAS fixtures: конкурирующие сохранения дают одну версию, plan отвергает stale expected", async () => {
    const expected = firstAppExpected(await lead());
    const settled = await Promise.allSettled([saveCandidateFixture(expected), saveCandidateFixture(expected)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    await expect(run("plan", expected)).rejects.toThrow(/изменились/);
    await expect(run("publish")).rejects.toThrow(/durable/);
    await expect(run("migrate")).rejects.toThrow(/durable/);
  });
  it("штатный SDK-перенос переводит удалённые ноды с сохранением старта программы и истории", async () => {
    const early = await startAt("first_version");
    const published = await startAt("polish");
    const earlyChat = (await kit.passagesOf(early))[0]!;
    const publishedChat = (await kit.passagesOf(published))[0]!;
    const earlyOwner = (await kit.personOf(early))!.id;
    const publishedOwner = (await kit.personOf(published))!.id;
    const before = await kit.dialog.flow.readRun(publishedOwner, publishedChat.chatId);
    await saveCandidateFixture();
    // Только изолированный тест существующей механики mapping, не доказательство семантики AND/готовности prod.
    await publishLeadMagnet(database.db, id);
    const migration = await migrateLiveChats(database.db, { leadMagnetId: id, map: FIRST_APP_STATE_MAP, by: { email: "expert@example.com" }, at: kit.clock.now() });
    expect(migration.chats).toBe(2);
    expect(await applyChatMigration({ db: database.db, flow: kit.dialog.flow }, { leadMagnetId: id, toVersionId: migration.toVersionId })).toEqual({ moved: 2 });
    expect((await kit.dialog.flow.readRun(publishedOwner, publishedChat.chatId))?.dayCounts).toEqual(before?.dayCounts);
    // Как в штатном worker: placement версии применяется к app-state на следующем ходе.
    for (const user of [early, published]) {
      await kit.send(user, "Продолжим работу над приложением");
      await kit.runDue(); await kit.dialog.flow.settled();
    }
    const a = await kit.dialog.flow.readRun(earlyOwner, earlyChat.chatId);
    const b = await kit.dialog.flow.readRun(publishedOwner, publishedChat.chatId);
    expect(a?.state).toBe("idea"); expect(b?.state).toBe("result");
    expect(b?.startedAt).toBe(before?.startedAt);
    // Новое человеческое сообщение расходует одно касание; перенос не обнуляет прежние четыре.
    expect(b?.dayCounts).toEqual({ ...before?.dayCounts, "2026-10-01": (before?.dayCounts?.["2026-10-01"] ?? 0) + 1 });
    expect(b?.path.some((p) => p.exitId === "publish_done")).toBe(true);
    expect((await kit.passagesOf(published))[0]!.programStartDate).toBe(publishedChat.programStartDate);
    const repeated = await migrateLiveChats(database.db, { leadMagnetId: id, map: FIRST_APP_STATE_MAP, by: { email: "expert@example.com" }, at: kit.clock.now() });
    expect(repeated.chats).toBe(0);
  });
});
