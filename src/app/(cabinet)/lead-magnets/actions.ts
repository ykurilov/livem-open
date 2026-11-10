"use server";

import { redirect } from "next/navigation";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { requireUser } from "@/modules/access";
import { rollbackByExpert, saveExpertEdit, saveExpertFlowEdit } from "@/modules/constructor";
import { getEditorServices } from "@/modules/editor";
import { withLeadMagnetFlow } from "@/modules/flows/flow-settings";
import {
  createLeadMagnet,
  InvalidLeadMagnetSettingsError,
  LeadMagnetNotFoundError,
  type LeadMagnetSettings,
} from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { describeInvalidModelChoice } from "@/modules/platform/model-choice";
import { isUuid } from "@/modules/platform/uuid";
import { PreviewReopenRefused } from "@/modules/consultant/preview-endpoint";
import { PreviewRefusal } from "@/modules/consultant/preview-flow-test";

export type ActionResult = { ok: true } | { ok: false; error: string };
/** Ошибка сохранения сценария: общий текст и замечания с путём в сценарии (для подсказок на доске). */
export type FlowEditFailure = { ok: false; error: string; issues: Array<{ path: string; message: string }> };
export type FlowEditResult = Extract<DraftEditResult, { ok: true }> | FlowEditFailure;
/** Ручная правка или откат. `overwroteNewerDraft` — черновик успел измениться, правка легла поверх. */
/** `versionId` — новая версия черновика: форма её версии знает, что сохранена именно она. */
export type DraftEditResult = { ok: true; overwroteNewerDraft: boolean; versionId: string } | { ok: false; error: string };

/** Ошибки, о которых эксперту можно сказать словами; остальное — сбой сервера. */
function expectedFailure(error: unknown): { ok: false; error: string } {
  if (error instanceof InvalidLeadMagnetSettingsError || error instanceof LeadMagnetNotFoundError)
    return { ok: false, error: error.message };
  throw error;
}

export async function createLeadMagnetAction(formData: FormData): Promise<void> {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim() || "Новый лидмагнит";
  const cardDescription = String(formData.get("cardDescription") ?? "").trim();
  const requestId = formData.get("requestId");
  const id = typeof requestId === "string" && isUuid(requestId) ? requestId : undefined;
  const lead = await createLeadMagnet(getDatabase().db, { id, name, cardDescription });
  redirect(`/lead-magnets/${lead.id}`);
}

export async function saveSettingsAction(
  leadMagnetId: string,
  settings: LeadMagnetSettings,
  expectedVersionId: string,
): Promise<DraftEditResult> {
  await requireUser();
  const invalidModel = describeInvalidModelChoice((await getEditorServices()).catalog, settings);
  if (invalidModel) return { ok: false, error: invalidModel };
  try {
    const { overwroteNewerDraft, version } = await saveExpertEdit(getDatabase().db, leadMagnetId, { settings, expectedVersionId });
    return { ok: true, overwroteNewerDraft, versionId: version.id };
  } catch (error) {
    return expectedFailure(error);
  }
}

/**
 * Сохранение сценария с доски. Сценарий кладётся в самый свежий черновик под блокировкой, остальные настройки не
 * трогаются: конструктор или «Настройки» могли обновить их, пока доска была открыта. Проверка та же, что у любого сохранения.
 */
export async function saveFlowAction(
  leadMagnetId: string,
  flow: AgentFlow,
  expectedVersionId: string,
): Promise<FlowEditResult> {
  await requireUser();
  try {
    const { overwroteNewerDraft, version } = await saveExpertFlowEdit(getDatabase().db, leadMagnetId, { flow, expectedVersionId });
    return { ok: true, overwroteNewerDraft, versionId: version.id };
  } catch (error) {
    const failure = expectedFailure(error);
    return { ...failure, issues: error instanceof InvalidLeadMagnetSettingsError ? error.issues : [] };
  }
}

