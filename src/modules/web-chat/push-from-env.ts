import { eq } from "drizzle-orm";
import webPush from "web-push";
import type { Clock } from "../platform/clock";
import type { DatabaseExecutor } from "../platform/db";
import { optionalEnv } from "../platform/env";
import { createWebPushSender } from "./push";
import { webChatVisitors } from "./schema";
import { forgetWebChatSubscription, webChatTitle } from "./web-chat";

/** Сколько служба уведомлений хранит неотправленное уведомление, пока телефон не в сети. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Сколько ждать ответа службы уведомлений: дольше — сбой, задача повторится. */
const PUSH_TIMEOUT_MS = 10_000;

/** Открытый ключ VAPID для подписки в браузере; ключей нет — уведомления выключены. */
export function webPushPublicKey(env: Record<string, string | undefined> = process.env): string | null {
  return optionalEnv("WEB_PUSH_PUBLIC_KEY", env) && optionalEnv("WEB_PUSH_PRIVATE_KEY", env) ? optionalEnv("WEB_PUSH_PUBLIC_KEY", env)! : null;
}

/** Отправка уведомлений веб-чата с ключами VAPID из окружения. Ключей нет — `undefined`: чат работает без уведомлений. */
export function createWebPushSenderFromEnv(
  db: DatabaseExecutor,
  clock: Clock,
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof createWebPushSender> | undefined {
  const publicKey = webPushPublicKey(env);
  const privateKey = optionalEnv("WEB_PUSH_PRIVATE_KEY", env);
  if (!publicKey || !privateKey) return undefined;
  const vapidDetails = { subject: optionalEnv("WEB_PUSH_SUBJECT", env) ?? "mailto:admin@example.com", publicKey, privateKey };
  return createWebPushSender({
    clock,
    async findVisitor(id) {
      const [visitor] = await db.select().from(webChatVisitors).where(eq(webChatVisitors.id, id));
      if (!visitor) return null;
      const title = visitor.lastCode ? await webChatTitle(db, visitor.lastCode, visitor) : null;
      return { ...visitor, title: title ?? "Новое сообщение" };
    },
    clearSubscription: (id, endpoint) => forgetWebChatSubscription(db, id, endpoint),
    async send(subscription, payload) {
      await webPush.sendNotification(subscription, payload, { vapidDetails, TTL: PUSH_TTL_SECONDS, timeout: PUSH_TIMEOUT_MS });
    },
  });
}
