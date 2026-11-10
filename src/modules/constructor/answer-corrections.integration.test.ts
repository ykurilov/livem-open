import { randomUUID } from "node:crypto";
import { createInMemoryChatStorage } from "@ykurilov/agent-chat-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { listCorrections } from "../corrections";
import { seedCorrections } from "../corrections/test-fixtures";
import { createLeadMagnet, getLeadMagnet, saveDraft, type LeadMagnet } from "../lead-magnets";
import { startConversation } from "../role-swap";
import { createConstructorTools, editLeadMagnet, type ConstructorToolDependencies } from "./tools";

let database: TestDatabase;
let deps: ConstructorToolDependencies;
let lead: LeadMagnet;
let changes: number;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  deps = { db: database.db, chatStorage: createInMemoryChatStorage() };
  lead = (await getLeadMagnet(database.db, (await createLeadMagnet(database.db, { name: "Правки ответов" })).id))!;
  changes = 0;
});

const options = { toolCallId: "t1", messages: [], context: {} } as never;
const tools = () => createConstructorTools(deps, lead.id, () => void changes++);
const read = (input: { status?: "pending" | "resolved" | "all" } = {}) => tools().read_answer_corrections!.execute!(input as never, options) as Promise<string>;
const resolve = (ids: string[], outcome: "applied" | "rejected" | "already_covered") =>
  tools().resolve_answer_corrections!.execute!({ ids, outcome } as never, options) as Promise<{ ok: boolean; resolved?: number; error?: string }>;

/** Новая версия черновика: так конструктор записывает изменение по правке. */
const editDraft = () => editLeadMagnet(deps, lead.id, { changes: [{ op: "set", field: "name", value: `Правки ответов ${Math.random()}` }] });

