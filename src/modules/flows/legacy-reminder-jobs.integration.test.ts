// Старые задачи `reminder` в очереди pg-boss после переноса на «Сценарии»: обработчика у них нет, перенос их отменяет.
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { LEGACY_REMINDER_JOB, cancelLegacyReminderJobs, formatLegacyReminderReport } from "./legacy-reminder-jobs";

let database: TestDatabase;
let boss: PgBoss;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  boss = new PgBoss({ connectionString: database.url, schema: "pgboss", supervise: false, schedule: false });
  await boss.start();
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await database.drop();
});

const statesOf = async (name: string) => (await boss.findJobs(name)).map((job) => job.state).sort();

describe("старые задачи reminder", () => {
  it("очереди reminder нет — нечего отменять, очередь не создаётся", async () => {
    expect(await cancelLegacyReminderJobs(boss, { apply: true })).toEqual({ waiting: 0, cancelled: 0 });
    expect(await boss.getQueue(LEGACY_REMINDER_JOB)).toBeNull();
  });

  it("«посмотреть» только считает; --apply отменяет ждущие, история и чужие очереди не трогаются; повтор ничего не меняет", async () => {
    await boss.createQueue(LEGACY_REMINDER_JOB);
    await boss.createQueue("inbound-turn");
    await boss.send(LEGACY_REMINDER_JOB, { passageId: "a" });
    await boss.send(LEGACY_REMINDER_JOB, { passageId: "b" }, { startAfter: 3600 });
    await boss.send(LEGACY_REMINDER_JOB, { passageId: "c" });
    const [done] = await boss.fetch(LEGACY_REMINDER_JOB);
    await boss.complete(LEGACY_REMINDER_JOB, done!.id);
    await boss.send("inbound-turn", { passageId: "x" });

    const preview = await cancelLegacyReminderJobs(boss, { apply: false });
    expect(preview).toEqual({ waiting: 2, cancelled: 0 });
    expect(await statesOf(LEGACY_REMINDER_JOB)).toEqual(["completed", "created", "created"]);
    expect(formatLegacyReminderReport(preview, { apply: false })).toContain("--apply");

    const applied = await cancelLegacyReminderJobs(boss, { apply: true });
    expect(applied).toEqual({ waiting: 2, cancelled: 2 });
    expect(await statesOf(LEGACY_REMINDER_JOB)).toEqual(["cancelled", "cancelled", "completed"]);
    expect(await statesOf("inbound-turn")).toEqual(["created"]);
    expect(formatLegacyReminderReport(applied, { apply: true })).toContain("отменено 2");

    expect(await cancelLegacyReminderJobs(boss, { apply: true })).toEqual({ waiting: 0, cancelled: 0 });
  });
});
