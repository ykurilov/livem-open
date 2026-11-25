import { eq, inArray } from "drizzle-orm";
import { createAttachments, type Attachments, type AttachmentStorage } from "@ykurilov/agent-chat-attachments";
import type { AgentChatMessage } from "@ykurilov/agent-chat-core";
import {
  InvalidKnowledgeError,
  KNOWLEDGE_MAX_CHARS,
  createKnowledgeBase,
  formatChars,
  knowledgeChars,
  readKnowledgeFile,
  type KnowledgeBase,
  type KnowledgeFile,
  type KnowledgeFileText,
} from "../knowledge";
import { knowledgeChatFiles } from "../knowledge/schema";
import { InvalidLeadMagnetSettingsError, findLeadMagnetByConstructorChat, lockLeadMagnet, saveDraft } from "../lead-magnets";
import { CONSTRUCTOR_FILE_TYPES, UNSENT_IMAGE_RETENTION_MS } from "../platform/chat-attachments";
import type { Database, DatabaseExecutor } from "../platform/db";
import { saveEditBesideConstructor } from "./manual-edits";

const ATTACHMENT_URL = "attachment:";
/** Вложения, которые становятся базой знаний: PDF и текст. Картинки остаются картинками. */
const KNOWLEDGE_KINDS = new Set(["pdf", "text"]);

const attachmentIdOf = (part: AgentChatMessage["parts"][number]): string | undefined =>
  part.type === "file" && part.url.startsWith(ATTACHMENT_URL) ? part.url.slice(ATTACHMENT_URL.length) : undefined;

/**
 * Вложения чата конструктора: картинки, а PDF и текстовые файлы становятся базами знаний лидмагнита этого чата.
 * Хранилище — общее с остальными чатами сайта: хранилище на диске рассчитано на один экземпляр в процессе.
 */
export function createConstructorFiles(options: { db: Database; storage: AttachmentStorage }): Attachments {
  const attachments = createAttachments({ storage: options.storage, acceptedMediaTypes: CONSTRUCTOR_FILE_TYPES, unsentRetentionMs: UNSENT_IMAGE_RETENTION_MS.web });
  return withKnowledgeFiles(attachments, options.db);
}

/**
 * Файл из сообщения эксперта становится базой и подключается к лидмагниту до записи сообщения, то есть до ответа
 * конструктора. Модель вместо текста файла видит неизменную пометку, чем файл стал: текст базы она читает разделом
 * knowledge, а ход не тащит в историю целую книгу.
 */
function withKnowledgeFiles(attachments: Attachments, db: Database): Attachments {
  return {
    ...attachments,
    async confirmUserParts(parts) {
      await attachments.confirmUserParts(parts);
      for (const id of new Set(parts.flatMap((part) => attachmentIdOf(part) ?? []))) await fileToKnowledge(db, attachments.storage, id);
    },
    async prepareHistory(input) {
      const ids = [...new Set(input.history.flatMap((message) => (message.role === "user" ? message.parts.flatMap((part) => attachmentIdOf(part) ?? []) : [])))];
      const rows = ids.length > 0 ? await db.select().from(knowledgeChatFiles).where(inArray(knowledgeChatFiles.attachmentId, ids)) : [];
      if (rows.length === 0) return attachments.prepareHistory(input);
      const notes = new Map(rows.map((row) => [row.attachmentId, row.note]));
      const history = input.history.map((message) => ({
        ...message,
        parts: message.parts.map((part) => {
          const note = notes.get(attachmentIdOf(part) ?? "");
          return note ? { type: "text" as const, text: note } : part;
        }),
      }));
      return attachments.prepareHistory({ ...input, history });
    },
  };
}

