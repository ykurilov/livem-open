import type { FlowFirstReason, FlowRunView, FlowTransitionEvent, LoadedFlow } from "@ykurilov/agent-chat-flows";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { recordFlowLogEvent } from "../agent-log/flow-events";
import type { FirstMessageReason } from "../agent-log/types";
import type { Database } from "../platform/db";

/** Сценарий чата: из него берутся названия нод, чтобы «Лог» писал «Знакомство → Доработка», а не `idea → polish`. */
export type LoadChatFlow = (chatId: string) => Promise<LoadedFlow | null>;

export interface FlowLog {
  /** Переход сценария: откуда, куда, кто решил, почему, какой день. */
  transition(event: FlowTransitionEvent): Promise<void>;
  /** Бот пишет первым: причины одного срока. Дня тут нет: место чата в сценарии на первом шаге хода ещё прежнее. */
  firstMessage(input: { chatId: string; reasons: readonly FlowFirstReason[] }): Promise<void>;
}

/** Переходы и причины «бот написал первым» — строками «Лога» лидмагнита (plan.md, раздел 2.5). */
export function createFlowLog(db: Database, loadFlow: LoadChatFlow): FlowLog {
  const titleResolver = async (chatId: string) => {
    const loaded = await loadFlow(chatId);
    return (stateId: string) => (loaded?.flow as AgentFlow | undefined)?.states.find((state) => state.id === stateId)?.title ?? stateId;
  };
  const dayFields = (day: FlowRunView["day"]) => (day ? { day: Math.max(1, day.day), ...(day.totalDays !== undefined && { totalDays: day.totalDays }) } : {});

  return {
    async transition(event) {
      const titleOf = await titleResolver(event.chatId);
      await recordFlowLogEvent(db, event.chatId, {
        kind: "transition",
        at: new Date(event.at).toISOString(),
        durationMs: 0,
        from: titleOf(event.from),
        to: titleOf(event.to),
        decidedBy: event.decidedBy,
        reason: event.reason?.text ?? null,
        ...(event.probability !== undefined && { probability: event.probability }),
        ...dayFields(event.day),
        ...(event.returned && { returned: true }),
      });
    },

    async firstMessage({ chatId, reasons }) {
      if (reasons.length === 0) return;
      const titleOf = await titleResolver(chatId);
      const logged: FirstMessageReason[] = reasons.map((reason) =>
        reason.kind === "transition" ? { kind: "transition", stateTitle: titleOf(reason.stateId) } : reason,
      );
      await recordFlowLogEvent(db, chatId, { kind: "first-message", at: new Date().toISOString(), durationMs: 0, reasons: logged });
    },
  };
}