describe("read_answer_corrections", () => {
  it("правка по контракту: нода, день, вид, версия, действия, кусок разговора, было, стало, почему", async () => {
    const stage = lead.draft.flow.states[0]!;
    const [correction] = await seedCorrections(database.db, lead.id, [
      {
        originalText: "Отличный вопрос! Давайте разберём подробно, по шагам и с примерами.",
        correctedText: "Коротко: начните с одной задачи.",
        reason: "Слишком длинно для мессенджера",
        stageId: stage.id,
        programDay: 2,
        actions: ["сохранил поле «Телефон»"],
        context: [
          { role: "assistant", text: "Здравствуйте! С чем пришли?", stage: "Знакомство" },
          { role: "user", text: "Хочу понять, с чего начать", stage: stage.title },
        ],
      },
    ]);

    const text = await read();
    const lines = text.split("\n");
    expect(lines[0]).toMatch(new RegExp(`^Правка ${correction!.id} · .+ · нода «${stage.title}» · день 2 · ответ$`));
    expect(text).toContain("Сделана на старой версии черновика: нет");
    expect(text).toContain("Действия в ответе: сохранил поле «Телефон»");
    expect(text).toContain("Перед ответом:");
    expect(text).toContain("Консультант: Здравствуйте! С чем пришли?");
    expect(text).toContain("Человек: Хочу понять, с чего начать");
    expect(text).toContain("[этап: Знакомство]");
    expect(text).toContain(`[этап: ${stage.title}]`);
    expect(text).toContain("Было: Отличный вопрос! Давайте разберём подробно, по шагам и с примерами.");
    expect(text).toContain("Стало: Коротко: начните с одной задачи.");
    expect(text).toContain("Почему: Слишком длинно для мессенджера");
    expect(text).not.toContain("Итог:");
    // Реплики разговора — до «Было»
    expect(text.indexOf("Перед ответом:")).toBeLessThan(text.indexOf("Человек: Хочу понять"));
    expect(text.indexOf("Человек: Хочу понять")).toBeLessThan(text.indexOf("Было:"));
  });

  it("без причины, действий, ноды и дня; вид — первое сообщение и ответ с прощанием", async () => {
    await seedCorrections(database.db, lead.id, [
      { originalText: "Привет!", correctedText: "Здравствуйте!", answerKind: "first_message" },
      { originalText: "Пока!", correctedText: "До встречи!", answerKind: "farewell" },
    ]);
    const blocks = (await read()).split(/\n\n(?=Правка )/);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.split("\n")[0]).toMatch(/ · первое сообщение$/);
    expect(blocks[0]!.split("\n")[0]).not.toMatch(/нода|день/);
    expect(blocks[1]!.split("\n")[0]).toMatch(/ · ответ с прощанием$/);
    for (const block of blocks) {
      expect(block).toContain("Почему: не написано");
      expect(block).toContain("Действия в ответе: нет");
    }
  });

  it("правка на старой версии черновика помечена", async () => {
    await seedCorrections(database.db, lead.id, [{ originalText: "Было", correctedText: "Стало" }]);
    await saveDraft(database.db, lead.id, { ...lead.draft, name: "Новое имя" }, "manual");
    expect(await read()).toContain("Сделана на старой версии черновика: да");
  });

  it("по умолчанию — только неразобранные; нет их — так и сказано", async () => {
    expect(await read()).toBe("Неразобранных правок нет.");
    const [done] = await seedCorrections(database.db, lead.id, [{ originalText: "Старое", correctedText: "Разобранное" }]);
    expect(await resolve([done!.id], "rejected")).toEqual({ ok: true, resolved: 1 });
    expect(await read()).toBe("Неразобранных правок нет.");
    await seedCorrections(database.db, lead.id, [{ originalText: "Ещё", correctedText: "Неразобранное" }]);
    const pending = await read();
    expect(pending).toContain("Стало: Неразобранное");
    expect(pending).not.toContain("Стало: Разобранное");
  });

  it("разобранные — с итогом: учтено в версии, отклонено, уже учтено", async () => {
    const [applied, rejected, covered] = await seedCorrections(database.db, lead.id, [
      { originalText: "А1", correctedText: "Б1" },
      { originalText: "А2", correctedText: "Б2" },
      { originalText: "А3", correctedText: "Б3" },
    ]);
    expect((await editDraft()).ok).toBe(true);
    expect(await resolve([applied!.id], "applied")).toEqual({ ok: true, resolved: 1 });
    expect(await resolve([rejected!.id], "rejected")).toEqual({ ok: true, resolved: 1 });
    expect(await resolve([covered!.id], "already_covered")).toEqual({ ok: true, resolved: 1 });

    const resolved = (await read({ status: "resolved" })).split(/\n\n(?=Правка )/);
    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toMatch(/\nИтог: учтено в версии от .+$/);
    expect(resolved[1]).toMatch(/\nИтог: отклонено$/);
    expect(resolved[2]).toMatch(/\nИтог: уже учтено$/);

    await seedCorrections(database.db, lead.id, [{ originalText: "А4", correctedText: "Б4" }]);
    const all = (await read({ status: "all" })).split(/\n\n(?=Правка )/);
    expect(all).toHaveLength(4);
    expect(all[3]).not.toContain("Итог:");
  });

  it("чужие правки не видны; пустой список назван по выбранным правкам", async () => {
    const other = await createLeadMagnet(database.db, { name: "Другой" });
    await seedCorrections(database.db, other.id, [{ originalText: "Чужое", correctedText: "Чужое стало" }]);
    expect(await read({ status: "all" })).toBe("Правок нет.");
    expect(await read({ status: "resolved" })).toBe("Разобранных правок нет.");
  });
});

