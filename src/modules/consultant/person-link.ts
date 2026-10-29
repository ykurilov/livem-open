import type { ChatStorage } from "@ykurilov/agent-chat-core";
import { createPersonLinkTool, PERSON_LINKS_PER_CHAT, type PersonLinkTools } from "@ykurilov/agent-chat-web-tools";
import { createFirecrawlServices } from "@ykurilov/agent-chat-web-tools/firecrawl";
import { optionalEnv } from "../platform/env";

/**
 * Цена снимка Firecrawl, $: один кредит. Оценка по тарифу с ~5 тыс. кредитов в месяц (~$0,005 за кредит).
 * Пишется в журнал расхода SDK (`web_tools`), по нему же считается дневной лимит.
 */
export const FIRECRAWL_SCREENSHOT_USD = 0.005;

type PersonLinkDeps = Parameters<typeof createPersonLinkTool>[0];

/**
 * Просмотр ссылки человека: только адреса из его реплик, не больше трёх за разговор; снимок видят модели с картинками.
 * Реплики сотрудника (ответ эксперта из «Входящих») SDK словами человека не считает.
 */
export function createConsultantPersonLink(deps: Pick<PersonLinkDeps, "storage" | "screenshots" | "fetch" | "resolveHost">): PersonLinkTools {
  return createPersonLinkTool({
    ...deps,
    maxPerChat: PERSON_LINKS_PER_CHAT,
    pricePerViewUsd: FIRECRAWL_SCREENSHOT_USD,
    logError: (message) => console.error(message),
  });
}

/** Просмотр из окружения: без `FIRECRAWL_API_KEY` смотреть ссылки нечем — `null`. */
export function personLinkFromEnv(
  env: Record<string, string | undefined>,
  storage: Pick<ChatStorage, "listMessages" | "listBranchSelections" | "insertUsageRecord">,
): PersonLinkTools | null {
  const apiKey = optionalEnv("FIRECRAWL_API_KEY", env);
  if (!apiKey) return null;
  const baseUrl = optionalEnv("FIRECRAWL_BASE_URL", env);
  const proxyToken = optionalEnv("PROXY_TOKEN", env);
  const firecrawl = createFirecrawlServices({
    apiKey,
    ...(baseUrl && { baseUrl, ...(proxyToken && { headers: { "X-Proxy-Token": proxyToken } }) }),
  });
  return createConsultantPersonLink({ screenshots: firecrawl.screenshots, storage });
}
