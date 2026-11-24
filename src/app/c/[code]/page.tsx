import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { currentCabinetUser } from "@/modules/access";
import { getDatabase } from "@/modules/platform/db";
import { systemClock } from "@/modules/platform/clock";
import { voiceConfigured } from "@/modules/voice/relay-options";
import { createChannelAdapters } from "@/modules/channels";
import { pagesPerAddress, readWebChat, webChatCanStartOver, takeWebChatLimit, webChatElsewhere, webChatMessengerHandoff, webChatPhotosAccepted, webChatTitle, webChatVoiceInput } from "@/modules/web-chat";
import { clientAddress, currentVisitor } from "@/modules/web-chat/server";
import { TooManyAttempts } from "./too-many-attempts";
import { WebChat } from "./web-chat";
import "@/ui/web-chat/web-chat.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ code: string }>; searchParams: Promise<{ from?: string | string[] }> };

/**
 * Название чата по коду — одна проверка ограничения на загрузку страницы (заголовок и сама страница). Снятый с публикации
 * лидмагнит виден посетителю, у которого был этот разговор.
 */
const pageTitle = cache(async (code: string): Promise<{ kind: "found"; title: string } | { kind: "limited" } | { kind: "not_found" }> => {
  const db = getDatabase().db;
  if (!(await takeWebChatLimit(db, new Date(), pagesPerAddress(clientAddress(await headers()))))) return { kind: "limited" };
  const title = await webChatTitle(db, code, await currentVisitor());
  return title ? { kind: "found", title } : { kind: "not_found" };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const page = await pageTitle(code);
  const title = page.kind === "found" ? page.title : "Чат";
  return {
    title,
    appleWebApp: { capable: true, title, statusBarStyle: "default" },
    icons: { apple: "/web-chat/icon-180.png" },
  };
}

const SCROLL_FEED_TO_END = `(function(){var f=document.querySelector(".web-chat__feed");if(f)f.scrollTop=f.scrollHeight})()`;

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

/** Веб-чат лидмагнита: открыт без входа, посетитель видит только свой разговор. */
export default async function WebChatPage({ params, searchParams }: Props) {
  const { code } = await params;
  const visitor = await currentVisitor();
  // Старое уведомление другого лидмагнита: человек с тех пор перешёл по другой ссылке — ведём в текущий разговор, а не
  // начинаем тот заново, бросая этот
  if ((await searchParams).from === "notification" && visitor?.lastCode && visitor.lastCode !== code)
    redirect(`/c/${encodeURIComponent(visitor.lastCode)}`);
  const page = await pageTitle(code);
  if (page.kind === "not_found") notFound();
  if (page.kind === "limited")
    return <TooManyAttempts />;
  // Снятый лидмагнит, а идёт разговор другого: общая лента под этим названием читалась бы как чужая — только переход
  const elsewhere = visitor ? await webChatElsewhere(getDatabase().db, code, visitor, systemClock.now()) : null;
  // Вернувшийся посетитель видит свою переписку сразу со страницей, без двух запросов после загрузки скриптов
  const initialItems = visitor && !elsewhere ? await readWebChat(getDatabase().db, systemClock, visitor) : [];
  // Разговор ушёл в мессенджер или агент показал кнопки: вместо поля ввода — они, сразу со страницей
  const handoff = visitor && !elsewhere ? await webChatMessengerHandoff(getDatabase().db, createChannelAdapters(), visitor, code) : null;
  // Микрофон — только когда голос включён у лидмагнита и на сервере есть ключ Soniox
  const voice = !elsewhere && voiceConfigured() && (await webChatVoiceInput(getDatabase().db, code));
  // Кнопка фото — только когда лидмагнит принимает картинки клиента
  const photos = !elsewhere && (await webChatPhotosAccepted(getDatabase().db, code));
  // Вошедший эксперт проверяет живую страницу: ему — «Начать разговор заново», посетителям её нет. На снятом с
  // публикации лидмагните новый разговор не начнётся — и кнопки нет
  const canStartOver = (await currentCabinetUser()) !== null && (await webChatCanStartOver(getDatabase().db, code));
  return (
    <>
      {/* С cookie: в манифесте код входа именно этого посетителя (веб-приложение на экране «Домой» начинает без cookie) */}
      <link rel="manifest" href={`/c/${encodeURIComponent(code)}/manifest.webmanifest`} crossOrigin="use-credentials" />
      <WebChat code={code} title={page.title} initialItems={initialItems} closed={elsewhere?.current ?? null} voice={voice} photos={photos} initialHandoff={handoff} canStartOver={canStartOver} />
      {/* Лента сразу внизу, на последних сообщениях, ещё до загрузки скриптов — как будет и после */}
      {initialItems.length > 0 && <script dangerouslySetInnerHTML={{ __html: SCROLL_FEED_TO_END }} />}
    </>
  );
}
