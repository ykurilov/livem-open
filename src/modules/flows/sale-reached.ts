import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import type { StageHistoryEntry } from "../consultant/schema";
import { SALE_TAG } from "./settings-to-flow";

/**
 * Человек уже был в ноде «Продажа» сценария: она текущая или есть в истории этапов. Пустая текущая нода — стартовая:
 * в истории её нет, перехода в неё не было.
 */
export function saleReachedIn(
  flow: Pick<AgentFlow, "start" | "states">,
  passage: { currentStageId: string | null; stageHistory: readonly StageHistoryEntry[] },
): boolean {
  const sale = new Set(flow.states.filter((state) => state.tags.includes(SALE_TAG)).map((state) => state.id));
  const current = passage.currentStageId ?? flow.start;
  return (current !== null && sale.has(current)) || passage.stageHistory.some((entry) => sale.has(entry.stageId));
}
