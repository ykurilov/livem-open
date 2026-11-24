"use client";

import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { createVoiceInput } from "@ykurilov/agent-chat-voice";
import { Button } from "@ykurilov/ds-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WebChatElsewhere, WebChatHandoffState, WebChatItem } from "@/modules/web-chat/web-chat";
import { webChatVoiceChatId } from "@/modules/voice/access";
import { readStorage, removeStorage, writeStorage } from "@/ui/web-chat/browser-storage";
import { pageTransport, REQUEST_TIMEOUT_MS } from "@/ui/web-chat/transport";
import { useWebChat } from "@/ui/web-chat/use-web-chat";
import { WebChatView } from "@/ui/web-chat/web-chat-view";

const PUSH_DISMISSED_KEY = "web-chat-push-dismissed";
/** Код входа веб-приложения, пока вход по нему не подтвердился: переживает обновление страницы и перезапуск. */
const PENDING_RESUME_KEY = "web-chat-resume:";
const DRAFT_KEY = "web-chat-draft:";

/** Диктовка через сервер приложения: ключ Soniox остаётся на сервере, расход ложится на разговор человека. */
const webChatVoice = createVoiceInput({ api: "/api/voice", mode: "relay" });

/** Подгонка под клавиатуру телефона — после показа ленты: до готовности входа писать всё равно нельзя. */
const ViewportFit = dynamic(() => import("./viewport-fit"), { ssr: false });

type PushOffer = "none" | "ask" | "ios-install";

/**
 * Страница веб-чата `/c/<код>`: общий вид веб-чата и своё — уведомления, экран «Домой», «Начать заново» эксперта.
 * `initialItems` — лента вернувшегося посетителя, собранная сервером вместе со страницей: видна до загрузки скриптов.
 * `closed` — этот чат закончен, идёт другой разговор: ни ленты, ни поля ввода, только переход в текущий.
 * `voice` — у лидмагнита включён голосовой ввод и на сервере есть ключ Soniox: в поле есть кнопка микрофона.
 * `photos` — лидмагнит принимает фото клиента: в поле есть кнопка фото.
 * `initialHandoff` — агент позвал в мессенджер или человек уже там: вместо поля ввода кнопки мессенджеров.
 * `canStartOver` — страницу открыл вошедший эксперт: в шапке «Начать разговор заново».
 */
export function WebChat({
  code,
  title,
  initialItems,
  closed = null,
  voice = false,
  photos = false,
  initialHandoff = null,
  canStartOver = false,
}: {
  code: string;
  title: string;
  initialItems: WebChatItem[];
  closed?: WebChatElsewhere["current"] | null;
  voice?: boolean;
  photos?: boolean;
  initialHandoff?: WebChatHandoffState | null;
  canStartOver?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const transport = useMemo(
    () =>
      pageTransport(
        code,
        () => takeResumeFromAddress(code),
        () => removeStorage(PENDING_RESUME_KEY + code),
      ),
    [code],
  );
  const [pushKey, setPushKey] = useState<string | null>(null);
  const chat = useWebChat({
    transport,
    initialItems,
    initialHandoff,
    closed,
    onEntered: (entry) => {
      setPushKey(entry.pushKey);
      refreshManifest(code);
    },
  });
  const [pushOffer, setPushOffer] = useState<PushOffer>("none");
  const [pushError, setPushError] = useState<string | null>(null);
  const { items } = chat;

  // Страница скрыта или закрывается: ответ должен прийти уведомлением, не дожидаясь, пока отметка «открыта» устареет
  useEffect(() => {
    if (closed) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") markAway();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", markAway);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/web-chat-sw.js", { scope: "/c/" }).catch(() => {});
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", markAway);
    };
  }, [closed]);

  // Разрешение уже выдано: подписка этого браузера — за текущим посетителем. Прошлое сохранение могло не дойти, а cookie
  // могли стереть, оставив подписку прежнему посетителю
  useEffect(() => {
    if (!pushKey || !("Notification" in window) || !("PushManager" in window) || Notification.permission !== "granted") return;
    void saveSubscription(pushKey).catch(() => {});
  }, [pushKey]);

  // Просьба об уведомлениях — после первого ответа на сообщение человека, не сразу при открытии
  useEffect(() => {
    if (!pushKey || pushOffer !== "none" || readStorage(PUSH_DISMISSED_KEY) === "1") return;
    const firstPerson = items.findIndex((item) => item.from === "person");
    if (firstPerson < 0 || !items.slice(firstPerson).some((item) => item.from === "bot")) return;
    if (isIos() && !isStandalone()) setPushOffer("ios-install");
    else if ("Notification" in window && "PushManager" in window && Notification.permission === "default") setPushOffer("ask");
  }, [items, pushKey, pushOffer]);

  /**
   * Предложение скрывается, только когда подписка сохранена или человек отказал; сбой — предложение остаётся для повтора.
   * Системное окно закрыли без ответа — это не сбой: предложение остаётся без ошибки.
   */
  async function enablePush() {
    if (!pushKey) return;
    setPushError(null);
    const permission = await Notification.requestPermission().catch(() => "default" as NotificationPermission);
    if (permission === "denied") return dismissPush();
    if (permission !== "granted") return;
    const saved = await saveSubscription(pushKey).then(
      () => true,
      () => false,
    );
    if (!saved) return setPushError("Не получилось включить уведомления. Попробуйте ещё раз.");
    setPushOffer("none");
    writeStorage(PUSH_DISMISSED_KEY, "1");
  }

  function dismissPush() {
    setPushOffer("none");
    setPushError(null);
    // Без хранилища просьба просто появится снова
    writeStorage(PUSH_DISMISSED_KEY, "1");
  }

  const pushOfferView =
    pushOffer === "ask" ? (
      <div className="web-chat__offer" role="group" aria-label="Уведомления">
        <p>Включите уведомления — пришлём ответ и напоминания, даже если закроете страницу.</p>
        {pushError && <p className="web-chat__error" role="alert">{pushError}</p>}
        <div className="web-chat__offer-actions">
          <Button type="button" size="sm" onClick={enablePush}>
            Включить уведомления
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={dismissPush}>
            Не сейчас
          </Button>
        </div>
      </div>
    ) : pushOffer === "ios-install" ? (
      <div className="web-chat__offer" role="group" aria-label="Уведомления на iPhone">
        <p>
          Чтобы получать ответы и напоминания на iPhone, добавьте чат на экран «Домой»: нажмите «Поделиться» внизу Safari, затем «На экран
          „Домой“». Откройте чат со значка и включите уведомления.
        </p>
        <div className="web-chat__offer-actions">
          <Button type="button" size="sm" variant="secondary" onClick={dismissPush}>
            Понятно
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <WebChatView
      chat={chat}
      title={title}
      draftKey={`${DRAFT_KEY}${code}`}
      voice={voice ? { input: webChatVoice, chatId: webChatVoiceChatId(code) } : null}
      photos={photos}
      headerAside={canStartOver ? <StartOverButton code={code} /> : undefined}
      feedFooter={pushOfferView}
      currentChatHref={(current) => `/c/${encodeURIComponent(current)}`}
      rootRef={rootRef}
    >
      <ViewportFit target={rootRef} />
    </WebChatView>
  );
}

