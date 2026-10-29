import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { DEFAULT_CONSULTANT_REPLY, createLiveDialogKit, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import { updateSettings } from "../platform/settings";
import { loadPersonCard } from "./card";
import { createField, deleteField } from "./fields";
import { rememberAboutPerson } from "./people";

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

async function say(user: string, text: string, startCode?: string) {
  await kit.send(user, text, startCode ? { startCode } : {});
  await kit.drain();
}

it("карточка: поля, факты, прохождения с итогом и этапом остановки, переписка", async () => {
  const user = `user-${randomUUID().slice(0, 8)}`;
  const first = await kit.publish({ name: "Курс за неделю" });
  await say(user, `/start ${first.code}`, first.code);
  await say(user, "Я дизайнер");
  await say(user, "Я готов к созвону");

  const second = await kit.publish({
    name: "Вебинар",
    stages: [
      { id: "intro", name: "Знакомство", instruction: "Узнай нишу", transitionCondition: "Назвал нишу", startDay: null, isSale: false },
      { id: "offer", name: "Предложение", instruction: "Предложи шаг", transitionCondition: "Выбрал шаг", startDay: null, isSale: false },
    ],
  });
  await say(user, `/start ${second.code}`, second.code);

  const person = await kit.personOf(user);
  const hasCourse = await createField(kit.db, { name: "Есть свой курс", type: "boolean", description: "" });
  const city = await createField(kit.db, { name: "Город", type: "text", description: "" });
  await rememberAboutPerson(kit.db, person!.id, {
    facts: ["Ведёт блог"],
    fieldValues: { [hasCourse.id]: true, [city.id]: "Казань" },
    source: "test",
    at: kit.clock.now(),
  });
  await deleteField(kit.db, city.id, kit.clock.now());

  const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, person!.id);

  expect(card).toMatchObject({ id: person!.id, displayName: `Человек ${user}`, channel: "telegram", botTitle: expect.stringMatching(/^Бот /) });
  expect(card!.fields).toEqual([{ id: hasCourse.id, name: "Есть свой курс", value: "да" }]);
  expect(card!.facts.map((fact) => fact.text)).toEqual(["Ведёт блог", "Город: Казань"]);

  // Новые прохождения сверху
  const [webinar, course] = card!.passages;
  expect(webinar).toMatchObject({ leadMagnetName: "Вебинар", status: "active", stageName: "Знакомство", summary: null });
  expect(course).toMatchObject({
    leadMagnetName: "Курс за неделю",
    stageName: null, // разговор из одной ноды — без этапа
    linkLabel: null,
    status: "completed",
    summary: { goal: "Цель", stuckAt: "Застрял", chosenStep: "Созвон" },
  });
  const lines = course!.messages.map((message) => [message.role, message.text]);
  expect(lines).toContainEqual(["user", "Я дизайнер"]);
  expect(lines).toContainEqual(["assistant", DEFAULT_CONSULTANT_REPLY]);
});

it("этап в карточке — нода сценария: название с доски, а не из устаревших этапов", async () => {
  const user = `user-${randomUUID().slice(0, 8)}`;
  const lead = await kit.publish(
    {
      name: "Марафон",
      stages: [
        { id: "intro", name: "Знакомство", instruction: "Узнай нишу", transitionCondition: "Назвал нишу", startDay: null, isSale: false },
        { id: "offer", name: "Предложение", instruction: "Предложи шаг", transitionCondition: "Выбрал шаг", startDay: null, isSale: false },
      ],
    },
    // Стартовую ноду переименовали на доске; этапы настроек об этом не знают
    (flow) => ({ ...flow, states: flow.states.map((state) => (state.id === "intro" ? { ...state, title: "Сразу к делу" } : state)) }),
  );
  await say(user, `/start ${lead.code}`, lead.code);
  const person = await kit.personOf(user);

  const card = await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, person!.id);

  expect(card!.passages[0]).toMatchObject({ leadMagnetName: "Марафон", stageName: "Сразу к делу" });
});

it("неизвестный человек — null", async () => {
  expect(await loadPersonCard({ db: kit.db, chatStorage: kit.chatStorage }, randomUUID())).toBeNull();
});
