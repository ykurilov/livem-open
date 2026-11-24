import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { bots } from "../../src/modules/channels/schema";
import { passages } from "../../src/modules/conversations/schema";
import { createLabeledLink, createLeadMagnet, publishWithBots, saveDraft } from "../../src/modules/lead-magnets";
import { createTokenCipher } from "../../src/modules/platform/crypto";
import type { DatabaseExecutor } from "../../src/modules/platform/db";
import { E2E_SCRIPT } from "../../src/modules/platform/e2e-script";
import { E2E_BASE_URL, e2eServerEnv } from "./e2e-env";

/** Опубликованный лидмагнит с веб-чатом; `code` — код его ссылки для виджета. */
export async function publishedLeadMagnet(db: DatabaseExecutor, tag: string, name: string): Promise<{ id: string; code: string; name: string }> {
  const lead = await createLeadMagnet(db, { name: `${name} ${tag}` });
  await saveDraft(db, lead.id, { ...lead.draft, instruction: "Ты консультант.", firstMessage: E2E_SCRIPT.firstMessage }, "manual");
  // Без мессенджера лидмагнит не публикуется: свой тестовый бот Telegram
  const token = `fake-widget${tag}`;
  const [bot] = await db
    .insert(bots)
    .values({
      channel: "telegram",
      title: `Бот виджета ${tag}`,
      externalId: `ext-${token}`,
      username: `bot_widget${tag}`,
      tokenEncrypted: createTokenCipher(e2eServerEnv().BOT_TOKEN_KEY!).encrypt(token),
      webhookSecret: `secret-${token}`,
    })
    .returning();
  await publishWithBots(db, lead.id, { telegram: bot!.id });
  const link = await createLabeledLink(db, { leadMagnetId: lead.id, label: `Сайт ${tag}` });
  return { id: lead.id, code: link.code, name: `${name} ${tag}` };
}

/**
 * «Чужой сайт» эксперта — настоящий сервер на другом адресе той же машины (127.0.0.1 вместо localhost): для браузера это
 * другой сайт. Подставленную тестом страницу без адреса в сети Chrome считает интернетом и не пускает её запросы в
 * локальную сеть, поэтому сайт отвечает сам.
 */
export interface ExpertSite {
  origin: string;
  /** Страница сайта с кодом виджета; `css` — стили сайта, `before` — разметка до виджета. */
  open(page: Page, options: { code: string; mode: "button" | "inline"; css?: string; before?: string }): Promise<void>;
  close(): Promise<void>;
}

export async function startExpertSite(): Promise<ExpertSite> {
  const pages = new Map<string, string>();
  const server = createServer((request, response) => {
    const body = pages.get((request.url ?? "").split("?")[0]!);
    if (!body) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    async open(page, { code, mode, css = "", before = "" }) {
      const path = `/expert-site-${code}-${mode}`;
      pages.set(
        path,
        `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Сайт эксперта</title>
<style>${css}</style></head><body><h1>Сайт эксперта</h1>${before}
<script src="${E2E_BASE_URL}/widget.js" async></script>
<livem-chat code="${code}" mode="${mode}"></livem-chat></body></html>`,
      );
      await page.goto(`${origin}${path}`);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function passagesOf(db: DatabaseExecutor, leadMagnetId: string) {
  return db.select({ id: passages.id }).from(passages).where(eq(passages.leadMagnetId, leadMagnetId));
}