describe("read_answer_corrections: записи «Поменяемся ролями»", () => {
  let chatId: string;
  beforeEach(() => {
    chatId = randomUUID();
  });
  const card = "Ольга, 42 года, ведёт йогу в маленьком зале, боится, что курс не окупится";

  const startSwap = () =>
    startConversation(database.db, { chatId, leadMagnetId: lead.id, clientBrief: null, clientCard: card, topic: lead.draft.name });

  const swapContext = [
    { role: "assistant" as const, text: "Здравствуйте! С чем пришли?" },
    { role: "user" as const, text: "Хочу больше учеников" },
  ];

  it("ответ эксперта и правка клиента — одной группой разговора с карточкой клиента; записи 010 — прежним видом", async () => {
    await startSwap();
    const stage = lead.draft.flow.states[0]!;
    const [preview, answer, noComparison, clientEdit] = await seedCorrections(database.db, lead.id, [
      { originalText: "Старый ответ", correctedText: "Новый ответ" },
      {
        source: "role_swap",
        chatId,
        originalText: "Давайте разберём вашу ситуацию подробно",
        correctedText: "Сколько учеников сейчас?",
        stageId: stage.id,
        context: swapContext,
      },
      { source: "role_swap", chatId, originalText: "", correctedText: "А сколько хотите?", context: swapContext },
      {
        source: "role_swap",
        agentRole: "client",
        chatId,
        originalText: "Спасибо, вы мне очень помогли!",
        correctedText: "Ну не знаю, дорого",
        reason: "Мои клиенты так быстро не соглашаются",
        context: swapContext,
      },
    ]);

    const text = await read();
    const blocks = text.split(/\n\n/);
    // Запись 010 — прежним блоком
    expect(blocks[0]).toMatch(new RegExp(`^Правка ${preview!.id} · `));
    expect(blocks[0]).toContain("Было: Старый ответ");

    const group = text.slice(text.indexOf("Разговор «Поменяемся ролями»"));
    expect(group).toMatch(new RegExp(`^Разговор «Поменяемся ролями» ${chatId} · .+\nКлиента играл агент: ${card}\n`));
    expect(group).toContain(`Ответ эксперта ${answer!.id} · нода «${stage.title}»`);
    expect(group).toContain(`Ответ эксперта ${noComparison!.id} · без ноды`);
    expect(group).toContain("Сделан на старой версии черновика: нет");
    expect(group).toContain("Клиент: Хочу больше учеников");
    expect(group).toContain("Эксперт за консультанта: Здравствуйте! С чем пришли?");
    expect(group).toContain("Консультант ответил бы: Давайте разберём вашу ситуацию подробно\nЭксперт ответил: Сколько учеников сейчас?");
    expect(group).toContain("Консультант ответил бы: не удалось посчитать\nЭксперт ответил: А сколько хотите?");
    expect(group).toContain(`Правка реплики клиента ${clientEdit!.id}`);
    expect(group).toContain("Перед репликой:");
    expect(group).toContain("Агент-клиент написал: Спасибо, вы мне очень помогли!");
    expect(group).toContain("Эксперт исправил на: Ну не знаю, дорого");
    expect(group).toContain("Почему: Мои клиенты так быстро не соглашаются");
    expect(group).not.toContain("Итог:");
    // У ответа эксперта нет «Было/Стало» правки 010
    expect(group).not.toContain("Было:");
    // Разговор — одной группой: заголовок один
    expect(text.match(/Разговор «Поменяемся ролями»/g)).toHaveLength(1);
  });

  it("правка клиента без причины — «не написано»; разговора нет — строки карточки нет", async () => {
    await seedCorrections(database.db, lead.id, [
      { source: "role_swap", agentRole: "client", chatId: "00000000-0000-4000-8000-0000000000b2", originalText: "Да", correctedText: "Нет" },
    ]);
    const text = await read();
    expect(text).toMatch(/^Разговор «Поменяемся ролями» 00000000-0000-4000-8000-0000000000b2 · .+\n\nПравка реплики клиента /);
    expect(text).not.toContain("Клиента играл агент");
    expect(text).toContain("Почему: не написано");
  });

  it("два разговора — две группы; ответ на старой версии черновика помечен", async () => {
    await startSwap();
    await seedCorrections(database.db, lead.id, [
      { source: "role_swap", chatId, originalText: "А", correctedText: "Б" },
      { source: "role_swap", chatId: "00000000-0000-4000-8000-0000000000c3", originalText: "В", correctedText: "Г" },
    ]);
    await saveDraft(database.db, lead.id, { ...lead.draft, name: "Новое имя" }, "manual");
    const text = await read();
    expect(text.match(/Разговор «Поменяемся ролями»/g)).toHaveLength(2);
    expect(text).toContain("Сделан на старой версии черновика: да");
  });

  it("resolve_answer_corrections закрывает ответы эксперта и правки клиента; у разобранных — итог", async () => {
    await startSwap();
    const [answer, clientEdit] = await seedCorrections(database.db, lead.id, [
      { source: "role_swap", chatId, originalText: "Консультант", correctedText: "Эксперт" },
      { source: "role_swap", agentRole: "client", chatId, originalText: "Клиент", correctedText: "Клиент иначе" },
    ]);
    expect(await resolve([answer!.id], "already_covered")).toEqual({ ok: true, resolved: 1 });
    expect(await resolve([clientEdit!.id], "rejected")).toEqual({ ok: true, resolved: 1 });
    expect(await read()).toBe("Неразобранных правок нет.");
    const resolved = await read({ status: "resolved" });
    expect(resolved).toMatch(/Эксперт ответил: Эксперт\nИтог: уже учтено/);
    expect(resolved).toMatch(/Почему: не написано\nИтог: отклонено/);
  });
});

