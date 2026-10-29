// Перевод идущих разговоров на новую версию лидмагнита: подсчёт по нодам, перевод с картой нод, закрытые и тестовые
// разговоры не трогаются, повторный перевод ничего не ломает.
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, type LiveDialogKit, type PublishedLeadMagnet } from "../../../tests/integration/live-dialog-kit";
import { agentLogEntries, agentLogTurns } from "../agent-log/schema";
import { getLeadMagnet, saveDraft, type LeadMagnetSettings, type Stage } from "../lead-magnets";
import { publishLeadMagnet } from "../lead-magnets/publish";
import { updateSettings } from "../platform/settings";
import type { JobEnqueuer, JobName, JobPayloads } from "../platform/queue";
import { applyChatMigration, migrateLiveChats, planChatMigration, requeuePendingChatMigrations } from "./chat-migration";

const STAGES: Stage[] = [
  { id: "build", name: "Сборка", instruction: "Помоги собрать приложение.", transitionCondition: "Прислал ссылку", startDay: null, isSale: false },
  { id: "polish", name: "Доработка", instruction: "Помоги доработать.", transitionCondition: "Доработал", startDay: null, isSale: false },
  { id: "sale", name: "Продажа", instruction: "Предложи курс.", transitionCondition: "", startDay: null, isSale: true },
];
const V2_MARK = "Правила второй версии: говори коротко.";
const EXPERT = { name: "Дмитрий", email: "expert@example.com" };

let database: TestDatabase;
let kit: LiveDialogKit;
let lead: PublishedLeadMagnet;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { dailyLimitUsd: "1000", monthlyBudgetUsd: null });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("update app.passages set status = 'not_completed' where status = 'active'");
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
  lead = await kit.publish({ stages: STAGES });
});

async function say(person: string, text: string) {
  await kit.send(person, text);
  await kit.runDue();
  kit.clock.advance(5_000);
  await kit.runDue();
  await kit.dialog.flow.settled();
}

/** Человек начинает разговор; `toPolish` — судья признаёт «Прислал ссылку», и он уходит в «Доработку». */
async function startPerson(options: { toPolish?: boolean; code?: string } = {}) {
  const person = `user-${randomUUID().slice(0, 8)}`;
  const code = options.code ?? lead.code;
  await kit.send(person, `/start ${code}`, { startCode: code });
  await kit.runDue();
  if (options.toPolish) {
    const reply = kit.reply;
    kit.reply = (call) =>
      call.lastToolResult === undefined && call.lastUserText.includes("Вот ссылка")
        ? { toolCalls: [{ toolName: "flow_exit", input: { exit: 1, why: "Прислал ссылку" } }] }
        : reply(call);
    kit.judge = () => ["build_done"];
    await say(person, "Вот ссылка на приложение");
    kit.reply = reply;
    kit.judge = () => [];
  }
  return person;
}

/** Вторая версия: без «Доработки» («Сборка» ведёт сразу в «Продажу»), с новыми общими правилами. */
async function publishVersion2(): Promise<string> {
  const current = (await getLeadMagnet(kit.db, lead.leadMagnetId))!;
  const flow = current.draft.flow;
  const states = flow.states
    .filter((state) => state.id !== "polish")
    .map((state) =>
      state.id === "build" ? { ...state, exits: state.exits.map((exit) => (exit.to === "polish" ? { ...exit, to: "sale" } : exit)) } : state,
    ) as AgentFlow["states"];
  const settings: LeadMagnetSettings = { ...current.draft, flow: { ...flow, common: `${flow.common}\n${V2_MARK}`, states } };
  await saveDraft(kit.db, lead.leadMagnetId, settings, "manual");
  return (await publishLeadMagnet(kit.db, lead.leadMagnetId)).snapshotId;
}

const flowChat = async (chatId: string) =>
  (await database.pool.query("select version_id, state_id, ended_at from agent_chat.flow_chats where chat_id = $1", [chatId])).rows[0];
const passageOf = async (person: string) => (await kit.passagesOf(person))[0]!;

/** Тестовый чат «Проверки» того же сценария: закрепление SDK без прохождения (как у чата редактора). */
async function pinPreviewChatLike(chatId: string): Promise<string> {
  const previewChatId = `preview-${randomUUID()}`;
  await database.pool.query(
    `insert into agent_chat.flow_chats
       select (jsonb_populate_record(null::agent_chat.flow_chats, to_jsonb(fc) || jsonb_build_object('chat_id', $2::text, 'owner_id', $2::text))).*
       from agent_chat.flow_chats fc where chat_id = $1`,
    [chatId, previewChatId],
  );
  return previewChatId;
}

const migrate = (map: Record<string, string> = {}) =>
  migrateLiveChats(kit.db, { leadMagnetId: lead.leadMagnetId, map, by: EXPERT, at: kit.clock.now() });
const apply = (toVersionId: string) => applyChatMigration({ db: kit.db, flow: kit.dialog.flow }, { leadMagnetId: lead.leadMagnetId, toVersionId });

