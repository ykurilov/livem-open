import { cookies } from "next/headers";
import { getDatabase } from "../platform/db";
import { systemClock } from "../platform/clock";
import { createTokenCipher } from "../platform/crypto";
import { requireEnv } from "../platform/env";
import { getWebQueue } from "../platform/queue";
export { clientAddress } from "./address";
import { findWebChatVisitor, type WebChatDependencies, type WebChatVisitor } from "./web-chat";

import { WEB_CHAT_COOKIE } from "./cookie";
export { WEB_CHAT_COOKIE };
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export async function webChatDependencies(): Promise<WebChatDependencies> {
  return { db: getDatabase().db, queue: await getWebQueue(), clock: systemClock, cipher: createTokenCipher(requireEnv("BOT_TOKEN_KEY")) };
}

export async function readVisitorToken(): Promise<string | null> {
  return (await cookies()).get(WEB_CHAT_COOKIE)?.value ?? null;
}

/** Посетитель по cookie запроса; нет или чужой токен — `null`. */
export async function currentVisitor(): Promise<WebChatVisitor | null> {
  return findWebChatVisitor(getDatabase().db, await readVisitorToken());
}

export async function rememberVisitorToken(token: string): Promise<void> {
  (await cookies()).set(WEB_CHAT_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
