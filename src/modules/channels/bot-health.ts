import { eq, isNull } from "drizzle-orm";
import type { AlertService } from "../alerts";
import type { TokenCipher } from "../platform/crypto";
import type { Database } from "../platform/db";
import type { JobEnqueuer } from "../platform/queue";
import { toBotCredentials } from "./bots";
import { CHANNEL_LABELS, type BotCredentials, type ChannelAdapters, type ChannelKind, type ConnectionCheck } from "./channel";
import { requeueAfterBotRepair, type SendFailureCause } from "./outbound";
import { bots } from "./schema";

export interface BotHealthDependencies {
  db: Database;
  /** Сообщения, не ушедшие из-за бота, после его починки ставятся заново. */
  queue: JobEnqueuer;
  alerts: AlertService;
  adapters: ChannelAdapters;
  cipher: TokenCipher;
  /** Наш адрес вебхука для бота. Без него проверяется только жив ли бот, а не принадлежит ли ему приём сообщений. */
  webhookUrl?: (channel: ChannelKind, botId: string) => string;
}

/** Задача `bot-health` идёт раз в 10 минут. */
export const BOT_HEALTH_CRON = "*/10 * * * *";

type BotRow = typeof bots.$inferSelect;

/** Сколько проверок подряд должно упасть по временной причине (сеть, прокси), прежде чем бот считается сломанным: 3 × 10 минут. */
export const TEMPORARY_FAILURES_BEFORE_ERROR = 3;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Проверяет всех ботов. Токен отозван — сразу статус «ошибка» и тревога. Временный сбой (сеть, прокси) —
 * только если повторился несколько проверок подряд. Восстановление — «работает» и тревога снимается.
 */
export async function checkAllBots(deps: BotHealthDependencies): Promise<void> {
  const rows = await deps.db.select().from(bots).where(isNull(bots.deletedAt)).orderBy(bots.createdAt);
  for (const bot of rows) {
    try {
      await checkBot(deps, bot);
    } catch (error) {
      // Сбой с одним ботом (например, база) не должен лишать проверки остальных
      console.error(`Проверка бота ${bot.id} не выполнена:`, messageOf(error));
    }
  }
}

/**
 * Сообщение не ушло совсем. Если бот при этом не отвечает (токен отозван, бот удалён) —
 * это беда бота: статус «ошибка» и тревога, а сообщение дождётся починки (`bot`). Если бот жив —
 * беда только этого сообщения (например, человек удалил аккаунт), бота не трогаем.
 */
export async function reportSendFailure(deps: BotHealthDependencies, botId: string, _sendError: string): Promise<SendFailureCause> {
  const [bot] = await deps.db.select().from(bots).where(eq(bots.id, botId));
  if (!bot || bot.deletedAt) return "message";
  const check = await runConnectionCheck(deps, bot);
  if (!check || check.ok) return "message";
  await handleFailure(deps, bot, check);
  return check.kind === "invalid_token" ? "bot" : "message";
}

async function checkBot(deps: BotHealthDependencies, bot: BotRow): Promise<void> {
  const check = await runConnectionCheck(deps, bot);
  if (!check) return;
  if (!check.ok) {
    await handleFailure(deps, bot, check);
    return;
  }
  if (bot.status === "error" || bot.checkFailures > 0) {
    await deps.db.update(bots).set({ status: "ok", statusError: null, checkFailures: 0 }).where(eq(bots.id, bot.id));
  }
  if (bot.status === "error") await deps.alerts.resolve("bot_error", bot.id);
  // Бот в порядке — сообщения, не ушедшие из-за него, уходят заново. Проверяется каждый раз, а не только
  // на переходе из «ошибки»: сообщение могло получить пометку уже после того, как бота починили.
  await requeueAfterBotRepair(deps, bot.id);
}

/** `null` — для канала бота нет адаптера, проверять нечем. */
async function runConnectionCheck(deps: BotHealthDependencies, bot: BotRow): Promise<ConnectionCheck | null> {
  const adapter = deps.adapters[bot.channel];
  if (!adapter) return null;
  let credentials: BotCredentials;
  try {
    credentials = toBotCredentials(bot, deps.cipher);
  } catch (error) {
    // Токен в базе не расшифровывается (сменился ключ, запись повреждена) — само не пройдёт
    return { ok: false, kind: "invalid_token", error: messageOf(error) };
  }
  try {
    return await adapter.checkConnection(credentials, deps.webhookUrl?.(bot.channel, bot.id));
  } catch (error) {
    // Адаптер должен сам отличать виды сбоев; неожиданное исключение — считаем временным
    return { ok: false, kind: "temporary", error: messageOf(error) };
  }
}

async function handleFailure(
  deps: BotHealthDependencies,
  bot: BotRow,
  failure: Extract<ConnectionCheck, { ok: false }>,
): Promise<void> {
  // Токен отозван или приём сообщений занят другим сервисом: подождав, не починится
  if (failure.kind === "invalid_token" || failure.kind === "taken_over") {
    await markBroken(deps, bot, failure.error);
    return;
  }
  const failures = bot.checkFailures + 1;
  await deps.db.update(bots).set({ checkFailures: failures }).where(eq(bots.id, bot.id));
  // Бот, уже признанный сломанным, не затираем временным сбоем: причина и тревога остаются прежними
  if (bot.status !== "error" && failures >= TEMPORARY_FAILURES_BEFORE_ERROR) {
    await markBroken(deps, bot, failure.error);
  }
}

async function markBroken(deps: BotHealthDependencies, bot: BotRow, failure: string): Promise<void> {
  if (bot.status !== "error" || bot.statusError !== failure) {
    await deps.db.update(bots).set({ status: "error", statusError: failure }).where(eq(bots.id, bot.id));
  }
  // Тревога уходит один раз; если не ушла (Telegram тревог недоступен), следующая проверка попробует снова
  await deps.alerts.raise(
    "bot_error",
    `Бот «${bot.title}» (@${bot.username}, ${CHANNEL_LABELS[bot.channel]}) не работает: ${failure}`,
    bot.id,
  );
}
