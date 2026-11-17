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
      changes: [{ op: "put_sales_card", card: { stateId: workingState(), title: "Цена", when: "Спросили цену", text: "Курс стоит 9 900 ₽", mode: "verbatim" } }],
    });
    expect(result).toMatchObject({ ok: true });
    const [card] = (await draft()).salesCards;
    expect(card).toMatchObject({ stateId: workingState(), title: "Цена", when: "Спросили цену", text: "Курс стоит 9 900 ₽", mode: "verbatim" });
    expect(card!.id).toMatch(/^\S{4,}$/);
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("constructor");
  });

  it("общая шпаргалка — stateId null; put_sales_card с тем же id правит заготовку", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: null, title: "Дорого", when: "Человеку дорого", text: "Есть рассрочка", mode: "own_words" } }] });
    const [card] = (await draft()).salesCards;
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { ...card!, text: "Есть рассрочка на 3 месяца" } }] });
    expect((await draft()).salesCards).toEqual([{ ...card!, text: "Есть рассрочка на 3 месяца" }]);
  });

  it("put_sales_card пишет формулу: текст с пропусками в квадратных скобках сохраняется как есть", async () => {
    const text = "[Назови задачу человека]. Начните с [первый шаг] — так вы [что это даст].";
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_sales_card", card: { stateId: workingState(), title: "Разбор задачи", when: "Человек описал задачу", text, mode: "formula" } }],
    });
    expect(result).toMatchObject({ ok: true });
    expect((await draft()).salesCards).toEqual([expect.objectContaining({ text, mode: "formula" })]);
  });

  it("remove_sales_card убирает заготовку; неизвестный id — ошибка, ничего не изменено", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: null, title: "Дорого", when: "Человеку дорого", text: "Есть рассрочка", mode: "own_words" } }] });
    const [card] = (await draft()).salesCards;
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_sales_card", id: "nope" }] })).toMatchObject({ ok: false, error: expect.stringMatching(/заготовк/i) });
    expect(await editLeadMagnet(deps, lead.id, { changes: [{ op: "remove_sales_card", id: card!.id }] })).toMatchObject({ ok: true });
    expect((await draft()).salesCards).toEqual([]);
  });

  it("заготовка несуществующего этапа — ошибка с подсказкой", async () => {
    const result = await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: "nope", title: "Цена", when: "Спросили", text: "9 900 ₽", mode: "verbatim" } }] });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/этап|нод/i) });
  });

  it("«дословно» уходит человеку как есть: указание консультанту туда не пропускается", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_sales_card", card: { stateId: null, title: "Цена", when: "Спросили цену", text: "Скажи цену курса и предложи ссылку", mode: "verbatim" } }],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("формула: текст вне [пропусков] уходит человеку как есть — указание консультанту и «передам эксперту» там не пропускаются", async () => {
    const put = (text: string) =>
      editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: null, title: "Цена", when: "Спросили цену", text, mode: "formula" } }] });
    const direction = await put("Скажи цену курса. [Назови цену и что в неё входит].");
    expect(direction).toMatchObject({ ok: false, error: expect.stringMatching(/вне пропусков.*квадратные скобки/s) });
    expect(await put("Курс стоит [цена]. Я передам эксперту, что вам интересно.")).toMatchObject({ ok: false, error: expect.stringMatching(/передам/i) });
    expect((await draft()).salesCards).toEqual([]);
  });

  it("формула: указания консультанту внутри [пропусков] — не ошибка", async () => {
    const result = await editLeadMagnet(deps, lead.id, {
      changes: [{ op: "put_sales_card", card: { stateId: null, title: "Цена", when: "Спросили цену", text: "[Скажи цену курса]. [Если человек сомневается, предложи рассрочку].", mode: "formula" } }],
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("схема edit_lead_magnet знает обе операции", () => {
    expect(editLeadMagnetInput.safeParse({ changes: [{ op: "remove_sales_card", id: "x" }] }).success).toBe(true);
    expect(
      editLeadMagnetInput.safeParse({ changes: [{ op: "put_sales_card", card: { stateId: null, title: "a", when: "b", text: "c", mode: "own_words" } }] }).success,
    ).toBe(true);
  });

  it("view_lead_magnet: раздел salesCards — заготовки с названием этапа", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "put_sales_card", card: { stateId: workingState(), title: "Цена", when: "Спросили цену", text: "9 900 ₽", mode: "verbatim" } }] });
    const view = await viewLeadMagnet(deps, lead.id, { sections: ["salesCards"] });
    expect(view.salesCards).toEqual([expect.objectContaining({ title: "Цена", stateId: workingState(), stateTitle: expect.any(String), mode: "verbatim" })]);
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
    const before = { ...lead.draft, salesCards: [{ id: "a", stateId: null, title: "Дорого", when: "Дорого", text: "Рассрочка", mode: "own_words" as const }] };
    const after = {
      ...lead.draft,
      salesCards: [
        { id: "a", stateId: null, title: "Дорого", when: "Дорого", text: "Рассрочка на 3 месяца", mode: "own_words" as const },
        { id: "b", stateId: null, title: "Время", when: "Нет времени", text: "20 минут в день", mode: "own_words" as const },
      ],
    };
    const notes = describeManualEdits(before, after, new Map()).join("\n");
    expect(notes).toMatch(/Заготовк[^\n]*«Время»[^\n]*добавлен/);
    expect(notes).toMatch(/Заготовк[^\n]*«Дорого»[^\n]*текст/);
    expect(describeManualEdits(after, before, new Map()).join("\n")).toMatch(/Заготовк[^\n]*«Время»[^\n]*удален/);
  });

  it("смена режима на формулу названа словами", () => {
    const card = { id: "a", stateId: null, title: "Дорого", when: "Дорого", text: "[ответ на сомнение]", mode: "own_words" as const };
    const notes = describeManualEdits({ ...lead.draft, salesCards: [card] }, { ...lead.draft, salesCards: [{ ...card, mode: "formula" as const }] }, new Map()).join("\n");
    expect(notes).toMatch(/Заготовк[^\n]*«Дорого»[^\n]*по формуле/);
  });
});