describe("перевод идущих разговоров на новую версию", () => {
  it("считает только идущие боевые разговоры прежних версий — по нодам, с подсказкой, куда отправить людей из удалённых", async () => {
    const a = await startPerson();
    await startPerson();
    await startPerson({ toPolish: true });
    const closed = await startPerson();
    await say(closed, "Я готов");
    expect((await passageOf(closed)).status).toBe("completed");
    await pinPreviewChatLike((await passageOf(a)).chatId);

    expect(await planChatMigration(kit.db, lead.leadMagnetId)).toMatchObject({ total: 0, groups: [] });

    const v2 = await publishVersion2();
    // Начавший по новой версии в подсчёт не входит
    await startPerson();

    const plan = await planChatMigration(kit.db, lead.leadMagnetId);
    expect(plan).toMatchObject({
      toVersionId: v2,
      total: 3,
      groups: [
        { versionId: lead.snapshotId, stateId: "build", stateTitle: "Сборка", chats: 2, inNewVersion: true, suggestedTo: "build" },
        { versionId: lead.snapshotId, stateId: "polish", stateTitle: "Доработка", chats: 1, inNewVersion: false, suggestedTo: "sale" },
      ],
    });
    // Куда можно отправить: ноды новой версии, кроме конечных
    expect(plan!.targets).toEqual([
      { id: "build", title: "Сборка" },
      { id: "sale", title: "Продажа" },
    ]);
  });

  it("переводит с картой нод: наши прохождения на новом снимке, запись в «Лог», SDK — разговор отвечает по новой версии", async () => {
    const a = await startPerson();
    const c = await startPerson({ toPolish: true });
    const v2 = await publishVersion2();

    const result = await migrate({ polish: "build" });
    expect(result).toEqual({ chats: 2, toVersionId: v2, pending: 0 });

    // Наши данные — сразу, в одной транзакции с записью в «Лог»
    expect(await passageOf(a)).toMatchObject({ snapshotId: v2 });
    expect(await passageOf(c)).toMatchObject({ snapshotId: v2, currentStageId: "build" });
    const turns = await kit.db.select().from(agentLogTurns).where(eq(agentLogTurns.leadMagnetId, lead.leadMagnetId));
    const migrationTurns = turns.filter((turn) => turn.chatId.startsWith("migration:"));
    expect(migrationTurns).toHaveLength(1);
    const [entry] = await kit.db.select().from(agentLogEntries).where(eq(agentLogEntries.turnId, migrationTurns[0]!.id));
    expect(entry!.data).toMatchObject({
      kind: "migration",
      by: "Дмитрий (expert@example.com)",
      chats: 2,
      moves: [
        { fromVersionId: lead.snapshotId, from: "Сборка", to: "Сборка", chats: 1 },
        { fromVersionId: lead.snapshotId, from: "Доработка", to: "Сборка", chats: 1 },
      ],
    });

    // Пока работник не перевёл чаты SDK — «ещё переводятся», к переводу заново их не предлагают
    expect(await planChatMigration(kit.db, lead.leadMagnetId)).toMatchObject({ total: 0, groups: [], pending: 2 });

    // SDK — после коммита (задача работника)
    expect(await apply(v2)).toEqual({ moved: 2 });
    expect(await flowChat((await passageOf(a)).chatId)).toMatchObject({ version_id: v2, state_id: "build" });
    expect(await flowChat((await passageOf(c)).chatId)).toMatchObject({ version_id: v2, state_id: "build" });
    expect(await planChatMigration(kit.db, lead.leadMagnetId)).toMatchObject({ total: 0, pending: 0 });

    await say(c, "Продолжим?");
    const lastCall = kit.consultantCalls().at(-1)!;
    expect(lastCall.system).toContain(V2_MARK);
    const run = await kit.dialog.flow.readRun((await kit.personOf(c))!.id, (await passageOf(c)).chatId);
    expect(run).toMatchObject({ state: "build" });
  });

  it("закрытые разговоры и тестовые чаты «Проверки» не трогает", async () => {
    const live = await startPerson();
    const closed = await startPerson();
    await say(closed, "Я готов");
    const previewChatId = await pinPreviewChatLike((await passageOf(live)).chatId);
    const closedPassage = await passageOf(closed);
    const v2 = await publishVersion2();

    expect(await migrate()).toMatchObject({ chats: 1, toVersionId: v2 });
    expect(await apply(v2)).toEqual({ moved: 1 });

    expect(await flowChat((await passageOf(live)).chatId)).toMatchObject({ version_id: v2 });
    expect(await flowChat(closedPassage.chatId)).toMatchObject({ version_id: lead.snapshotId });
    expect(await passageOf(closed)).toMatchObject({ snapshotId: lead.snapshotId, status: "completed" });
    expect(await flowChat(previewChatId)).toMatchObject({ version_id: lead.snapshotId });
  });

  it("повторный перевод ничего не ломает: ноль разговоров, без второй записи в «Лог», разговор идёт дальше", async () => {
    const a = await startPerson({ toPolish: true });
    const v2 = await publishVersion2();
    await migrate({ polish: "sale" });
    // Нажал ещё раз, пока работник не успел: второй записи нет, задача нужна только для уже записанных
    expect(await migrate({ polish: "build" })).toEqual({ chats: 0, toVersionId: v2, pending: 1 });
    await apply(v2);

    expect(await migrate({ polish: "sale" })).toEqual({ chats: 0, toVersionId: v2, pending: 0 });
    expect(await apply(v2)).toEqual({ moved: 0 });
    const turns = await kit.db.select().from(agentLogTurns).where(eq(agentLogTurns.leadMagnetId, lead.leadMagnetId));
    expect(turns.filter((turn) => turn.chatId.startsWith("migration:"))).toHaveLength(1);

    expect(await flowChat((await passageOf(a)).chatId)).toMatchObject({ version_id: v2, state_id: "sale" });
    await say(a, "Что дальше?");
    expect(kit.consultantCalls().at(-1)!.system).toContain(V2_MARK);
    expect((await passageOf(a)).status).toBe("active");
  });

  it("задача перевода потерялась после записи: восстановление ставит её только для переведённых нашей записью", async () => {
    const a = await startPerson();
    const c = await startPerson({ toPolish: true });
    const previewChatId = await pinPreviewChatLike((await passageOf(a)).chatId);
    const v2 = await publishVersion2();
    const onV2 = await startPerson();
    // Наши данные переведены, а задача `chats-migrate` не встала (упал процесс или очередь)
    expect(await migrate({ polish: "build" })).toMatchObject({ chats: 2, toVersionId: v2 });
    // Следующая версия опубликована, а её не переводили: начатые на v2 на ней и остаются
    const current = (await getLeadMagnet(kit.db, lead.leadMagnetId))!;
    await saveDraft(kit.db, lead.leadMagnetId, { ...current.draft, cardDescription: "Третья версия" }, "manual");
    const v3 = (await publishLeadMagnet(kit.db, lead.leadMagnetId)).snapshotId;
    const onV3 = await startPerson();

    const jobs: Array<{ name: JobName; payload: unknown }> = [];
    const queue: JobEnqueuer = {
      async enqueue<Name extends JobName>(name: Name, payload: JobPayloads[Name]) {
        jobs.push({ name, payload });
      },
    };
    const ofThisLead = () => jobs.filter((job) => (job.payload as { leadMagnetId: string }).leadMagnetId === lead.leadMagnetId);
    await requeuePendingChatMigrations({ db: kit.db, queue });
    expect(ofThisLead()).toEqual([{ name: "chats-migrate", payload: { leadMagnetId: lead.leadMagnetId, toVersionId: v2 } }]);

    // Работник выполнил восстановленную задачу: чаты SDK на той версии, куда их перевели наши данные
    expect(await apply(v2)).toEqual({ moved: 2 });
    expect(await flowChat((await passageOf(a)).chatId)).toMatchObject({ version_id: v2 });
    expect(await flowChat((await passageOf(c)).chatId)).toMatchObject({ version_id: v2, state_id: "build" });
    expect(await flowChat((await passageOf(onV2)).chatId)).toMatchObject({ version_id: v2 });
    expect(await flowChat((await passageOf(onV3)).chatId)).toMatchObject({ version_id: v3 });
    expect(await flowChat(previewChatId)).toMatchObject({ version_id: lead.snapshotId });

    jobs.length = 0;
    await requeuePendingChatMigrations({ db: kit.db, queue });
    expect(ofThisLead()).toEqual([]);
  });

  it("закончившиеся после перевода разговоры восстановление не трогает", async () => {
    const finished = await startPerson();
    const closedInSdk = await startPerson();
    await publishVersion2();
    expect(await migrate()).toMatchObject({ chats: 2 });
    await database.pool.query("update app.passages set status = 'not_completed' where id = $1", [(await passageOf(finished)).id]);
    await database.pool.query("update agent_chat.flow_chats set ended_at = now() where chat_id = $1", [(await passageOf(closedInSdk)).chatId]);
    const jobs: unknown[] = [];
    await requeuePendingChatMigrations({ db: kit.db, queue: { enqueue: async (_name, payload) => void jobs.push(payload) } });
    expect(jobs).toEqual([]);
  });

  it("идущие разговоры прежней версии без перевода восстановление не трогает", async () => {
    const a = await startPerson();
    await publishVersion2();
    const jobs: unknown[] = [];
    await requeuePendingChatMigrations({ db: kit.db, queue: { enqueue: async (_name, payload) => void jobs.push(payload) } });
    expect(jobs).toEqual([]);
    expect(await flowChat((await passageOf(a)).chatId)).toMatchObject({ version_id: lead.snapshotId });
    expect(await passageOf(a)).toMatchObject({ snapshotId: lead.snapshotId });
  });

  it("неопубликованный лидмагнит и нода не из новой версии в карте — понятная ошибка", async () => {
    await startPerson({ toPolish: true });
    await publishVersion2();
    await expect(migrate({ polish: "polish" })).rejects.toThrow("Нода «polish» не из новой версии");
    await database.pool.query("update app.lead_magnets set published_snapshot_id = null where id = $1", [lead.leadMagnetId]);
    await expect(migrate()).rejects.toThrow("Лидмагнит не опубликован");
  });
});
