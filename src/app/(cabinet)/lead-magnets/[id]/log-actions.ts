"use server";

import { requireUser } from "@/modules/access";
import { listAgentLog, type AgentLogPage } from "@/modules/agent-log";
import { getDatabase } from "@/modules/platform/db";

/** Ходов в одной порции вкладки «Лог». */
const LOG_PAGE_SIZE = 20;

/** Порция журнала агентов лидмагнита: новые ходы сверху; `before` — курсор следующей порции. */
export async function loadAgentLogAction(leadMagnetId: string, before?: string): Promise<AgentLogPage> {
  await requireUser();
  return listAgentLog(getDatabase().db, leadMagnetId, { limit: LOG_PAGE_SIZE, ...(before ? { before } : {}) });
}
