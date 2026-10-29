"use server";

import { redirect } from "next/navigation";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { requireUser } from "@/modules/access";
import { rollbackByExpert, saveExpertCardDescription, saveExpertEdit, saveExpertFlowEdit } from "@/modules/constructor";
import { getEditorServices } from "@/modules/editor";
import {
  createLeadMagnet,
  InvalidLeadMagnetSettingsError,
  LeadMagnetNotFoundError,
  type LeadMagnetSettings,
} from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { describeInvalidModelChoice } from "@/modules/platform/model-choice";

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
  const lead = await createLeadMagnet(getDatabase().db, { name, cardDescription });
  redirect(`/lead-magnets/${lead.id}`);
}

/** Описание карточки с главной страницы: только оно, поверх самого свежего черновика. */
export async function saveCardDescriptionAction(leadMagnetId: string, cardDescription: string): Promise<ActionResult> {
  await requireUser();
  try {
    await saveExpertCardDescription(getDatabase().db, leadMagnetId, cardDescription);
    return { ok: true };
  } catch (error) {
    return expectedFailure(error);
  }
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

export async function rollbackAction(leadMagnetId: string, versionId: string, expectedVersionId: string): Promise<DraftEditResult> {
  await requireUser();
  try {
    const { overwroteNewerDraft, version } = await rollbackByExpert(getDatabase().db, leadMagnetId, { versionId, expectedVersionId });
    return { ok: true, overwroteNewerDraft, versionId: version.id };
  } catch (error) {
    return expectedFailure(error);
  }
}

export async function nextPreviewDayAction(leadMagnetId: string, timeZone?: string): Promise<void> {
  await requireUser();
  await (await getEditorServices()).preview.nextDay(leadMagnetId, timeZone);
}

export async function advancePreviewAction(leadMagnetId: string, ms: number, timeZone?: string): Promise<void> {
  await requireUser();
  await (await getEditorServices()).preview.advanceBy(leadMagnetId, ms, timeZone);
}

/** К ближайшему сообщению сценария первым; `nothingScheduled` — впереди его нет, часы не двигались. */
export async function advancePreviewToReminderAction(leadMagnetId: string, timeZone?: string): Promise<{ nothingScheduled: boolean }> {
  await requireUser();
  try {
    await (await getEditorServices()).preview.advanceToNextFirstMessage(leadMagnetId, timeZone);
    return { nothingScheduled: false };
  } catch (error) {
    if ((error as { code?: unknown }).code === "nothing_scheduled") return { nothingScheduled: true };
    throw error;
  }
}

export async function restartPreviewAction(leadMagnetId: string): Promise<string> {
  await requireUser();
  return (await getEditorServices()).preview.restartPreview(leadMagnetId);
}
