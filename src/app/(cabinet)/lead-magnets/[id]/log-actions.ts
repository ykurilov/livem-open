"use server";

import { requireUser } from "@/modules/access";
import { listAgentLog, type AgentLogPage } from "@/modules/agent-log";
import { logModelNames } from "@/modules/agent-log/model-names";
import { getEditorServices } from "@/modules/editor";
import { getDatabase } from "@/modules/platform/db";

/** Ходов в одной порции вкладки «Лог». */
const LOG_PAGE_SIZE = 20;

export interface AgentLogView extends AgentLogPage {
  /** Имена моделей из «Настроек» по ключу `modelNameKey`: журнал хранит служебный id модели. */
  modelNames: Record<string, string>;
}

/** Порция журнала агентов лидмагнита: новые ходы сверху; `before` — курсор следующей порции. */
export async function loadAgentLogAction(leadMagnetId: string, before?: string): Promise<AgentLogView> {
  await requireUser();
  const page = await listAgentLog(getDatabase().db, leadMagnetId, { limit: LOG_PAGE_SIZE, ...(before ? { before } : {}) });
  return { ...page, modelNames: logModelNames((await getEditorServices()).catalog, page.turns) };
}
