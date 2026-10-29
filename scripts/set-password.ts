// Задать или сменить пароль для входа в кабинет (AUTH_MODE=password).
// В Docker: `docker compose exec web node dist/set-password.js <почта>` — пароль спросит дважды, не показывая на экране.
// Без экрана (скрипты): пароль первой строкой стандартного ввода.
// Почта должна быть в ALLOWED_EMAILS. В базе остаётся только хеш пароля.
import { parseAllowedEmails } from "@/modules/access/access";
import { AccountInputError, setPassword } from "@/modules/accounts";
import { connectDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";

const UNDEFINED_TABLE = "42P01";

function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (result: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      result();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003") return finish(() => reject(new AccountInputError("Отменено.")));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  const password = await askHidden("Новый пароль: ");
  if ((await askHidden("Ещё раз: ")) !== password) throw new AccountInputError("Пароли не совпали. Запустите команду ещё раз.");
  return password;
}

const email = process.argv[2];
if (!email) {
  console.error("Запуск: node dist/set-password.js <почта>");
  process.exit(2);
}

const connection = connectDatabase(requireEnv("DATABASE_URL"), { poolSize: 1 });
try {
  const password = await readPassword();
  const result = await setPassword(connection.db, {
    email,
    password,
    allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS),
  });
  const address = process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/login` : "/login";
  console.log(`${result.created ? "Учётная запись создана" : "Пароль изменён"}: ${result.email}. Вход: ${address}`);
} catch (error) {
  if (error instanceof AccountInputError) console.error(error.message);
  else if ((error as { code?: string; cause?: { code?: string } }).code === UNDEFINED_TABLE || (error as { cause?: { code?: string } }).cause?.code === UNDEFINED_TABLE)
    console.error("База ещё не готова: подождите, пока приложение запустится (docker compose ps), и повторите команду.");
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
