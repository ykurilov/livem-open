import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../lead-magnets";
import { leadMagnets } from "../lead-magnets/schema";
import { answerCorrections } from "./schema";
import {
  countPending,
  editedAnswersOfChat,
  listCorrections,
  markAnnounced,
  recordCorrection,
  recordRoleSwapAnswers,
  removeCorrection,
  resolveCorrections,
  unannounced,
} from "./store";
import { seedCorrections } from "./test-fixtures";
import type { RecordCorrectionInput, RoleSwapAnswer } from "./types";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function newLead() {
  return createLeadMagnet(database.db, { name: "Правки" });
}

function input(lead: { id: string; draftVersionId: string }, overrides: Partial<RecordCorrectionInput> = {}): RecordCorrectionInput {
  return {
    leadMagnetId: lead.id,
    source: "preview",
    agentRole: "consultant",
    chatId: randomUUID(),
    editedMessageId: randomUUID(),
    editedText: "Длинный ответ консультанта",
    correctedMessageId: randomUUID(),
    correctedText: "Короткий ответ",
    reason: "Слишком длинно",
    answerKind: "reply",
    context: [{ role: "user", text: "Привет", stage: "Знакомство" }],
    actions: ["сохранил поле «Имя»"],
    stageId: "intro",
    programDay: 2,
    draftVersionId: lead.draftVersionId,
    ...overrides,
  };
}

async function newerDraft(leadMagnetId: string) {
  const lead = await getLeadMagnet(database.db, leadMagnetId);
  return saveDraft(database.db, leadMagnetId, lead!.draft, "constructor");
}

