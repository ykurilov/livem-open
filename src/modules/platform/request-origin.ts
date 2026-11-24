import { headers } from "next/headers";
import { optionalEnv } from "./env";

/** Адрес приложения для кода и примеров, что эксперт уносит к себе: `PUBLIC_BASE_URL`, без него (разработка) — адрес запроса. */
export async function currentAppOrigin(): Promise<string> {
  const base = optionalEnv("PUBLIC_BASE_URL");
  if (base) return base.replace(/\/$/, "");
  const request = await headers();
  const host = request.get("x-forwarded-host") ?? request.get("host") ?? "localhost";
  return `${request.get("x-forwarded-proto") ?? "http"}://${host}`;
}
