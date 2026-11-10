"use server";

import { requireUser } from "@/modules/access";
import { getEditorServices } from "@/modules/editor";
import type { RoleSwapStartResult, RoleSwapState, RoleSwapSubmitResult } from "@/modules/role-swap";

/** Старт разговора: чат или отказ со словами для экрана старта. */
export type RoleSwapStartOutcome = { chatId: string } | { error: "no_first_message" | "failed"; message: string };

export async function roleSwapState(leadMagnetId: string): Promise<RoleSwapState | null> {
  await requireUser();
  return (await getEditorServices()).roleSwap.current(leadMagnetId);
}

export async function startRoleSwap(leadMagnetId: string, brief: string | null): Promise<RoleSwapStartOutcome> {
  await requireUser();
  return startedOrRefused(leadMagnetId, async () => (await getEditorServices()).roleSwap.start(leadMagnetId, brief));
}

/** «Начать заново»: прежний разговор заменяется новым клиентом. */
export async function restartRoleSwap(leadMagnetId: string, brief: string | null): Promise<RoleSwapStartOutcome> {
  await requireUser();
  return startedOrRefused(leadMagnetId, async () => (await getEditorServices()).roleSwap.restart(leadMagnetId, brief));
}

type RoleSwapSubmitError = Extract<RoleSwapSubmitResult, { ok: false }>["error"];

/** «Закончить и разобрать»: сколько ответов встало в очередь или отказ со словами для эксперта. */
export type RoleSwapSubmitOutcome = Extract<RoleSwapSubmitResult, { ok: true }> | { ok: false; error: RoleSwapSubmitError; message: string };

const SUBMIT_REFUSALS: Record<RoleSwapSubmitError, string> = {
  busy: "Дождитесь ответа клиента и нажмите ещё раз.",
  preparing: "Разбор уже готовится.",
  failed: "Не получилось подготовить разбор. Попробуйте ещё раз.",
  no_conversation: "Разговора нет. Начните его заново.",
};

export async function submitRoleSwap(leadMagnetId: string): Promise<RoleSwapSubmitOutcome> {
  await requireUser();
  let result: RoleSwapSubmitResult;
  try {
    result = await (await getEditorServices()).roleSwap.submit(leadMagnetId);
  } catch (error) {
    console.error(`«Закончить и разобрать» для ${leadMagnetId} не удалось:`, error instanceof Error ? error.message : error);
    result = { ok: false, error: "failed" };
  }
  return result.ok ? result : { ...result, message: SUBMIT_REFUSALS[result.error] };
}

async function startedOrRefused(leadMagnetId: string, start: () => Promise<RoleSwapStartResult>): Promise<RoleSwapStartOutcome> {
  try {
    const result = await start();
    if ("chatId" in result) return result;
    return { error: "no_first_message", message: "Сначала напишите первое сообщение в «Настройках»." };
  } catch (error) {
    // Текст брошенной ошибки до браузера не доходит: отказ отдаётся ответом
    console.error(`«Поменяемся ролями» для ${leadMagnetId} не начался:`, error instanceof Error ? error.message : error);
    return { error: "failed", message: "Не получилось придумать клиента. Попробуйте ещё раз." };
  }
}