/**
 * Обе несохранённые правки одним сохранением: настройки из формы и сценарий с доски. Сохранение одной вкладки не ждёт
 * другую и не теряет её правку. Замечания с путём — для подсказок на доске.
 */
export async function saveSettingsAndFlowAction(
  leadMagnetId: string,
  settings: LeadMagnetSettings,
  flow: AgentFlow,
  expectedVersionId: string,
): Promise<FlowEditResult> {
  await requireUser();
  const combined = withLeadMagnetFlow(settings, flow);
  const invalidModel = describeInvalidModelChoice((await getEditorServices()).catalog, combined);
  if (invalidModel) return { ok: false, error: invalidModel, issues: [] };
  try {
    const { overwroteNewerDraft, version } = await saveExpertEdit(getDatabase().db, leadMagnetId, { settings: combined, expectedVersionId });
    return { ok: true, overwroteNewerDraft, versionId: version.id };
  } catch (error) {
    const failure = expectedFailure(error);
    return { ...failure, issues: error instanceof InvalidLeadMagnetSettingsError ? error.issues : [] };
  }
}

export async function rollbackAction(leadMagnetId: string, versionId: string, expectedVersionId: string): Promise<DraftEditResult> {
  await requireUser();
  try {
    const { overwroteNewerDraft, version } = await rollbackByExpert(getDatabase().db, leadMagnetId, { versionId, expectedVersionId });
    return { ok: true, overwroteNewerDraft, versionId: version.id };
  } catch (error) {
    return expectedFailure(error);
  }
}

/** Промотка «Проверки»: отказ (последний день, разговор завершён, впереди ничего нет) — `error` со словами, часы не двигались. */
type PreviewClockResult = { error?: string };

async function shiftPreviewClock(shift: () => Promise<unknown>): Promise<PreviewClockResult> {
  await requireUser();
  try {
    await shift();
  } catch (error) {
    // Текст брошенной ошибки до браузера не доходит: отказ отдаётся ответом
    if (error instanceof PreviewRefusal) return { error: error.message };
    throw error;
  }
  return {};
}

export async function nextPreviewDayAction(leadMagnetId: string, timeZone?: string): Promise<PreviewClockResult> {
  return shiftPreviewClock(async () => (await getEditorServices()).preview.nextDay(leadMagnetId, timeZone));
}

export async function advancePreviewAction(leadMagnetId: string, ms: number, timeZone?: string): Promise<PreviewClockResult> {
  return shiftPreviewClock(async () => (await getEditorServices()).preview.advanceBy(leadMagnetId, ms, timeZone));
}

/** К ближайшему сообщению сценария первым. */
export async function advancePreviewToReminderAction(leadMagnetId: string, timeZone?: string): Promise<PreviewClockResult> {
  return shiftPreviewClock(async () => (await getEditorServices()).preview.advanceToNextFirstMessage(leadMagnetId, timeZone));
}

/** «Продолжить разговор»; сценарий не открывается (вышел срок программы) — `error` со словами, что делать. */
export async function reopenPreviewAction(leadMagnetId: string): Promise<{ error?: string }> {
  await requireUser();
  try {
    await (await getEditorServices()).preview.reopenPreview(leadMagnetId);
  } catch (error) {
    if (error instanceof PreviewReopenRefused) return { error: error.message };
    throw error;
  }
  return {};
}

/** «Автоответ»: реплика клиента, которую тестовый разговор сразу отправляет. */
export async function suggestPreviewReplyAction(chatId: string): Promise<{ text: string } | { error: string }> {
  await requireUser();
  try {
    return { text: await (await getEditorServices()).preview.suggestReply(chatId) };
  } catch (error) {
    console.error(`Автоответ для ${chatId} не получился:`, error instanceof Error ? error.message : error);
    return { error: "Не получилось придумать ответ. Попробуйте ещё раз." };
  }
}

export async function restartPreviewAction(leadMagnetId: string): Promise<string> {
  await requireUser();
  return (await getEditorServices()).preview.restartPreview(leadMagnetId);
}
