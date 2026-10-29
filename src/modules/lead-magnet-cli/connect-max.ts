// `connect-max`: подключить бота Max токеном со стандартного ввода — тем же путём, что форма «Боты» в кабинете.
// Токен не попадает ни в аргументы, ни в вывод, ни в тексты ошибок.
import type { BotService } from "../channels/bots";
import { CliInputError } from "./agent-settings";

export async function connectMax(botService: Pick<BotService, "connectBot">, stdin: string) {
  const token = stdin.trim();
  if (!token) throw new CliInputError("Передайте токен бота через стандартный ввод: … | lm.sh connect-max");
  const result = await botService.connectBot({ channel: "max", token });
  if (!result.ok) throw new CliInputError(result.error.replaceAll(token, "***"));
  return { botId: result.bot.id, title: result.bot.title, username: result.bot.username };
}