describe("хранение правок ответов", () => {
  it("правка создаётся неразобранной со всеми полями", async () => {
    const lead = await newLead();
    const data = input(lead);
    const result = await recordCorrection(database.db, data);

    expect(result.kind).toBe("created");
    const [saved] = await listCorrections(database.db, lead.id);
    expect(saved).toMatchObject({
      leadMagnetId: lead.id,
      source: "preview",
      agentRole: "consultant",
      chatId: data.chatId,
      originalMessageId: data.editedMessageId,
      correctedMessageId: data.correctedMessageId,
      answerKind: "reply",
      originalText: "Длинный ответ консультанта",
      correctedText: "Короткий ответ",
      reason: "Слишком длинно",
      context: [{ role: "user", text: "Привет", stage: "Знакомство" }],
      actions: ["сохранил поле «Имя»"],
      stageId: "intro",
      programDay: 2,
      draftVersionId: lead.draftVersionId,
      status: "pending",
      outcome: null,
      resolvedVersionId: null,
      resolvedAt: null,
      announcedAt: null,
    });
  });

  it("повторная правка исправленного ответа находит правку по исправленному ответу и обновляет «стало»", async () => {
    const lead = await newLead();
    const first = input(lead);
    await recordCorrection(database.db, first);

    const secondId = randomUUID();
    const second = await recordCorrection(
      database.db,
      input(lead, { chatId: first.chatId, editedMessageId: first.correctedMessageId, editedText: first.correctedText, correctedMessageId: secondId, correctedText: "Ещё короче", reason: null }),
    );

    expect(second.kind).toBe("updated");
    const all = await listCorrections(database.db, lead.id, { status: "all" });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      originalMessageId: first.editedMessageId,
      originalText: "Длинный ответ консультанта",
      correctedMessageId: secondId,
      correctedText: "Ещё короче",
      reason: "Слишком длинно",
    });
  });

  it("правка исходного ответа ещё раз (вернулись на него веткой) обновляет ту же правку", async () => {
    const lead = await newLead();
    const first = input(lead);
    await recordCorrection(database.db, first);
    const again = await recordCorrection(database.db, input(lead, { editedMessageId: first.editedMessageId, editedText: first.editedText, correctedText: "Другой вариант" }));

    expect(again.kind).toBe("updated");
    expect(await countPending(database.db, lead.id)).toBe(1);
  });

  it("текст вернули к исходному — правка удаляется", async () => {
    const lead = await newLead();
    const first = input(lead);
    await recordCorrection(database.db, first);

    const back = await recordCorrection(
      database.db,
      input(lead, { editedMessageId: first.correctedMessageId, editedText: first.correctedText, correctedText: first.editedText }),
    );

    expect(back).toMatchObject({ kind: "removed", originalMessageId: first.editedMessageId });
    expect(await listCorrections(database.db, lead.id, { status: "all" })).toEqual([]);
  });

  it("одна неразобранная правка на ответ: вторую в обход хранилища база не пускает", async () => {
    const lead = await newLead();
    const originalMessageId = randomUUID();
    await seedCorrections(database.db, lead.id, [{ originalMessageId, originalText: "а", correctedText: "б" }]);

    await expect(seedCorrections(database.db, lead.id, [{ originalMessageId, originalText: "а", correctedText: "в" }])).rejects.toThrow();
    // Разобранных на тот же ответ может быть сколько угодно
    await seedCorrections(database.db, lead.id, [{ originalMessageId, originalText: "а", correctedText: "г", status: "resolved", outcome: "rejected", resolvedAt: new Date() }]);
  });

  it("«Убрать правку» удаляет только неразобранную и отдаёт исходный ответ", async () => {
    const lead = await newLead();
    const other = await newLead();
    const [pending, resolved] = await seedCorrections(database.db, lead.id, [
      { originalText: "а", correctedText: "б" },
      { originalText: "в", correctedText: "г", status: "resolved", outcome: "rejected", resolvedAt: new Date() },
    ]);

    expect(await removeCorrection(database.db, other.id, pending!.id)).toEqual({ ok: false, error: "not_found" });
    expect(await removeCorrection(database.db, lead.id, randomUUID())).toEqual({ ok: false, error: "not_found" });
    expect(await removeCorrection(database.db, lead.id, resolved!.id)).toEqual({ ok: false, error: "resolved" });

    const removed = await removeCorrection(database.db, lead.id, pending!.id);
    expect(removed).toMatchObject({ ok: true, correction: { id: pending!.id, originalMessageId: pending!.originalMessageId } });
    expect((await listCorrections(database.db, lead.id, { status: "all" })).map((item) => item.id)).toEqual([resolved!.id]);
  });

  it("«Убрать правку» держит лидмагнит, пока возвращается исходный ответ: разбор ждёт и правку уже не находит", async () => {
    const lead = await newLead();
    const [pending] = await seedCorrections(database.db, lead.id, [{ originalText: "а", correctedText: "б" }]);
    let resolving: ReturnType<typeof resolveCorrections> | undefined;

    const removed = await removeCorrection(database.db, lead.id, pending!.id, async (correction) => {
      expect(correction.id).toBe(pending!.id);
      resolving = resolveCorrections(database.db, lead.id, [pending!.id], "rejected");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await listCorrections(database.db, lead.id))[0]?.status).toBe("pending");
    });

    expect(removed).toMatchObject({ ok: true });
    expect(await resolving).toEqual({ ok: false, error: "not_pending", ids: [pending!.id] });
  });

  it("исходный ответ вернуть не вышло — правка остаётся", async () => {
    const lead = await newLead();
    const [pending] = await seedCorrections(database.db, lead.id, [{ originalText: "а", correctedText: "б" }]);

    await expect(removeCorrection(database.db, lead.id, pending!.id, () => Promise.reject(new Error("чат занят")))).rejects.toThrow("чат занят");

    expect(await countPending(database.db, lead.id)).toBe(1);
  });

  it("«учтено» без новой версии черновика — отказ; после новой — разобрана с версией", async () => {
    const lead = await newLead();
    const [correction] = await seedCorrections(database.db, lead.id, [{ originalText: "а", correctedText: "б" }]);

    expect(await resolveCorrections(database.db, lead.id, [correction!.id], "applied")).toEqual({ ok: false, error: "draft_unchanged", ids: [correction!.id] });
    expect(await countPending(database.db, lead.id)).toBe(1);

    const version = await newerDraft(lead.id);
    expect(await resolveCorrections(database.db, lead.id, [correction!.id], "applied")).toEqual({ ok: true, resolved: 1 });

    const [resolved] = await listCorrections(database.db, lead.id, { status: "resolved" });
    expect(resolved).toMatchObject({ status: "resolved", outcome: "applied", resolvedVersionId: version.id });
    expect(resolved!.resolvedAt).toBeInstanceOf(Date);
  });

  it("«учтено» требует версию новее самой правки: правка, сделанная после смены черновика, ждёт новой записи", async () => {
    const lead = await newLead();
    await newerDraft(lead.id);
    // Ответ прозвучал на первой версии, правку сделали уже после второй
    const [correction] = await seedCorrections(database.db, lead.id, [{ originalText: "а", correctedText: "б", draftVersionId: lead.draftVersionId }]);

    expect(await resolveCorrections(database.db, lead.id, [correction!.id], "applied")).toMatchObject({ ok: false, error: "draft_unchanged" });
    await newerDraft(lead.id);
    expect(await resolveCorrections(database.db, lead.id, [correction!.id], "applied")).toEqual({ ok: true, resolved: 1 });
  });

  it("«отклонено» и «уже учтено» не требуют новой версии; разбор — всё или ничего", async () => {
    const lead = await newLead();
    const other = await newLead();
    const [a, b, c] = await seedCorrections(database.db, lead.id, [
      { originalText: "а", correctedText: "б" },
      { originalText: "в", correctedText: "г" },
      { originalText: "д", correctedText: "е" },
    ]);
    const [foreign] = await seedCorrections(database.db, other.id, [{ originalText: "ж", correctedText: "з" }]);

    expect(await resolveCorrections(database.db, lead.id, [a!.id, foreign!.id], "rejected")).toEqual({ ok: false, error: "not_pending", ids: [foreign!.id] });
    expect(await countPending(database.db, lead.id)).toBe(3);

    expect(await resolveCorrections(database.db, lead.id, [a!.id, b!.id], "rejected")).toEqual({ ok: true, resolved: 2 });
    expect(await resolveCorrections(database.db, lead.id, [c!.id], "already_covered")).toEqual({ ok: true, resolved: 1 });
    expect(await resolveCorrections(database.db, lead.id, [a!.id], "already_covered")).toEqual({ ok: false, error: "not_pending", ids: [a!.id] });

    const resolved = await listCorrections(database.db, lead.id, { status: "resolved" });
    expect(resolved.map((item) => [item.id, item.outcome, item.resolvedVersionId])).toEqual([
      [a!.id, "rejected", null],
      [b!.id, "rejected", null],
      [c!.id, "already_covered", null],
    ]);
  });

  it("разобранная правка не меняется: новая правка того же ответа — новая неразобранная", async () => {
    const lead = await newLead();
    const first = input(lead);
    const created = await recordCorrection(database.db, first);
    const id = created.kind === "created" ? created.correction.id : "";
    await resolveCorrections(database.db, lead.id, [id], "rejected");

    const next = await recordCorrection(
      database.db,
      input(lead, { chatId: first.chatId, editedMessageId: first.correctedMessageId, editedText: first.correctedText, correctedText: "Третий вариант" }),
    );

    expect(next.kind).toBe("created");
    const [resolved] = await listCorrections(database.db, lead.id, { status: "resolved" });
    expect(resolved).toMatchObject({ id, correctedText: "Короткий ответ", outcome: "rejected" });
    const [pending] = await listCorrections(database.db, lead.id);
    expect(pending).toMatchObject({ originalMessageId: first.editedMessageId, originalText: first.correctedText, correctedText: "Третий вариант" });
  });

  it("неупомянутые: новые правки, отметка «упомянуто», повторная правка снова новость", async () => {
    const lead = await newLead();
    const first = input(lead);
    const created = await recordCorrection(database.db, first);
    const [second] = await seedCorrections(database.db, lead.id, [{ originalText: "а", correctedText: "б" }]);
    await seedCorrections(database.db, lead.id, [{ originalText: "в", correctedText: "г", announcedAt: new Date() }]);
    const id = created.kind === "created" ? created.correction.id : "";

    expect(await unannounced(database.db, lead.id)).toMatchObject({ ids: [id, second!.id], pendingTotal: 3 });

    const seen = await unannounced(database.db, lead.id);
    await markAnnounced(database.db, seen.ids, seen.seenAt);
    expect(await unannounced(database.db, lead.id)).toMatchObject({ ids: [], pendingTotal: 3 });

    await recordCorrection(database.db, input(lead, { editedMessageId: first.correctedMessageId, editedText: first.correctedText, correctedText: "Новое" }));
    expect(await unannounced(database.db, lead.id)).toMatchObject({ ids: [id], pendingTotal: 3 });
  });

  it("правку исправили, пока шёл ход конструктора, — она остаётся неупомянутой", async () => {
    const lead = await newLead();
    const first = input(lead);
    await recordCorrection(database.db, first);
    const seen = await unannounced(database.db, lead.id);

    await recordCorrection(database.db, input(lead, { editedMessageId: first.correctedMessageId, editedText: first.correctedText, correctedText: "Ещё короче" }));
    await markAnnounced(database.db, seen.ids, seen.seenAt);

    expect((await unannounced(database.db, lead.id)).ids).toEqual(seen.ids);
  });

  it("счёт неразобранных и отметки исправленных ответов чата", async () => {
    const lead = await newLead();
    const chatId = randomUUID();
    const [pending, resolved] = await seedCorrections(database.db, lead.id, [
      { chatId, originalText: "а", correctedText: "б" },
      { chatId, originalText: "в", correctedText: "г", status: "resolved", outcome: "applied", resolvedAt: new Date() },
      { originalText: "д", correctedText: "е" },
    ]);

    expect(await countPending(database.db, lead.id)).toBe(2);
    expect(await editedAnswersOfChat(database.db, chatId, "consultant")).toEqual([
      { messageId: pending!.correctedMessageId, correctionId: pending!.id, pending: true },
      { messageId: resolved!.correctedMessageId, correctionId: resolved!.id, pending: false },
    ]);
    expect(await editedAnswersOfChat(database.db, randomUUID(), "consultant")).toEqual([]);
  });

  it("удаление лидмагнита удаляет его правки", async () => {
    const lead = await newLead();
    await seedCorrections(database.db, lead.id, [{ originalText: "а", correctedText: "б" }]);

    await database.db.delete(leadMagnets).where(eq(leadMagnets.id, lead.id));

    expect(await database.db.select().from(answerCorrections).where(eq(answerCorrections.leadMagnetId, lead.id))).toEqual([]);
  });
});

