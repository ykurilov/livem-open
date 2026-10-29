import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, defaultConsultantReply, isJudgeCall, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { createField, listFields, people } from "../people";
import { updateSettings } from "../platform/settings";
import { NAME_REST_LINE, profileNameForTail } from "./profile-name";

let database: TestDatabase;
let kit: LiveDialogKit;

beforeAll(async () => {
  database = await createTestDatabase();
  await updateSettings(database.db, { monthlyBudgetUsd: null, dailyLimitUsd: "1000" });
  kit = await createLiveDialogKit(database, { pricePerMillion: 0 });
});

afterAll(async () => {
  await database.drop();
});

async function person() {
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish({ name: "Имя в хвосте" });
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  return (await kit.personOf(user))!.id;
}

it("поле «Имя» не заполнено — имя из профиля мессенджера", async () => {
  const id = await person();
  expect(await profileNameForTail(database.db, id)).toMatch(/^Человек user-/);
});

it("человек сказал, как к нему обращаться (поле «Имя» заполнено), — имени из профиля в хвосте больше нет", async () => {
  const id = await person();
  const nameField = await createField(database.db, { name: "Имя", type: "text", description: "Как обращаться" }).catch(async () => null);
  const fieldId = nameField?.id ?? (await database.pool.query("select id from app.fields where name = 'Имя' and deleted_at is null limit 1")).rows[0].id;
  await database.db.update(people).set({ fieldValues: { [fieldId]: "Света" } }).where(eq(people.id, id));
  expect(await profileNameForTail(database.db, id)).toBeNull();
});

it("владелец чата не человек (тестовый разговор эксперта) — имени нет", async () => {
  expect(await profileNameForTail(database.db, "preview-owner")).toBeNull();
  expect(await profileNameForTail(database.db, randomUUID())).toBeNull();
});

const PROFILE_LINE = "Имя в профиле мессенджера:";

/** Поле «Имя» словаря: одно на базу, тесты файла делят его. */
async function nameFieldId(): Promise<string> {
  const found = (await listFields(database.db)).find((field) => field.name === "Имя");
  return found?.id ?? (await createField(database.db, { name: "Имя", type: "text", description: "Как обращаться" })).id;
}

it("в настоящем ходе: человек назвался, консультант записал «Имя» — со следующего хода строки «Имя в профиле» в запросе нет", async () => {
  const fieldId = await nameFieldId();
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish({ name: "Имя записано", fieldIds: [fieldId] });
  kit.reply = (call) => {
    if (call.lastToolResult === undefined && call.lastUserText.includes("Меня зовут Ольга"))
      return { toolCalls: [{ toolName: "flow_note", input: { field: fieldId, value: "Ольга" } }] };
    return defaultConsultantReply(call);
  };
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  const asked = (text: string) => kit.consultantCalls().filter((call) => !isJudgeCall(call) && call.lastUserText.includes(text));
  const sent = (call: (typeof kit.calls)[number]) => JSON.stringify(call.options.prompt);

  await kit.send(user, "Привет");
  await kit.drain();
  expect(sent(asked("Привет").at(-1)!)).toContain(`${PROFILE_LINE} Человек ${user}`);

  await kit.send(user, "Меня зовут Ольга");
  await kit.drain();
  const person = await kit.personOf(user);
  expect(person!.fieldValues[fieldId]).toBe("Ольга");

  await kit.send(user, "Что дальше?");
  await kit.drain();
  const next = asked("Что дальше?");
  expect(next.length).toBeGreaterThan(0);
  // Сама строка хвоста — с двоеточием и именем; правило в инструкции называет её без них
  for (const call of next) expect(sent(call)).not.toContain(PROFILE_LINE);
});

it("консультант назвал человека по имени — следующие три ответа хвост просит не называть, потом снова можно", async () => {
  const fieldId = await nameFieldId();
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish({ name: "Имя изредка", fieldIds: [fieldId] });
  let reply = "Понял.";
  kit.reply = (call) => {
    if (call.lastToolResult === undefined && call.lastUserText.includes("Меня зовут Ольга"))
      return { toolCalls: [{ toolName: "flow_note", input: { field: fieldId, value: "Ольга" } }] };
    return call.lastToolResult === undefined || call.lastUserText.includes("Меня зовут") ? { text: reply } : {};
  };
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  const lastAsked = (text: string) => JSON.stringify(kit.consultantCalls().findLast((call) => call.lastUserText.includes(text))!.options.prompt.at(-1));

  reply = "Приятно познакомиться, Ольга!";
  await kit.send(user, "Меня зовут Ольга");
  await kit.drain();
  reply = "Понял.";
  for (const [index, text] of ["Первое", "Второе", "Третье"].entries()) {
    await kit.send(user, text);
    await kit.drain();
    expect(lastAsked(text), `ответ ${index + 1} после имени`).toContain(NAME_REST_LINE);
  }
  await kit.send(user, "Четвёртое");
  await kit.drain();
  expect(lastAsked("Четвёртое")).not.toContain(NAME_REST_LINE);
});
