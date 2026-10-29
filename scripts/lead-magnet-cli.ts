// Консольная команда для агента: собрать и править лидмагниты от имени эксперта без конструктора.
// В образе: `node dist/lead-magnet-cli.js <команда> [аргументы] < настройки.json`; снаружи — docker compose exec web node dist/lead-magnet-cli.js.
// Вывод — JSON в stdout; ошибка — текстом в stderr и код выхода 1. Справка — без аргументов.
import { parseAllowedEmails } from "@/modules/access/access";
import { createAlertsFromEnv } from "@/modules/alerts";
import { createChannelAdapters } from "@/modules/channels/adapters";
import { createBotService } from "@/modules/channels/bots";
import { createVkAdapter } from "@/modules/channels/vk/adapter";
import { runLeadMagnetCli, USAGE } from "@/modules/lead-magnet-cli/run";
import { createTokenCipher } from "@/modules/platform/crypto";
import { connectDatabase } from "@/modules/platform/db";
import { optionalEnv, requireEnv } from "@/modules/platform/env";
import { createQueue, type AppQueue } from "@/modules/platform/queue";
import { createAppCatalog } from "@/modules/platform/models-catalog";

// connect-vk и connect-max читают со стандартного ввода ключ сообщества и токен бота: так он не виден в аргументах и истории команд
const COMMANDS_WITH_INPUT = new Set(["create", "update", "connect-vk", "connect-max"]);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(USAGE);
  process.exit(0);
}

const connection = connectDatabase(requireEnv("DATABASE_URL"), { poolSize: 2 });
// Очередь нужна, только если подключение чинит сломанного бота (его неотправленные сообщения ставятся снова)
let queue: AppQueue | undefined;
const startedQueue = async () => {
  if (!queue) {
    queue = createQueue({ connectionString: requireEnv("DATABASE_URL"), role: "web" });
    await queue.start();
  }
  return queue;
};
try {
  const stdin = COMMANDS_WITH_INPUT.has(args[0]!) ? await readStdin() : "";
  const result = await runLeadMagnetCli(args, stdin, {
    db: connection.db,
    catalog: createAppCatalog(),
    adapters: createChannelAdapters(),
    allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
    vkConnection: () => {
      const vk = createVkAdapter();
      const cipher = createTokenCipher(requireEnv("BOT_TOKEN_KEY"));
      const publicBaseUrl = optionalEnv("PUBLIC_BASE_URL") ?? "";
      return {
        vk,
        cipher,
        publicBaseUrl,
        botService: createBotService({
          db: connection.db,
          adapters: { ...createChannelAdapters(), vk },
          cipher,
          alerts: createAlertsFromEnv(connection.db),
          queue: { enqueue: async (name, payload, options) => (await startedQueue()).enqueue(name, payload, options) },
          publicBaseUrl,
        }),
      };
    },
  });
  (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.output}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`Сбой: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await queue?.stop();
  await connection.close();
}
