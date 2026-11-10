import { CHANNEL_LABELS, type BotSummary, type ChannelKind } from "@/modules/channels";
import type { ChannelChoice } from "./publish-form";

// Мессенджеры, в которых можно опубликовать лидмагнит
const AVAILABLE_CHANNELS: ChannelKind[] = ["telegram", "vk", "max"];

/** Что сломано у бота по последней проверке; бот работает — `null`. */
export const botProblem = (bot: Pick<BotSummary, "status" | "statusError">): string | null =>
  bot.status === "ok" ? null : (bot.statusError ?? "Бот не отвечает на проверку");

/**
 * Выбор ботов для формы публикации: все подключённые боты по мессенджерам и выбранный у лидмагнита в каждом.
 * Сломанные помечены в списке, а что с ними — в `brokenBots`: форма предупреждает, прежде чем публиковать на такой.
 */
export function channelChoices(bots: BotSummary[], attached: Array<{ channel: ChannelKind; botId: string }>): ChannelChoice[] {
  return AVAILABLE_CHANNELS.map((channel) => {
    const channelBots = bots.filter((bot) => bot.channel === channel);
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      bots: channelBots.map((bot) => ({ value: bot.id, label: `${bot.title} (@${bot.username})${botProblem(bot) ? " — не работает" : ""}` })),
      brokenBots: Object.fromEntries(channelBots.flatMap((bot) => (botProblem(bot) ? [[bot.id, botProblem(bot)!]] : []))),
      selected: attached.find((bot) => bot.channel === channel)?.botId ?? null,
    };
  });
}