/**
 * «Начать разговор заново» для эксперта: браузер становится новым посетителем, страница открывается с чистого листа.
 * Сбой — подпись на кнопке, разговор остаётся прежним.
 */
function StartOverButton({ code }: { code: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const startOver = async () => {
    setPending(true);
    setFailed(false);
    const response = await fetch("/api/web-chat-owner/start-over", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) {
      setPending(false);
      setFailed(true);
      return;
    }
    removeStorage(`${DRAFT_KEY}${code}`);
    window.location.replace(window.location.pathname);
  };
  return (
    <Button type="button" size="sm" variant="secondary" icon={ArrowCounterClockwiseIcon} loading={pending} onClick={() => void startOver()}>
      {failed ? "Не вышло — ещё раз" : "Начать разговор заново"}
    </Button>
  );
}

/**
 * Код входа (`resume`) действует только в веб-приложении с экрана «Домой»: его адрес старта задаёт наш манифест. В обычной
 * вкладке это чужая ссылка — по ней посторонний подсадил бы человека в свой разговор и читал бы его. Адрес чистится всегда,
 * а код ждёт подтверждённого входа в хранилище страницы: обновление после сбоя сети не заведёт нового посетителя.
 */
function takeResumeFromAddress(code: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromAddress = params.get("resume");
  if (params.has("resume") || params.has("from")) window.history.replaceState(null, "", window.location.pathname);
  if (!isStandalone()) return null;
  if (fromAddress) writeStorage(PENDING_RESUME_KEY + code, fromAddress);
  return fromAddress ?? readStorage(PENDING_RESUME_KEY + code);
}

/** Подписка этого браузера (новая или прежняя) — на сервер; сбой — исключение. */
async function saveSubscription(pushKey: string): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(pushKey) }));
  const response = await fetch("/api/web-chat/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Подписка не сохранилась: ${response.status}`);
}

/**
 * Манифест перечитывается, когда у посетителя уже есть cookie: первый запрос браузер шлёт при разборе страницы, до неё,
 * и в адресе старта веб-приложения не было бы кода входа — с экрана «Домой» открылся бы пустой чат.
 */
function refreshManifest(code: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = `/c/${encodeURIComponent(code)}/manifest.webmanifest?v=${Date.now()}`;
}

/** Страница скрыта или закрывается: ответ должен прийти уведомлением, не дожидаясь, пока отметка «открыта» устареет. */
function markAway(): void {
  try {
    navigator.sendBeacon?.("/api/web-chat/away");
  } catch {
    // Без отметки уведомление просто придёт чуть позже
  }
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
