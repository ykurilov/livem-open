import { createInMemoryChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, listVersions, saveDraft, type LeadMagnet } from "../lead-magnets";
import { createKnowledgeBase } from "../knowledge";
import { editLeadMagnet, editLeadMagnetInput, viewLeadMagnet, VIEW_SECTIONS, type ConstructorToolDependencies } from "./tools";
import { describeManualEdits, removeExpertSalesCard, saveExpertSalesCard } from "./manual-edits";

let database: TestDatabase;
let deps: ConstructorToolDependencies;
let lead: LeadMagnet;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  deps = { db: database.db, chatStorage: createInMemoryChatStorage() };
  const created = await createLeadMagnet(database.db, { name: `Заготовки ${Math.random()}` });
  lead = (await getLeadMagnet(database.db, created.id))!;
});

const draft = async () => (await getLeadMagnet(database.db, lead.id))!.draft;
const workingState = () => lead.draft.flow.states.find((state) => state.exits.length > 0)!.id;

describe("конструктор: заготовки эксперта", () => {
  it("put_sales_card добавляет заготовку этапа одной версией «constructor»; id даёт приложение", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_sales_card", card: { stateId: workingState(), title: "Цена", when: "Спросили цену", text: "Курс стоит 9 900 ₽", verbatim: true } }],
    });
    expect(result).toMatchObject({ ok: true });
    const [card] = (await draft()).salesCards;
    expect(card).toMatchObject({ stateId: workingState(), title: "Цена", when: "Спросили цену", text: "Курс стоит 9 900 ₽", verbatim: true });
    expect(card!.id).toMatch(/^\S{4,}$/);
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("constructor");
  });

  it("общая шпаргалка — stateId null; put_sales_card с тем же id правит заготовку", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: null, title: "Дорого", when: "Человеку дорого", text: "Есть рассрочка", verbatim: false } }] });
    const [card] = (await draft()).salesCards;
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { ...card!, text: "Есть рассрочка на 3 месяца" } }] });
    expect((await draft()).salesCards).toEqual([{ ...card!, text: "Есть рассрочка на 3 месяца" }]);
  });

  it("remove_sales_card убирает заготовку; неизвестный id — ошибка, ничего не изменено", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: null, title: "Дорого", when: "Человеку дорого", text: "Есть рассрочка", verbatim: false } }] });
    const [card] = (await draft()).salesCards;
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_sales_card", id: "nope" }] })).toMatchObject({ ok: false, error: expect.stringMatching(/заготовк/i) });
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_sales_card", id: card!.id }] })).toMatchObject({ ok: true });
    expect((await draft()).salesCards).toEqual([]);
  });

  it("заготовка несуществующего этапа — ошибка с подсказкой", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: "nope", title: "Цена", when: "Спросили", text: "9 900 ₽", verbatim: true } }] });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/этап|нод/i) });
  });

  it("«дословно» уходит человеку как есть: указание консультанту туда не пропускается", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_sales_card", card: { stateId: null, title: "Цена", when: "Спросили цену", text: "Скажи цену курса и предложи ссылку", verbatim: true } }],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("схема edit_lead_magnet знает обе операции", () => {
    expect(editLeadMagnetInput.safeParse({ changes: [{ op: "remove_sales_card", id: "x" }] }).success).toBe(true);
    expect(
      editLeadMagnetInput.safeParse({ changes: [{ op: "put_sales_card", card: { stateId: null, title: "a", when: "b", text: "c", verbatim: false } }] }).success,
    ).toBe(true);
  });

  it("view_lead_magnet: раздел salesCards — заготовки с названием этапа", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: workingState(), title: "Цена", when: "Спросили цену", text: "9 900 ₽", verbatim: true } }] });
    const view = await viewLeadMagnet(deps, lead.id, { sections: ["salesCards"] });
    expect(view.salesCards).toEqual([expect.objectContaining({ title: "Цена", stateId: workingState(), stateTitle: expect.any(String), verbatim: true })]);
  });

  it("view_lead_magnet: раздел knowledge — тексты баз знаний лидмагнита, материал для заготовок", async () => {
    expect(VIEW_SECTIONS).toContain("knowledge");
    const base = await createKnowledgeBase(database.db, { title: "Тарифы" }, { name: "t.txt", bytes: new TextEncoder().encode("Тариф «Сам» — 9 900 ₽, рассрочка на 3 месяца.") });
    await saveDraft(database.db, lead.id, { ...(await draft()), knowledgeIds: [base.id] }, "manual");
    const view = await viewLeadMagnet(deps, lead.id, { sections: ["knowledge"] });
    expect(view.knowledge).toEqual([expect.objectContaining({ title: "Тарифы", text: expect.stringContaining("рассрочка на 3 месяца") })]);
  });
});

