import { optionalEnv } from "../platform/env";

/** Цена распознавания Soniox в реальном времени, $ за час звука (минута — $0,002). */
export const SONIOX_USD_PER_HOUR = 0.12;

type Env = Record<string, string | undefined>;

/** Голос есть, только когда на сервере лежит ключ Soniox: без него кнопки микрофона нет. */
export function voiceConfigured(env: Env = process.env): boolean {
  return optionalEnv("SONIOX_API_KEY", env) !== undefined;
}

/**
 * Куда сервер подключается к Soniox. По умолчанию напрямую (из Москвы Soniox доступен). `SONIOX_WEBSOCKET_URL` — маршрут
 * прокси до `stt-rt.soniox.com`; пропуск прокси уходит только вместе с ним, напрямую в Soniox — никогда.
 */
export function voiceRelayConnection(env: Env = process.env): { websocketUrl?: string; upstreamHeaders?: Record<string, string> } {
  const websocketUrl = optionalEnv("SONIOX_WEBSOCKET_URL", env);
  if (!websocketUrl) return {};
  const proxyToken = optionalEnv("PROXY_TOKEN", env);
  return { websocketUrl, ...(proxyToken && { upstreamHeaders: { "X-Proxy-Token": proxyToken } }) };
}
