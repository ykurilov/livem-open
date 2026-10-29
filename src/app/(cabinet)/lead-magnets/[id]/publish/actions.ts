"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/access";
import type { ChannelKind } from "@/modules/channels";
import { ChatMigrationError, migrateLiveChats, type StateMap } from "@/modules/flows";
import {
  archiveEntryLink,
  createLabeledLink,
  deleteEntryLink,
  EntryLinkError,
  InvalidLeadMagnetSettingsError,
  LeadMagnetNotFoundError,
  PublishError,
  publishWithBots,
  unpublishLeadMagnet,
} from "@/modules/lead-magnets";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { getWebQueue } from "@/modules/platform/queue";
import { NO_BOT } from "./no-bot";

export interface PublishState {
  error?: string;
  published?: boolean;
}

const CHANNELS: ChannelKind[] = ["telegram", "vk", "max"];
const LEAD_MAGNET_GONE = "Лидмагнит не найден: возможно, его удалили";

/** Сохраняет выбор ботов по мессенджерам и публикует черновик той версии, что была на странице. */
export async function publishAction(leadMagnetId: string, _previous: PublishState, formData: FormData): Promise<PublishState> {
  await requireUser();
  const { db } = getDatabase();
  const expectedDraftVersionId = formData.get("draftVersionId");
  if (typeof expectedDraftVersionId !== "string" || !expectedDraftVersionId) return { error: "Форма устарела — обновите страницу" };
  const choices: Partial<Record<ChannelKind, string | null>> = {};
  for (const channel of CHANNELS) {
    const botId = formData.get(`bot-${channel}`);
    if (typeof botId === "string") choices[channel] = botId === NO_BOT ? null : botId;
  }
  try {
    await publishWithBots(db, leadMagnetId, choices, { expectedDraftVersionId });
  } catch (error) {
    if (error instanceof PublishError || error instanceof LeadMagnetNotFoundError || error instanceof InvalidLeadMagnetSettingsError)
      return { error: error.message };
    throw error;
  }
  revalidatePath(`/lead-magnets/${leadMagnetId}/publish`);
  revalidatePath("/");
  return { published: true };
}

export interface UnpublishState {
  error?: string;
}

/** Снимает лидмагнит с публикации: ссылки перестают его запускать, начатые разговоры доигрывают. */
export async function unpublishAction(leadMagnetId: string, _previous: UnpublishState): Promise<UnpublishState> {
  await requireUser();
  try {
    await unpublishLeadMagnet(getDatabase().db, leadMagnetId);
  } catch (error) {
    if (error instanceof LeadMagnetNotFoundError) return { error: LEAD_MAGNET_GONE };
    throw error;
  }
  revalidatePath(`/lead-magnets/${leadMagnetId}/publish`);
  revalidatePath("/");
  return {};
}

export interface LinkActionState {
  error?: string;
  created?: string;
}

/** «Новая ссылка» с меткой. */
export async function createLinkAction(leadMagnetId: string, _previous: LinkActionState, formData: FormData): Promise<LinkActionState> {
  await requireUser();
  const label = formData.get("label");
  if (typeof label !== "string") return { error: "Впишите метку" };
  try {
    const link = await createLabeledLink(getDatabase().db, { leadMagnetId, label });
    revalidatePath(`/lead-magnets/${leadMagnetId}/publish`);
    return { created: link.label ?? "" };
  } catch (error) {
    if (error instanceof EntryLinkError) return { error: error.message };
    if (error instanceof LeadMagnetNotFoundError) return { error: LEAD_MAGNET_GONE };
    throw error;
  }
}

/** Удаляет метку без людей или, если по ней приходили люди, отправляет её в архив. */
export async function removeLinkAction(
  leadMagnetId: string,
  linkId: string,
  how: "delete" | "archive",
): Promise<LinkActionState> {
  await requireUser();
  const { db } = getDatabase();
  try {
    if (how === "archive") await archiveEntryLink(db, linkId);
    else await deleteEntryLink(db, linkId);
  } catch (error) {
    if (error instanceof EntryLinkError) return { error: error.message };
    if (error instanceof LeadMagnetNotFoundError) return { error: LEAD_MAGNET_GONE };
    throw error;
  }
  revalidatePath(`/lead-magnets/${leadMagnetId}/publish`);
  return {};
}

export interface MigrateChatsState {
  error?: string;
  moved?: number;
}

const isStateMap = (value: unknown): value is StateMap =>
  typeof value === "object" && value !== null && Object.values(value).every((to) => typeof to === "string");

/**
 * «Перевести на новую версию»: идущие разговоры прежних версий продолжат по опубликованной. Наши данные и «Лог» —
 * сразу, сценарий SDK переводит чаты задачей работника после коммита.
 */
export async function migrateChatsAction(leadMagnetId: string, map: StateMap): Promise<MigrateChatsState> {
  const user = await requireUser();
  if (!isStateMap(map)) return { error: "Форма устарела — обновите страницу" };
  try {
    const result = await migrateLiveChats(getDatabase().db, {
      leadMagnetId,
      map,
      by: { email: user.email, ...(user.name && { name: user.name }) },
      at: systemClock.now(),
    });
    if (result.chats > 0 || result.pending > 0)
      await (await getWebQueue()).enqueue("chats-migrate", { leadMagnetId, toVersionId: result.toVersionId });
    revalidatePath(`/lead-magnets/${leadMagnetId}/publish`);
    return { moved: result.chats };
  } catch (error) {
    if (error instanceof ChatMigrationError) return { error: error.message };
    if (error instanceof LeadMagnetNotFoundError) return { error: LEAD_MAGNET_GONE };
    throw error;
  }
}