describe("ответы эксперта за консультанта («Поменяемся ролями»)", () => {
  function answer(lead: { draftVersionId: string }, overrides: Partial<RoleSwapAnswer> = {}): RoleSwapAnswer {
    return {
      messageId: randomUUID(),
      expertText: "Ответ эксперта",
      consultantText: "Ответ консультанта",
      context: [
        { role: "assistant", text: "Здравствуйте! Что у вас за курс?" },
        { role: "user", text: "Про керамику, но я не уверен, что нужно" },
      ],
      stageId: "intro",
      draftVersionId: lead.draftVersionId,
      ...overrides,
    };
  }

  it("каждый ответ — запись «было» консультанта, «стало» эксперта, с id реплики эксперта", async () => {
    const lead = await newLead();
    const chatId = randomUUID();
    const first = answer(lead);
    const second = answer(lead, { expertText: "Второй ответ", consultantText: null, stageId: null });

    const recorded = await recordRoleSwapAnswers(database.db, { leadMagnetId: lead.id, chatId, answers: [first, second] });

    expect(recorded).toBe(2);
    const saved = await listCorrections(database.db, lead.id);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      source: "role_swap",
      agentRole: "consultant",
      chatId,
      originalMessageId: first.messageId,
      correctedMessageId: first.messageId,
      answerKind: "reply",
      originalText: "Ответ консультанта",
      correctedText: "Ответ эксперта",
      reason: null,
      context: first.context,
      actions: [],
      stageId: "intro",
      programDay: null,
      draftVersionId: lead.draftVersionId,
      status: "pending",
    });
    expect(saved[1]).toMatchObject({ originalMessageId: second.messageId, originalText: "", correctedText: "Второй ответ", stageId: null });
  });

  it("повторный вызов с теми же ответами новых записей не даёт", async () => {
    const lead = await newLead();
    const chatId = randomUUID();
    const answers = [answer(lead), answer(lead)];
    await recordRoleSwapAnswers(database.db, { leadMagnetId: lead.id, chatId, answers });

    const fresh = answer(lead);
    const again = await recordRoleSwapAnswers(database.db, { leadMagnetId: lead.id, chatId, answers: [...answers, fresh] });

    expect(again).toBe(1);
    expect((await listCorrections(database.db, lead.id)).map((item) => item.originalMessageId)).toEqual([...answers, fresh].map((item) => item.messageId));
  });

  it("правка реплики клиента пишется как обычная правка с ролью клиента; оба вида видны в списке и счёте", async () => {
    const lead = await newLead();
    const chatId = randomUUID();
    await recordRoleSwapAnswers(database.db, { leadMagnetId: lead.id, chatId, answers: [answer(lead)] });
    const edit = await recordCorrection(
      database.db,
      input(lead, { source: "role_swap", agentRole: "client", chatId, editedText: "Реплика клиента", correctedText: "Так клиент не скажет", programDay: null, actions: [] }),
    );

    expect(edit.kind).toBe("created");
    const saved = await listCorrections(database.db, lead.id);
    expect(saved.map((item) => [item.source, item.agentRole])).toEqual([
      ["role_swap", "consultant"],
      ["role_swap", "client"],
    ]);
    expect(await countPending(database.db, lead.id)).toBe(2);
    expect((await unannounced(database.db, lead.id)).ids).toEqual(saved.map((item) => item.id));
  });

  it("заготовка правок принимает вид и роль", async () => {
    const lead = await newLead();
    const [seeded] = await seedCorrections(database.db, lead.id, [{ source: "role_swap", agentRole: "client", originalText: "а", correctedText: "б" }]);
    expect(seeded).toMatchObject({ source: "role_swap", agentRole: "client" });
  });
});
