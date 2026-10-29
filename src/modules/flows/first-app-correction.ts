import type { AgentFlowHandle, FlowRevokeConfirmationInput } from "@ykurilov/agent-chat-flows";
import { and, eq } from "drizzle-orm";
import { passages } from "../conversations/schema";
import type { Database } from "../platform/db";
import { FIRST_APP_ID, OWN_PUBLISHED } from "./first-app-confirmations";

export class FirstAppCorrectionConflict extends Error {
  constructor(readonly status: "busy" | "stale" | "not_found") {
    super(status === "busy" ? "Чат занят: дождитесь завершения хода, перечитайте ветку и проверьте актуальность исправления"
      : status === "stale" ? "Ветка или revision изменились: перечитайте состояние и проверьте актуальность исправления"
      : "Разговор или подтверждение не найдены");
  }
}

/** Только доверенный backend после проверки полномочий оператора. Не инструмент модели и не публичный endpoint.
 * Head/opkey задаёт вызывающий: конфликт нельзя автоматически превратить в успешную отмену на другой ветке.
 * Не отменяет уже выполненный переход/покупку; 404 и удаление приложения сюда не направляются.
 */
export async function revokeFirstAppPublication(
  db: Database,
  flow: Pick<AgentFlowHandle, "revokeConfirmation">,
  input: Pick<FlowRevokeConfirmationInput, "ownerId" | "chatId" | "expectedAtMessageId" | "idempotencyKey" | "reason">,
) {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || !input.reason.trim() || input.reason.length > 1000)
    throw new Error("Для исправления требуются ограниченные operation key и причина");
  const [passage] = await db.select({ id: passages.id }).from(passages).where(and(
    eq(passages.chatId, input.chatId), eq(passages.personId, input.ownerId), eq(passages.leadMagnetId, FIRST_APP_ID),
  ));
  if (!passage) throw new FirstAppCorrectionConflict("not_found");
  const result = await flow.revokeConfirmation({ ...input, flowId: FIRST_APP_ID, ...OWN_PUBLISHED });
  if (result.status === "busy" || result.status === "stale" || result.status === "not_found") throw new FirstAppCorrectionConflict(result.status);
  return result;
}
