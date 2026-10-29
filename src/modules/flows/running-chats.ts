// Перенос идущих чатов старой версии на сценарии SDK (срез S9, plan.md 3.3). Идущее прохождение без закрепления
// за сценарием → `flow.adopt` с его местом. `adopt` только закрепляет чат и ставит срок следующего касания: людям
// ничего не уходит, касания отправит работник в свой срок. Закреплённые чаты не трогает: повторный запуск ничего не меняет.
import type { AgentFlowHandle } from "@ykurilov/agent-chat-flows";
import { asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { passages } from "../conversations/schema";
import type { Database } from "../platform/db";
import { readPassagePlacement, type PassagePlacement } from "./passage-placement";
import { agentFlowOf, loadLeadMagnetFlow } from "./runtime";

/** `planned` — перенесу (режим «посмотреть»), `already` — чат уже за сценарием, `no_flow` — у снимка нет сценария. */
export type AdoptionOutcome = "planned" | "adopted" | "already" | "no_flow" | "failed";

export interface RunningChatAdoption {
  passageId: string;
  chatId: string;
  leadMagnetId: string;
  outcome: AdoptionOutcome;
  /** Нода, куда встаёт чат: id и название. */
  stateId?: string;
  stateTitle?: string;
  placement?: PassagePlacement;
  /** Срок следующего события сценария (касание, переход по дню, «срок вышел») после переноса. */
  dueAt?: Date | null;
  warnings: string[];
  error?: string;
}

export interface AdoptRunningChatsInput {
  db: Database;
  /** Пул той же базы: таблица закреплений SDK `agent_chat.flow_chats`. */
  pool: Pool;
  flow: Pick<AgentFlowHandle, "adopt">;
  now: Date;
  /** `false` — только посмотреть: что и куда будет перенесено, без записи. */
  apply: boolean;
}

const FLOW_CHATS = "agent_chat.flow_chats";

/** Чаты, уже закреплённые за сценарием. Таблицы ещё нет (сценарии не запускались) — никакие. */
export async function pinnedChats(pool: Pool, chatIds: string[]): Promise<Set<string>> {
  const { rows: exists } = await pool.query<{ found: boolean }>(`select to_regclass('${FLOW_CHATS}') is not null as found`);
  if (!exists[0]?.found || chatIds.length === 0) return new Set();
  const { rows } = await pool.query<{ chat_id: string }>(`select chat_id from ${FLOW_CHATS} where chat_id = any($1)`, [chatIds]);
  return new Set(rows.map((row) => row.chat_id));
}

async function dueAtOf(pool: Pool, chatId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ due_at: Date | null }>(`select due_at from ${FLOW_CHATS} where chat_id = $1`, [chatId]);
  return rows[0]?.due_at ?? null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function adoptRunningChats(input: AdoptRunningChatsInput): Promise<RunningChatAdoption[]> {
  const { db, pool, now, apply } = input;
  const running = await db.select().from(passages).where(eq(passages.status, "active")).orderBy(asc(passages.startedAt));
  const pinned = await pinnedChats(pool, running.map((passage) => passage.chatId));
  const report: RunningChatAdoption[] = [];

  for (const passage of running) {
    const base = { passageId: passage.id, chatId: passage.chatId, leadMagnetId: passage.leadMagnetId, warnings: [] as string[] };
    if (pinned.has(passage.chatId)) {
      report.push({ ...base, outcome: "already" });
      continue;
    }
    const loaded = await loadLeadMagnetFlow(db, passage.chatId);
    const flow = loaded && agentFlowOf(loaded.flow);
    if (!loaded || !flow) {
      report.push({ ...base, outcome: "no_flow", warnings: ["у снимка нет сценария: чат продолжится без сценария"] });
      continue;
    }
    const { placement, warnings } = await readPassagePlacement(db, passage, flow, now);
    // Сценарий без старта `adopt` отклонит — это попадёт в отчёт ошибкой
    const stateId = placement.stateId ?? flow.start ?? "";
    const planned: RunningChatAdoption = {
      ...base,
      outcome: "planned",
      stateId,
      stateTitle: flow.states.find((state) => state.id === stateId)?.title ?? stateId,
      placement,
      warnings,
    };
    if (!apply) {
      report.push(planned);
      continue;
    }
    try {
      const { adopted } = await input.flow.adopt({ ownerId: passage.personId, chatId: passage.chatId, ...loaded, ...placement });
      report.push({ ...planned, outcome: adopted ? "adopted" : "already", dueAt: await dueAtOf(pool, passage.chatId) });
    } catch (error) {
      report.push({ ...planned, outcome: "failed", error: errorText(error) });
    }
  }
  return report;
}

const OUTCOME_LABELS: Record<AdoptionOutcome, string> = {
  planned: "перенесу",
  adopted: "перенесён",
  already: "уже за сценарием",
  no_flow: "без сценария",
  failed: "ошибка",
};

/** Время для отчёта — по Москве, как в «Логе». */
const moscow = (at: Date) =>
  at.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function placementText(item: RunningChatAdoption): string {
  const place = item.placement;
  if (!place) return "";
  const parts = [
    `нода «${item.stateTitle}»`,
    `начало ${moscow(place.startedAt)}`,
    ...(place.enteredAt ? [`вход в ноду ${moscow(place.enteredAt)}`] : []),
    `человек ${place.lastHumanAt ? moscow(place.lastHumanAt) : "не писал"}`,
    `агент ${moscow(place.lastAgentAt)}`,
    `шаг касаний ${place.nudgeStep}`,
  ];
  const today = [
    ...(place.today.firstMessages ? [`первым ${place.today.firstMessages}`] : []),
    ...(place.today.humanMessages !== undefined ? [`сообщений человека ${place.today.humanMessages}`] : []),
    ...(place.today.dayClosed ? ["день закрыт"] : []),
  ];
  if (today.length) parts.push(`сегодня: ${today.join(", ")}`);
  if (place.timeZone) parts.push(`пояс ${place.timeZone}`);
  if (item.dueAt !== undefined) parts.push(`следующий срок ${item.dueAt ? moscow(item.dueAt) : "нет"}`);
  return parts.join("; ");
}

/** Отчёт скрипта: строка на прохождение и итог. Время — по Москве. */
export function formatAdoptionReport(report: RunningChatAdoption[], options: { apply: boolean }): string {
  const lines = report.map((item) => {
    const head = `[${OUTCOME_LABELS[item.outcome]}] прохождение ${item.passageId} (лидмагнит ${item.leadMagnetId}, чат ${item.chatId})`;
    const details = [placementText(item), ...item.warnings.map((warning) => `внимание: ${warning}`), ...(item.error ? [`ошибка: ${item.error}`] : [])];
    return [head, ...details.filter(Boolean).map((line) => `    ${line}`)].join("\n");
  });
  const counts = (outcome: AdoptionOutcome) => report.filter((item) => item.outcome === outcome).length;
  const summary = options.apply
    ? `Итог: идущих ${report.length}; перенесено ${counts("adopted")}, уже за сценарием ${counts("already")}, без сценария ${counts("no_flow")}, ошибок ${counts("failed")}.`
    : `Режим «посмотреть», ничего не записано. Идущих ${report.length}; перенесу ${counts("planned")}, уже за сценарием ${counts("already")}, без сценария ${counts("no_flow")}. Применить: --apply`;
  return [...lines, summary].join("\n");
}