/** Один файл чата — одна база: повторная отправка того же вложения ничего не меняет. */
async function fileToKnowledge(db: Database, storage: AttachmentStorage, attachmentId: string): Promise<void> {
  const record = await storage.get(attachmentId);
  if (!record || !KNOWLEDGE_KINDS.has(record.kind)) return;
  const lead = await findLeadMagnetByConstructorChat(db, record.chatId);
  const bytes = await storage.readBytes(attachmentId);
  if (!lead || !bytes) return;
  const processed = async (tx: DatabaseExecutor) =>
    (await tx.select({ id: knowledgeChatFiles.attachmentId }).from(knowledgeChatFiles).where(eq(knowledgeChatFiles.attachmentId, attachmentId))).length > 0;
  if (await processed(db)) return;
  // Разбор (PDF — до минуты) — до транзакции: лидмагнит заблокирован только на время записи
  const file = await readChatFile({ name: record.name, bytes });

  await db.transaction(async (tx) => {
    const current = await lockLeadMagnet(tx, lead.id);
    if (await processed(tx)) return;
    if (file instanceof InvalidKnowledgeError) {
      await tx.insert(knowledgeChatFiles).values({ attachmentId, note: `[Файл «${record.name}» базой знаний не стал: ${file.message}.]` });
      return;
    }
    const base = await createKnowledgeBase(tx, { title: "" }, file);
    const attached = current.draft.knowledgeIds ?? [];
    const total = await knowledgeChars(tx, [...attached, base.id]);
    const fits = total <= KNOWLEDGE_MAX_CHARS;
    if (fits) await saveDraft(tx, lead.id, { ...current.draft, knowledgeIds: [...attached, base.id] }, "constructor");
    const note = fits
      ? `[Файл «${record.name}» стал базой знаний «${base.title}» и подключён к лидмагниту: консультант получает её текст целиком. Текст базы — в разделе knowledge.]`
      : `[Файл «${record.name}» сохранён в разделе «База знаний» как «${base.title}», но к лидмагниту не подключён: вместе с уже подключёнными базами вышло бы ${formatChars(total)} знаков, а помещается до ${formatChars(KNOWLEDGE_MAX_CHARS)}. Подключить его эксперт может в «Настройках», открепив лишнее.]`;
    await tx.insert(knowledgeChatFiles).values({ attachmentId, knowledgeBaseId: base.id, note });
  });
}

/** Текст файла для базы; не подходит — ошибка для заметки модели, а не исключение. */
async function readChatFile(file: KnowledgeFile): Promise<KnowledgeFileText | InvalidKnowledgeError> {
  try {
    return { name: file.name, byteSize: file.bytes.byteLength, ...(await readKnowledgeFile(file)) };
  } catch (error) {
    if (error instanceof InvalidKnowledgeError) return error;
    throw error;
  }
}

/**
 * Новая база из раздела «База знаний» и сразу — в выбранные лидмагниты. Не помещается хоть в один — не сохраняется
 * ничего, ошибка называет лидмагнит. Конструкторы этих лидмагнитов узнают о новой базе заметкой о ручной правке.
 */
export async function createKnowledgeBaseFor(db: Database, input: { title: string }, file: KnowledgeFile, leadMagnetIds: readonly string[]): Promise<KnowledgeBase> {
  // Разбор — до транзакции: лидмагниты заблокированы только на время записи
  const text: KnowledgeFileText = { name: file.name, byteSize: file.bytes.byteLength, ...(await readKnowledgeFile(file)) };
  return db.transaction(async (tx) => {
    const base = await createKnowledgeBase(tx, input, text);
    for (const id of new Set(leadMagnetIds)) {
      const lead = await lockLeadMagnet(tx, id);
      try {
        await saveEditBesideConstructor(tx, lead, { ...lead.draft, knowledgeIds: [...(lead.draft.knowledgeIds ?? []), base.id] }, "manual");
      } catch (error) {
        if (error instanceof InvalidLeadMagnetSettingsError) throw new InvalidKnowledgeError(`Лидмагнит «${lead.draft.name}»: ${error.message}`);
        throw error;
      }
    }
    return base;
  });
}
