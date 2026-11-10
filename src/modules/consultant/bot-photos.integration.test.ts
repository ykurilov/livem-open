import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, isJudgeCall, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { bots } from "../channels/schema";
import { updateSettings } from "../platform/settings";
import { botSendsNoPhotos, NO_PHOTOS_LINE } from "./bot-photos";

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

const setCanSendPhotos = (value: boolean) => database.db.update(bots).set({ canSendPhotos: value }).where(eq(bots.id, kit.bot.id));

async function askedWith(text: string) {
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish({ name: "Картинки бота" });
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code });
  await kit.drain();
  await kit.send(user, text);
  await kit.drain();
  const calls = kit.consultantCalls().filter((call) => !isJudgeCall(call) && call.lastUserText.includes(text));
  expect(calls.length).toBeGreaterThan(0);
  return { person: (await kit.personOf(user))!.id, prompts: calls.map((call) => JSON.stringify(call.options.prompt)) };
}

it("бот без права «Фотографии» — в хвосте хода запрет на картинки", async () => {
  await setCanSendPhotos(false);
  try {
    const { person, prompts } = await askedWith("Покажи пример");
    expect(await botSendsNoPhotos(database.db, person)).toBe(true);
    for (const prompt of prompts) expect(prompt).toContain(NO_PHOTOS_LINE);
  } finally {
    await setCanSendPhotos(true);
  }
});

it("бот с правом — строки нет, запрос прежний", async () => {
  const { person, prompts } = await askedWith("Расскажи подробнее");
  expect(await botSendsNoPhotos(database.db, person)).toBe(false);
  for (const prompt of prompts) expect(prompt).not.toContain(NO_PHOTOS_LINE);
});

it("тестовый разговор эксперта — строки нет", async () => {
  expect(await botSendsNoPhotos(database.db, "preview-owner")).toBe(false);
  expect(await botSendsNoPhotos(database.db, randomUUID())).toBe(false);
});