describe("resolve_answer_corrections", () => {
  it("«учтено» без новой версии черновика — отказ с подсказкой, ничего не отмечено", async () => {
    const [correction] = await seedCorrections(database.db, lead.id, [{ originalText: "Было", correctedText: "Стало" }]);
    const result = await resolve([correction!.id], "applied");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Сначала запишите изменение через edit_lead_magnet после согласия эксперта");
    expect(changes).toBe(0);
    expect((await listCorrections(database.db, lead.id)).map((one) => one.id)).toEqual([correction!.id]);
  });

  it("после записи изменения — «учтено», правка разобрана, панели узнают об изменении", async () => {
    const [first, second] = await seedCorrections(database.db, lead.id, [
      { originalText: "А1", correctedText: "Б1" },
      { originalText: "А2", correctedText: "Б2" },
    ]);
    expect((await editDraft()).ok).toBe(true);
    expect(await resolve([first!.id, second!.id], "applied")).toEqual({ ok: true, resolved: 2 });
    expect(changes).toBe(1);
    const [done] = await listCorrections(database.db, lead.id, { status: "resolved" });
    expect(done).toMatchObject({ outcome: "applied", resolvedVersionId: (await getLeadMagnet(database.db, lead.id))!.draftVersionId });
  });

  it("«отклонено» и «уже учтено» не требуют новой версии", async () => {
    const [first, second] = await seedCorrections(database.db, lead.id, [
      { originalText: "А1", correctedText: "Б1" },
      { originalText: "А2", correctedText: "Б2" },
    ]);
    expect(await resolve([first!.id], "rejected")).toEqual({ ok: true, resolved: 1 });
    expect(await resolve([second!.id], "already_covered")).toEqual({ ok: true, resolved: 1 });
    expect(changes).toBe(2);
  });

  it("уже разобранная, чужая или выдуманная правка — отказ, остальные из того же вызова не отмечены", async () => {
    const [mine, done] = await seedCorrections(database.db, lead.id, [
      { originalText: "А1", correctedText: "Б1" },
      { originalText: "А2", correctedText: "Б2" },
    ]);
    await resolve([done!.id], "rejected");
    changes = 0;
    const other = await createLeadMagnet(database.db, { name: "Другой" });
    const [foreign] = await seedCorrections(database.db, other.id, [{ originalText: "Чужое", correctedText: "Чужое стало" }]);

    for (const ids of [[mine!.id, done!.id], [mine!.id, foreign!.id], [mine!.id, "не-id"]]) {
      const result = await resolve(ids, "rejected");
      expect(result.ok).toBe(false);
      expect(result.error).toContain(ids[1]!);
    }
    expect(changes).toBe(0);
    expect((await listCorrections(database.db, lead.id)).map((one) => one.id)).toEqual([mine!.id]);
    expect(await listCorrections(database.db, other.id)).toHaveLength(1);
  });
});