describe("ручная правка заготовок — заметка конструктору", () => {
  it("добавлена, изменена, удалена", () => {
    const before = { ...lead.draft, salesCards: [{ id: "a", stateId: null, title: "Дорого", when: "Дорого", text: "Рассрочка", verbatim: false }] };
    const after = {
      ...lead.draft,
      salesCards: [
        { id: "a", stateId: null, title: "Дорого", when: "Дорого", text: "Рассрочка на 3 месяца", verbatim: false },
        { id: "b", stateId: null, title: "Время", when: "Нет времени", text: "20 минут в день", verbatim: false },
      ],
    };
    const notes = describeManualEdits(before, after, new Map()).join("\n");
    expect(notes).toMatch(/Заготовк[^\n]*«Время»[^\n]*добавлен/);
    expect(notes).toMatch(/Заготовк[^\n]*«Дорого»[^\n]*текст/);
    expect(describeManualEdits(after, before, new Map()).join("\n")).toMatch(/Заготовк[^\n]*«Время»[^\n]*удален/);
  });
});

describe("эксперт правит заготовки на доске", () => {
  it("сохранение ложится в свежий черновик ручной версией, остальное не трогает, конструктор узнаёт заметкой", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "farewellMessage", value: "Пока!" }] });
    const result = await saveExpertSalesCard(database.db, lead.id, { stateId: workingState(), title: "Цена", when: "Спросили цену", text: "9 900 ₽", verbatim: true });
    expect(result).toMatchObject({ ok: true, card: { title: "Цена", id: expect.any(String) } });
    const saved = await draft();
    expect(saved.farewellMessage).toBe("Пока!");
    expect(saved.salesCards).toEqual([expect.objectContaining({ title: "Цена", stateId: workingState() })]);
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("manual");
    expect((await getLeadMagnet(database.db, lead.id))!.pendingManualEdits.map((note) => note.text).join("\n")).toMatch(/Заготовка «Цена».*добавлена/);
  });

  it("правка по id и удаление; неизвестная заготовка — ошибка словами", async () => {
    const added = await saveExpertSalesCard(database.db, lead.id, { stateId: null, title: "Дорого", when: "Дорого", text: "Рассрочка", verbatim: false });
    if (!added.ok) throw new Error(added.error);
    await saveExpertSalesCard(database.db, lead.id, { ...added.card, text: "Рассрочка на 3 месяца" });
    expect((await draft()).salesCards).toEqual([{ ...added.card, text: "Рассрочка на 3 месяца" }]);
    expect(await removeExpertSalesCard(database.db, lead.id, "gone")).toMatchObject({ ok: false, error: expect.stringMatching(/заготовк/) });
    expect(await removeExpertSalesCard(database.db, lead.id, added.card.id)).toMatchObject({ ok: true });
    expect((await draft()).salesCards).toEqual([]);
  });

  it("пустое название — отказ с текстом проверки, черновик прежний", async () => {
    const result = await saveExpertSalesCard(database.db, lead.id, { stateId: null, title: " ", when: "Дорого", text: "Рассрочка", verbatim: false });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/названи/) });
    expect((await draft()).salesCards).toEqual([]);
  });
});