describe("эксперт правит заготовки на доске", () => {
  it("сохранение ложится в свежий черновик ручной версией, остальное не трогает, конструктор узнаёт заметкой", async () => {
    await editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "farewellMessage", value: "Пока!" }] });
    const result = await saveExpertSalesCard(database.db, lead.id, { stateId: workingState(), title: "Цена", when: "Спросили цену", text: "9 900 ₽", mode: "verbatim" });
    expect(result).toMatchObject({ ok: true, card: { title: "Цена", id: expect.any(String) } });
    const saved = await draft();
    expect(saved.farewellMessage).toBe("Пока!");
    expect(saved.salesCards).toEqual([expect.objectContaining({ title: "Цена", stateId: workingState() })]);
    expect((await listVersions(database.db, lead.id))[0]!.source).toBe("manual");
    expect((await getLeadMagnet(database.db, lead.id))!.pendingManualEdits.map((note) => note.text).join("\n")).toMatch(/Заготовка «Цена».*добавлена/);
  });

  it("правка по id и удаление; неизвестная заготовка — ошибка словами", async () => {
    const added = await saveExpertSalesCard(database.db, lead.id, { stateId: null, title: "Дорого", when: "Дорого", text: "Рассрочка", mode: "own_words" });
    if (!added.ok) throw new Error(added.error);
    await saveExpertSalesCard(database.db, lead.id, { ...added.card, text: "Рассрочка на 3 месяца" });
    expect((await draft()).salesCards).toEqual([{ ...added.card, text: "Рассрочка на 3 месяца" }]);
    expect(await removeExpertSalesCard(database.db, lead.id, "gone")).toMatchObject({ ok: false, error: expect.stringMatching(/заготовк/) });
    expect(await removeExpertSalesCard(database.db, lead.id, added.card.id)).toMatchObject({ ok: true });
    expect((await draft()).salesCards).toEqual([]);
  });

  it("пустое название — отказ с текстом проверки, черновик прежний", async () => {
    const result = await saveExpertSalesCard(database.db, lead.id, { stateId: null, title: " ", when: "Дорого", text: "Рассрочка", mode: "own_words" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/названи/) });
    expect((await draft()).salesCards).toEqual([]);
  });
});
