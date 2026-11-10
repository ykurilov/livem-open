import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { saveExpertEdit } from "../constructor";
import { liveConsultantVersion } from "../consultant/services";
import { createLeadMagnet, getLeadMagnet, InvalidLeadMagnetSettingsError, saveDraft } from "../lead-magnets";
import {
  InvalidKnowledgeError,
  KNOWLEDGE_MAX_CHARS,
  createKnowledgeBase,
  deleteKnowledgeBase,
  editKnowledgeBase,
  getKnowledgeBases,
  knowledgeChars,
  listKnowledgeBases,
  renameKnowledgeBase,
  replaceKnowledgeFile,
} from "./index";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const file = (text: string, name = "курс.txt") => ({ name, bytes: new TextEncoder().encode(text) });

/** Лидмагнит с прикреплёнными базами в черновике. */
async function leadWith(name: string, knowledgeIds: string[]) {
  const lead = await createLeadMagnet(database.db, { name });
  await saveDraft(database.db, lead.id, { ...lead.draft, knowledgeIds }, "manual");
  return (await getLeadMagnet(database.db, lead.id))!;
}

describe("архив баз знаний", () => {
  it("сохраняет текст файла: название по умолчанию — имя файла без расширения; в списке размер и новые сверху", async () => {
    const first = await createKnowledgeBase(database.db, { title: "" }, file("Урок 1. Упаковка.", "Транскрипт курса.md"));
    expect(first).toMatchObject({ title: "Транскрипт курса", fileName: "Транскрипт курса.md", charCount: 17 });
    const second = await createKnowledgeBase(database.db, { title: "  Частые вопросы " }, file("Вопрос — ответ"));
    expect(second.title).toBe("Частые вопросы");
    const listed = await listKnowledgeBases(database.db);
    expect(listed.map((base) => base.id).slice(0, 2)).toEqual([second.id, first.id]);
    expect(listed[1]).toMatchObject({ charCount: 17, byteSize: new TextEncoder().encode("Урок 1. Упаковка.").byteLength, usedBy: [] });
    expect(listed[0]).not.toHaveProperty("content");
  });

  it("плохой файл не сохраняется: понятная ошибка", async () => {
    await expect(createKnowledgeBase(database.db, { title: "Пусто" }, file("   "))).rejects.toThrow(InvalidKnowledgeError);
    await expect(createKnowledgeBase(database.db, { title: "Длинный" }, file("я".repeat(KNOWLEDGE_MAX_CHARS + 1)))).rejects.toThrow(/200 000 знаков/);
  });

  it("показывает, к каким лидмагнитам прикреплена база: черновик и опубликованная версия, без повторов", async () => {
    const base = await createKnowledgeBase(database.db, { title: "Общая" }, file("текст"));
    const draftOnly = await leadWith("Черновик с базой", [base.id]);
    const published = await leadWith("Опубликованный с базой", [base.id]);
    // Публикации нужен бот; здесь важен только снимок, поэтому он ставится напрямую
    await database.db.execute(sql`update app.lead_magnets set published_snapshot_id = draft_version_id where id = ${published.id}`);
    await saveDraft(database.db, published.id, { ...published.draft, knowledgeIds: [] }, "manual");
    const used = (await listKnowledgeBases(database.db)).find((one) => one.id === base.id)!.usedBy;
    expect(used.map((lead) => lead.name).sort()).toEqual(["Опубликованный с базой", "Черновик с базой"]);
    expect(used.find((lead) => lead.id === draftOnly.id)).toEqual({ id: draftOnly.id, name: "Черновик с базой" });
  });

  it("переименование и замена файла меняют updatedAt; замена сверх предела лидмагнита — ошибка с его названием", async () => {
    const base = await createKnowledgeBase(database.db, { title: "Старое" }, file("коротко"));
    const other = await createKnowledgeBase(database.db, { title: "Соседняя" }, file("я".repeat(KNOWLEDGE_MAX_CHARS - 100)));
    await leadWith("Тесный лидмагнит", [base.id, other.id]);
    // Отодвинуть время создания: иначе переименование может прийтись на ту же миллисекунду
    await database.db.execute(sql`update app.knowledge_bases set updated_at = updated_at - interval '1 minute' where id = ${base.id}`);
    const renamed = await renameKnowledgeBase(database.db, base.id, "Новое");
    expect(renamed.title).toBe("Новое");
    expect(renamed.updatedAt.getTime()).toBeGreaterThan(base.updatedAt.getTime() - 60_000);
    // То же название — база не тронута: иначе сменился бы ключ службы и кэш модели сбросился без причины
    const same = await renameKnowledgeBase(database.db, base.id, " Новое ");
    expect(same.updatedAt.getTime()).toBe(renamed.updatedAt.getTime());
    await expect(renameKnowledgeBase(database.db, base.id, " ")).rejects.toThrow(/название/);
    await expect(replaceKnowledgeFile(database.db, base.id, file("я".repeat(200)))).rejects.toThrow(/«Тесный лидмагнит»/);
    const replaced = await replaceKnowledgeFile(database.db, base.id, file("новый текст", "версия 2.md"));
    expect(replaced).toMatchObject({ title: "Новое", fileName: "версия 2.md", charCount: 11 });
    expect((await getKnowledgeBases(database.db, [base.id]))[0]!.content).toBe("новый текст");
  });

  it("правка базы: новый файл и название сохраняются вместе — не сохранилось одно, не сохраняется и другое", async () => {
    const base = await createKnowledgeBase(database.db, { title: "Прайс" }, file("старые цены"));
    await expect(editKnowledgeBase(database.db, base.id, { title: " ", file: file("новые цены") })).rejects.toThrow(/название/);
    expect((await getKnowledgeBases(database.db, [base.id]))[0]).toMatchObject({ title: "Прайс", content: "старые цены" });
    const edited = await editKnowledgeBase(database.db, base.id, { title: "Прайс 2027", file: file("новые цены", "прайс.md") });
    expect(edited).toMatchObject({ title: "Прайс 2027", fileName: "прайс.md", charCount: 10 });
    await expect(editKnowledgeBase(database.db, base.id, { title: "Прайс 2028" })).resolves.toMatchObject({ title: "Прайс 2028", fileName: "прайс.md" });
  });

  it("замена файла: предел проверяется отдельно у черновика и у опубликованной версии, а не по их сумме", async () => {
    const replaced = await createKnowledgeBase(database.db, { title: "Меняемая" }, file("коротко"));
    const inDraft = await createKnowledgeBase(database.db, { title: "Только в черновике" }, file("я".repeat(KNOWLEDGE_MAX_CHARS / 2)));
    const inPublished = await createKnowledgeBase(database.db, { title: "Только в опубликованной" }, file("я".repeat(KNOWLEDGE_MAX_CHARS / 2)));
    const lead = await leadWith("Черновик и версия порознь", [replaced.id, inPublished.id]);
    // Публикации нужен бот; здесь важен только снимок, поэтому он ставится напрямую
    await database.db.execute(sql`update app.lead_magnets set published_snapshot_id = draft_version_id where id = ${lead.id}`);
    await saveDraft(database.db, lead.id, { ...lead.draft, knowledgeIds: [replaced.id, inDraft.id] }, "manual");
    const fits = KNOWLEDGE_MAX_CHARS / 2 - 10;
    await expect(replaceKnowledgeFile(database.db, replaced.id, file("я".repeat(fits)))).resolves.toMatchObject({ charCount: fits });
    await expect(replaceKnowledgeFile(database.db, replaced.id, file("я".repeat(KNOWLEDGE_MAX_CHARS / 2 + 10)))).rejects.toThrow(/«Черновик и версия порознь»/);
  });

  it("удалённая база пропадает из списка и из выдачи; getKnowledgeBases держит порядок id", async () => {
    const a = await createKnowledgeBase(database.db, { title: "А" }, file("а"));
    const b = await createKnowledgeBase(database.db, { title: "Б" }, file("бб"));
    expect((await getKnowledgeBases(database.db, [b.id, a.id])).map((base) => base.title)).toEqual(["Б", "А"]);
    expect(await knowledgeChars(database.db, [a.id, b.id])).toBe(3);
    await deleteKnowledgeBase(database.db, a.id, new Date());
    expect((await getKnowledgeBases(database.db, [b.id, a.id])).map((base) => base.title)).toEqual(["Б"]);
    expect((await listKnowledgeBases(database.db)).some((base) => base.id === a.id)).toBe(false);
  });
});

