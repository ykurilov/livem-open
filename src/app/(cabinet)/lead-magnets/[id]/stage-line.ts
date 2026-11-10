/** Нода сценария: у этапа разговора есть выходы, у конечной («Итог», «Срок вышел») — нет. */
interface FlowNode {
  exits: ReadonlyArray<unknown>;
}

/** Этап над перепиской нужен, только когда этапов разговора больше одного: единственный повторял бы название вкладки. */
export function showsStage(flow: { states: ReadonlyArray<FlowNode> }): boolean {
  return flow.states.filter((state) => state.exits.length > 0).length > 1;
}
