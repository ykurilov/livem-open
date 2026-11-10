import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { leadMagnets } from "../lead-magnets/schema";
import type { DatabaseExecutor } from "../platform/db";
import { answerCorrections } from "./schema";
import { toAnswerCorrection } from "./store";
import type { AnswerCorrection, CorrectionAgentRole, CorrectionSource } from "./types";

/** Заготовка правки: всё, что не задано, — правка ответа консультанта в «Проверке» на текущей версии черновика. */
export type SeedCorrection = Partial<Omit<AnswerCorrection, "id" | "leadMagnetId">> & Pick<AnswerCorrection, "originalText" | "correctedText">;

/** Правки в базе мимо «Проверки»: для интеграционных тестов и eval. */
export async function seedCorrections(db: DatabaseExecutor, leadMagnetId: string, items: readonly SeedCorrection[]): Promise<AnswerCorrection[]> {
  if (items.length === 0) return [];
  const [lead] = await db.select({ draftVersionId: leadMagnets.draftVersionId }).from(leadMagnets).where(eq(leadMagnets.id, leadMagnetId));
  if (!lead?.draftVersionId) throw new Error(`Лидмагнит ${leadMagnetId} не найден`);
  const rows = await db
    .insert(answerCorrections)
    .values(
      items.map((item) => ({
        source: "preview" as CorrectionSource,
        agentRole: "consultant" as CorrectionAgentRole,
        chatId: randomUUID(),
        originalMessageId: randomUUID(),
        correctedMessageId: randomUUID(),
        answerKind: "reply" as const,
        context: [],
        actions: [],
        draftVersionId: lead.draftVersionId!,
        status: "pending" as const,
        ...item,
        leadMagnetId,
      })),
    )
    .returning();
  return rows.map(toAnswerCorrection);
}
