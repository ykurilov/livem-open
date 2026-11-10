import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet } from "../lead-magnets";
import { leadMagnets } from "../lead-magnets/schema";
import {
  conversationOfChat,
  currentConversation,
  finishConversation,
  markAnswer,
  previousCards,
  setReview,
  startConversation,
  type StartConversationInput,
} from "./conversations";
import { roleSwapConversations } from "./schema";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function newLead() {
  return createLeadMagnet(database.db, { name: "Разговор наоборот" });
}

function start(leadMagnetId: string, overrides: Partial<StartConversationInput> = {}) {
  return startConversation(database.db, {
    chatId: randomUUID(),
    leadMagnetId,
    clientBrief: "Сомневается",
    clientCard: "Карточка клиента",
    topic: "Название и описание",
    ...overrides,
  });
}

describe("разговоры «Поменяемся ролями»", () => {
  it("старт даёт текущий идущий разговор со всеми полями", async () => {
    const lead = await newLead();
    const started = await start(lead.id, { clientBrief: null });

    expect(started).toMatchObject({
      leadMagnetId: lead.id,
      clientBrief: null,
      clientCard: "Карточка клиента",
      topic: "Название и описание",
      status: "active",
      finishedReason: null,
      review: null,
      answerMarks: {},
      replacedAt: null,
    });
    expect(await currentConversation(database.db, lead.id)).toEqual(started);
    expect(await conversationOfChat(database.db, started.chatId)).toEqual(started);
    expect(await currentConversation(database.db, (await newLead()).id)).toBeNull();
    expect(await conversationOfChat(database.db, randomUUID())).toBeNull();
  });

  it("новый старт заменяет прежний разговор: тот получает отметку замены, текущим становится новый", async () => {
    const lead = await newLead();
    const first = await start(lead.id);
    const second = await start(lead.id, { clientCard: "Другая карточка" });

    expect((await currentConversation(database.db, lead.id))?.chatId).toBe(second.chatId);
    expect((await conversationOfChat(database.db, first.chatId))?.replacedAt).toBeInstanceOf(Date);
    expect(second.status).toBe("active");
  });

  it("второй текущий разговор у лидмагнита база не пускает", async () => {
    const lead = await newLead();
    await start(lead.id);

    await expect(
      database.db.insert(roleSwapConversations).values({ chatId: randomUUID(), leadMagnetId: lead.id, clientCard: "к", topic: "т", status: "active" }),
    ).rejects.toThrow();
  });

  it("отметки ответов эксперта дописываются, прежние не стираются", async () => {
    const lead = await newLead();
    const { chatId } = await start(lead.id);

    await markAnswer(database.db, chatId, "m1", { draftVersionId: lead.draftVersionId });
    await markAnswer(database.db, chatId, "m2", { draftVersionId: lead.draftVersionId, stageId: "intro" });

    expect((await conversationOfChat(database.db, chatId))?.answerMarks).toEqual({
      m1: { draftVersionId: lead.draftVersionId },
      m2: { draftVersionId: lead.draftVersionId, stageId: "intro" },
    });
  });

  it("клиент ушёл, затем «Закончить и разобрать»; уход клиента после отдачи на разбор её не отменяет", async () => {
    const lead = await newLead();
    const { chatId } = await start(lead.id);

    await finishConversation(database.db, chatId, "client_left");
    expect(await conversationOfChat(database.db, chatId)).toMatchObject({ status: "finished", finishedReason: "client_left" });

    await finishConversation(database.db, chatId, "submitted");
    await finishConversation(database.db, chatId, "client_left");
    expect(await conversationOfChat(database.db, chatId)).toMatchObject({ status: "finished", finishedReason: "submitted" });
  });

  it("разбор готовится один раз: второй «preparing» подряд — отказ, после сбоя — можно снова", async () => {
    const lead = await newLead();
    const { chatId } = await start(lead.id);

    expect(await setReview(database.db, chatId, "preparing")).toBe(true);
    expect(await setReview(database.db, chatId, "preparing")).toBe(false);
    expect(await setReview(database.db, chatId, "failed")).toBe(true);
    expect(await setReview(database.db, chatId, "preparing")).toBe(true);
    expect(await setReview(database.db, chatId, "ready")).toBe(true);
    expect((await conversationOfChat(database.db, chatId))?.review).toBe("ready");
  });

  it("прошлые карточки — до 5 последних разговоров лидмагнита, новые первыми", async () => {
    const lead = await newLead();
    const other = await newLead();
    await start(other.id, { clientCard: "Чужая" });
    for (let i = 1; i <= 6; i++) await start(lead.id, { clientCard: `Карточка ${i}` });

    expect(await previousCards(database.db, lead.id)).toEqual(["Карточка 6", "Карточка 5", "Карточка 4", "Карточка 3", "Карточка 2"]);
    expect(await previousCards(database.db, (await newLead()).id)).toEqual([]);
  });

  it("удаление лидмагнита удаляет его разговоры", async () => {
    const lead = await newLead();
    await start(lead.id);
    await start(lead.id);

    await database.db.delete(leadMagnets).where(eq(leadMagnets.id, lead.id));

    expect(await database.db.select().from(roleSwapConversations).where(eq(roleSwapConversations.leadMagnetId, lead.id))).toEqual([]);
  });
});
