"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/access";
import { NO_CODE_MODES, createBotServiceFromEnv, type ChannelKind, type NoCodeMode } from "@/modules/channels";

export interface ConnectBotState {
  error?: string;
  /** Бот занят другим сервисом: вопрос эксперту «подключить всё равно?». Не ошибка — ждёт решения. */
  conflict?: string;
  /** Что подключили, для сообщения об успехе. Токен сюда не попадает никогда. */
  connected?: string;
}

const CHANNELS: ChannelKind[] = ["telegram", "vk", "max"];

export async function connectBotAction(_previous: ConnectBotState, formData: FormData): Promise<ConnectBotState> {
  await requireUser();

  const channel = formData.get("channel");
  const token = formData.get("token");
  if (typeof channel !== "string" || !CHANNELS.includes(channel as ChannelKind)) return { error: "Выберите мессенджер" };
  if (typeof token !== "string") return { error: "Вставьте токен бота" };

  const result = await createBotServiceFromEnv().connectBot({ channel: channel as ChannelKind, token, force: formData.get("force") === "1" });
  if (!result.ok) return result.needsConfirmation ? { conflict: result.error } : { error: result.error };

  revalidatePath("/bots");
  return { connected: `${result.bot.title} (@${result.bot.username})` };
}

export interface BotSettingsState {
  error?: string;
  saved?: boolean;
}

/** Поведение бота без кода: «ничего», лидмагнит по умолчанию или меню. */
export async function saveNoCodeAction(botId: string, _previous: BotSettingsState, formData: FormData): Promise<BotSettingsState> {
  await requireUser();
  const mode = formData.get("mode");
  const defaultLeadMagnetId = formData.get("defaultLeadMagnetId");
  if (typeof mode !== "string" || !NO_CODE_MODES.includes(mode as NoCodeMode)) return { error: "Выберите, что делать без кода" };
  const result = await createBotServiceFromEnv().updateNoCodeSettings(botId, {
    mode: mode as NoCodeMode,
    defaultLeadMagnetId: typeof defaultLeadMagnetId === "string" && defaultLeadMagnetId ? defaultLeadMagnetId : null,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/bots/${botId}`);
  return { saved: true };
}

/** Удаляет бота; с опубликованными лидмагнитами — отказ с объяснением. */
export async function deleteBotAction(botId: string, _previous: BotSettingsState): Promise<BotSettingsState> {
  await requireUser();
  const result = await createBotServiceFromEnv().deleteBot(botId);
  if (!result.ok) return { error: result.error };
  revalidatePath("/bots");
  redirect("/bots");
}