describe("базы знаний в лидмагните", () => {
  it("ручное сохранение настроек сверх предела — понятная ошибка; удалённые базы из черновика уходят", async () => {
    const big = await createKnowledgeBase(database.db, { title: "Большая" }, file("я".repeat(KNOWLEDGE_MAX_CHARS - 10)));
    const small = await createKnowledgeBase(database.db, { title: "Малая" }, file("я".repeat(20)));
    const gone = await createKnowledgeBase(database.db, { title: "Удалённая" }, file("я"));
    await deleteKnowledgeBase(database.db, gone.id, new Date());
    const lead = await createLeadMagnet(database.db, { name: "Предел" });
    const tooMuch = saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, knowledgeIds: [big.id, small.id] }, expectedVersionId: lead.draftVersionId });
    await expect(tooMuch).rejects.toThrow(InvalidLeadMagnetSettingsError);
    await expect(tooMuch).rejects.toThrow(/200 000/);
    const { version } = await saveExpertEdit(database.db, lead.id, { settings: { ...lead.draft, knowledgeIds: [big.id, gone.id] }, expectedVersionId: lead.draftVersionId });
    expect(version.settings.knowledgeIds).toEqual([big.id]);
  });

  it("консультант получает тексты живых баз в инструкции версии; замена текста меняет ключ службы", async () => {
    const base = await createKnowledgeBase(database.db, { title: "Факты" }, file("Курс длится 4 недели."));
    const lead = await leadWith("С фактами", [base.id]);
    const live = await liveConsultantVersion(database.db, lead.draftVersionId, lead.draft);
    expect(live.knowledge.map((one) => one.content)).toEqual(["Курс длится 4 недели."]);
    expect(live.instruction).toContain("Курс длится 4 недели.");
    const again = await liveConsultantVersion(database.db, lead.draftVersionId, lead.draft);
    expect(again.key).toBe(live.key);
    await replaceKnowledgeFile(database.db, base.id, file("Курс длится 6 недель."));
    const replaced = await liveConsultantVersion(database.db, lead.draftVersionId, lead.draft);
    expect(replaced.key).not.toBe(live.key);
    expect(replaced.instruction).toContain("6 недель");
    await deleteKnowledgeBase(database.db, base.id, new Date());
    const deleted = await liveConsultantVersion(database.db, lead.draftVersionId, lead.draft);
    expect(deleted.settings.knowledgeIds).toEqual([]);
    expect(deleted.instruction).not.toContain("Курс длится 6 недель.");
  });

  it("лидмагнит, сохранённый до баз знаний (без knowledgeIds): миграция дописывает пустой список, а чтение не падает и без неё", async () => {
    const lead = await createLeadMagnet(database.db, { name: "Старый лидмагнит" });
    const strip = async () => {
      await database.db.execute(sql`update app.lead_magnets set draft = draft - 'knowledgeIds' where id = ${lead.id}`);
      await database.db.execute(sql`update app.lead_magnet_versions set settings = settings - 'knowledgeIds' where lead_magnet_id = ${lead.id}`);
    };
    await strip();
    const old = (await getLeadMagnet(database.db, lead.id))!;
    expect(old.draft).not.toHaveProperty("knowledgeIds");

    // Ход разговора и «Проверка» берут версию отсюда
    const live = await liveConsultantVersion(database.db, old.draftVersionId, old.draft);
    expect(live.settings.knowledgeIds).toEqual([]);
    expect(live.knowledge).toEqual([]);
    // Сохранение настроек и правка в редакторе
    const { version } = await saveExpertEdit(database.db, lead.id, { settings: old.draft, expectedVersionId: old.draftVersionId });
    expect(version.settings.knowledgeIds).toEqual([]);
    expect(await listKnowledgeBases(database.db)).toBeInstanceOf(Array);

    await strip();
    const migration = readFileSync(join(process.cwd(), "drizzle/0045_knowledge_bases.sql"), "utf8");
    const backfill = migration.split("--> statement-breakpoint").filter((statement) => /^\s*UPDATE/i.test(statement));
    expect(backfill).toHaveLength(2);
    for (const statement of backfill) await database.db.execute(sql.raw(statement));
    expect((await getLeadMagnet(database.db, lead.id))!.draft.knowledgeIds).toEqual([]);
    const versions = await database.db.execute(sql`select settings->'knowledgeIds' as ids from app.lead_magnet_versions where lead_magnet_id = ${lead.id}`);
    expect(versions.rows.map((row) => row.ids)).toEqual(versions.rows.map(() => []));
  });
});
