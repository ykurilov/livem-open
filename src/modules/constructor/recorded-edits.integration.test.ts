// Правки конструктора из настоящего прогона eval: после них в лидмагните те поля, что он «завёл»
import { createInMemoryChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet } from "../lead-magnets";
import { getFields } from "../people";
import designer from "./recorded/designer-edits.json";
import { editLeadMagnet, editLeadMagnetInput } from "./tools";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe("записанные правки конструктора", () => {
  it("дизайнер интерьеров: поля с ходов 3–4 переживают put_flow в той же правке — в карточке все 8", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Дизайн интерьера" });
    const deps = { db: database.db, chatStorage: createInMemoryChatStorage() };

    // Прощание «Передам Веронике» записано до 21.10, теперь сохранение его отклоняет; тут проверяются поля, поэтому прощание — без «передам»
    const edits = JSON.parse(JSON.stringify(designer.edits).replaceAll("Передам Веронике — она напишет", "Вероника напишет"));
    for (const edit of edits) expect(await editLeadMagnet(deps, lead.id, editLeadMagnetInput.parse(edit))).toMatchObject({ ok: true });

    const { flow } = (await getLeadMagnet(database.db, lead.id))!.draft;
    const names = (await getFields(database.db, flow.clientCard.map((field) => field.id))).map((field) => field.name);
    expect(names.sort()).toEqual(
      [
        "Телефон",
        "Где находится квартира",
        "Тип квартиры",
        "Что хочет человек",
        "Когда планирует начать ремонт",
        "Кто участвует в решении",
        "Бюджет на ремонт",
        "Откуда узнал(а) о Веронике",
      ].sort(),
    );
  });
});
