import { ANY_STATE_LAYOUT_KEY, type AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { sameFlow } from "@ykurilov/agent-chat-flows/react";

/**
 * Есть ли на доске правка, которой нет в сохранённом черновике. Положение карточек — не правка: из-за перестановки
 * конструктор не закрывается (Дмитрий 15.10), а положение уходит на сервер со следующим сохранением.
 */
export function hasUnsavedFlowEdit(board: AgentFlow, saved: AgentFlow): boolean {
  // Сравнение доски SDK: порядок ключей из jsonb базы не важен
  return !sameFlow({ ...board, layout: {} }, { ...saved, layout: {} });
}

/** Новая версия черновика на доске: карточки, которые в ней остались, стоят там, куда их поставили на доске. */
export function keepBoardLayout(next: AgentFlow, board: AgentFlow): AgentFlow {
  const nodes = new Set([...next.states.map((state) => state.id), ANY_STATE_LAYOUT_KEY, ...Object.keys(next.layout)]);
  const kept = Object.fromEntries(Object.entries(board.layout).filter(([nodeId]) => nodes.has(nodeId)));
  return { ...next, layout: { ...next.layout, ...kept } };
}
