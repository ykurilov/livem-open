"use client";

import { ArrowUpIcon, MicrophoneIcon, SquareIcon, type Icon as PhosphorIcon, type IconProps } from "@phosphor-icons/react";
import { russianLabels, useVoiceDictation, type VoiceInputView } from "@ykurilov/agent-chat-react";
import { createVoiceInput } from "@ykurilov/agent-chat-voice";
import { Banner, Button, ChatHeader, Textarea } from "@ykurilov/ds-react";
import dynamic from "next/dynamic";
import { forwardRef, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { WebChatElsewhere, WebChatItem } from "@/modules/web-chat/web-chat";
import { useRememberedDraft } from "@/ui/remembered-draft";
import { webChatVoiceChatId } from "@/modules/voice/access";

/** Как часто открытая страница спрашивает новые сообщения. */
const POLL_MS = 2500;
/** Пока ждём ответ (приветствие или ответ на сообщение человека) — чаще, но недолго: обычно ответ приходит за секунды. */
const WAITING_POLL_MS = 1000;
const WAITING_POLL_WINDOW_MS = 30_000;
/** Запас при опросе: сообщение, записанное чуть раньше прошлого ответа, не потеряется (повторы отсекаются по id). */
const POLL_OVERLAP_MS = 60_000;
const MESSAGE_MAX_LENGTH = 2000;
const PUSH_DISMISSED_KEY = "web-chat-push-dismissed";
/** Код входа веб-приложения, пока вход по нему не подтвердился: переживает обновление страницы и перезапуск. */
const PENDING_RESUME_KEY = "web-chat-resume:";
const DRAFT_KEY = "web-chat-draft:";
/** Сколько показывать «печатает» после сообщения человека: дольше ответ, скорее всего, придёт от эксперта, не сразу. */
const TYPING_MS = 90_000;
/** Столько неудачных опросов подряд (около 10 с) — уже не случайный сбой: человеку говорим, что новые сообщения не приходят. */
const POLL_FAILURES_TO_WARN = 4;
/** Дольше ответа не ждём: повисший запрос (сеть «полуоткрыта») считается сбоем, человеку — ошибка с повтором. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Диктовка через сервер приложения: ключ Soniox остаётся на сервере, расход ложится на разговор человека. */
const webChatVoice = createVoiceInput({ api: "/api/voice", mode: "relay" });

/** Подгонка под клавиатуру телефона — после показа ленты: до готовности входа писать всё равно нельзя. */
const ViewportFit = dynamic(() => import("./viewport-fit"), { ssr: false });

/** `elsewhere` — во вкладке этого чата написали, а у человека уже идёт другой разговор: сюда можно вернуться, начав заново. */
type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "closed" | "elsewhere"; current: WebChatElsewhere["current"] };
type PushOffer = "none" | "ask" | "ios-install";

/**
 * `initialItems` — лента вернувшегося посетителя, собранная сервером вместе со страницей: видна до загрузки скриптов.
 * `closed` — этот чат закончен, идёт другой разговор: ни ленты, ни поля ввода, только переход в текущий.
 * `voice` — у лидмагнита включён голосовой ввод и на сервере есть ключ Soniox: в поле есть кнопка микрофона.
 */
export function WebChat({
  code,
  title,
  initialItems,
  closed = null,
  voice = false,
}: {
  code: string;
  title: string;
  initialItems: WebChatItem[];
  closed?: WebChatElsewhere["current"] | null;
  voice?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const [status, setStatus] = useState<Status>(closed ? { kind: "closed", current: closed } : { kind: "loading" });
  const [items, setItems] = useState<WebChatItem[]>(initialItems);
  // Набранное переживает перезагрузку страницы: черновик лежит в браузере, пока сообщение не уйдёт
  const [draft, setDraft] = useRememberedDraft(`${DRAFT_KEY}${code}`);
  // Сказанное дописывается к набранному; после «стоп» сервер чистит его моделью, заменяется только надиктованный кусок
  const dictation = useVoiceDictation({ voice: voice ? webChatVoice : undefined, value: draft, setValue: setDraft, chatId: webChatVoiceChatId(code) });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushOffer, setPushOffer] = useState<PushOffer>("none");
  const [pushError, setPushError] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  /** Новая попытка входа: после сбоя или чтобы вернуться в этот чат из другого. */
  const [attempt, setAttempt] = useState(0);
  const pollFailures = useRef(0);
  const itemsRef = useRef<WebChatItem[]>(initialItems);
  /** Неотправленное сообщение и его id: повтор после обрыва сети уходит с тем же id, и сервер второго не создаст. */
  const pendingRef = useRef<{ text: string; clientId: string } | null>(null);

  const merge = useCallback((incoming: WebChatItem[]) => {
    if (incoming.length === 0) return;
    const known = new Map(itemsRef.current.map((item) => [item.id, item]));
    for (const item of incoming) known.set(item.id, item);
    const next = [...known.values()].sort((a, b) => a.at.localeCompare(b.at) || order(a) - order(b));
    itemsRef.current = next;
    setItems(next);
  }, []);

  const poll = useCallback(async () => {
    const last = itemsRef.current.at(-1);
    const since = last ? new Date(new Date(last.at).getTime() - POLL_OVERLAP_MS).toISOString() : null;
    const response = await fetch(`/api/web-chat/messages${since ? `?since=${encodeURIComponent(since)}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    const items = response?.ok ? ((await response.json().catch(() => null)) as { items: WebChatItem[] } | null)?.items : undefined;
    if (!items) {
      // Вход потерян (браузер стёр cookie) — опрос сам не починится; сеть или сервер — после нескольких сбоев подряд
      if (response?.status === 401) setPollProblem("Чат перестал обновляться. Обновите страницу.");
      else if (++pollFailures.current >= POLL_FAILURES_TO_WARN)
        setPollProblem("Нет связи с чатом: новые сообщения пока не приходят. Проверьте интернет — мы пробуем снова.");
      return;
    }
    pollFailures.current = 0;
    setPollProblem(null);
    merge(items);
  }, [merge]);

  // Вход: cookie посетителя, первый разговор, затем опрос, пока страница видна
  useEffect(() => {
    if (closed) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const openedAt = Date.now();
    const awaitingReply = () => {
      const last = itemsRef.current.at(-1);
      const since = last ? new Date(last.at).getTime() : openedAt;
      return (!last || (last.from === "person" && !last.noReply)) && Date.now() - since < WAITING_POLL_WINDOW_MS;
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(
        async () => {
          if (document.visibilityState === "visible") await poll().catch(() => {});
          setNow(Date.now());
          schedule();
        },
        awaitingReply() ? WAITING_POLL_MS : POLL_MS,
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll().catch(() => {});
      else markAway();
    };

    (async () => {
      const session = await openSession(code);
      if (stopped) return;
      if (!session.ok) {
        if (session.current) {
          itemsRef.current = [];
          setItems([]);
          setStatus({ kind: "closed", current: session.current });
        } else setStatus({ kind: "failed", error: session.error, retryable: session.retryable });
        return;
      }
      setPushKey(session.pushKey);
      refreshManifest(code);
      await poll().catch(() => {});
      setStatus({ kind: "ready" });
      setReadyAt(Date.now());
      schedule();
    })();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", markAway);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/web-chat-sw.js", { scope: "/c/" }).catch(() => {});
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", markAway);
    };
  }, [code, poll, closed, attempt]);

  const reopen = useCallback(() => {
    forgetSession(code);
    setStatus({ kind: "loading" });
    setAttempt((current) => current + 1);
  }, [code]);

  // Сбой входа из-за сети — повтор сам, как только связь вернётся
  const retryable = status.kind === "failed" && status.retryable;
  useEffect(() => {
    if (!retryable) return;
    window.addEventListener("online", reopen);
    return () => window.removeEventListener("online", reopen);
  }, [retryable, reopen]);

  // Разрешение уже выдано: подписка этого браузера — за текущим посетителем. Прошлое сохранение могло не дойти, а cookie
  // могли стереть, оставив подписку прежнему посетителю
  useEffect(() => {
    if (!pushKey || !("Notification" in window) || !("PushManager" in window) || Notification.permission !== "granted") return;
    void saveSubscription(pushKey).catch(() => {});
  }, [pushKey]);

  // Просьба об уведомлениях — после первого ответа на сообщение человека, не сразу при открытии
  useEffect(() => {
    if (!pushKey || pushOffer !== "none" || readDismissed()) return;
    const firstPerson = items.findIndex((item) => item.from === "person");
    if (firstPerson < 0 || !items.slice(firstPerson).some((item) => item.from === "bot")) return;
    if (isIos() && !isStandalone()) setPushOffer("ios-install");
    else if ("Notification" in window && "PushManager" in window && Notification.permission === "default") setPushOffer("ask");
  }, [items, pushKey, pushOffer]);

  // Новые сообщения — вниз, если человек не листает историю выше
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && stickToBottom.current) feed.scrollTop = feed.scrollHeight;
  }, [items, pushOffer, status]);

  const onScroll = () => {
    const feed = feedRef.current;
    if (!feed) return;
    stickToBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    setScrolled(feed.scrollTop > 0);
  };

  /** `chosen` — готовый ответ с кнопки: уходит как обычное сообщение, черновик в поле не трогается. */
  async function send(event?: FormEvent, chosen?: string) {
    event?.preventDefault();
    const text = (chosen ?? draft).trim();
    if (!text || sending) return;
    dictation.cancel();
    setSending(true);
    setSendError(null);
    if (pendingRef.current?.text !== text) pendingRef.current = { text, clientId: crypto.randomUUID() };
    const response = await fetch("/api/web-chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...pendingRef.current, code }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    setSending(false);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as { error?: string; current?: WebChatElsewhere["current"] } | null;
      // Идёт другой разговор: обновить страницу в веб-приложении нечем — переход и возврат здесь же, черновик остаётся
      if (body?.current) return setStatus({ kind: "elsewhere", current: body.current });
      setSendError(body?.error ?? "Не получилось отправить. Проверьте интернет и попробуйте ещё раз.");
      return;
    }
    pendingRef.current = null;
    // Пока сообщение уходило, человек мог дописать следующее — его не стираем
    setDraft((current) => (current.trim() === text ? "" : current));
    stickToBottom.current = true;
    // Своё сообщение — сразу из ответа; ответ бота и пометки разбора придут опросом
    const sent = (await response.json().catch(() => null)) as { item?: WebChatItem | null } | null;
    if (sent?.item) merge([sent.item]);
    void poll().catch(() => {});
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !isTouch()) {
      event.preventDefault();
      void send();
    }
  }

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
    const saved = await saveSubscription(pushKey).then(() => true, () => false);
    if (!saved) return setPushError("Не получилось включить уведомления. Попробуйте ещё раз.");
    setPushOffer("none");
    rememberDismissed();
  }

  function dismissPush() {
    setPushOffer("none");
    setPushError(null);
    rememberDismissed();
  }

  const last = items.at(-1);
  // Приветствие ещё готовится или ответ на сообщение человека в пути; ушло эксперту без автоответа — бот молчит
  const waitingForGreeting = status.kind === "ready" && !last && readyAt !== null && now - readyAt < TYPING_MS;
  const waitingForReply =
    waitingForGreeting || (last?.from === "person" && !last.noReply && now - new Date(last.at).getTime() < TYPING_MS);

  return (
    <div ref={rootRef} className="web-chat">
      <ViewportFit target={rootRef} />
      <ChatHeader title={title} scrolled={scrolled} headingLevel={1} />
      <div ref={feedRef} className="web-chat__feed" onScroll={onScroll} role="log" aria-label="Переписка">
        <div className="web-chat__column">
          {status.kind === "loading" && items.length === 0 && <p className="web-chat__note">Открываем чат…</p>}
          {status.kind === "failed" && (
            <>
              <Banner tone="danger">{status.error}</Banner>
              {status.retryable && (
                <div className="web-chat__offer-actions">
                  <Button type="button" size="sm" onClick={reopen}>
                    Попробовать снова
                  </Button>
                </div>
              )}
            </>
          )}
          {status.kind === "ready" && !last && !waitingForGreeting && (
            <p className="web-chat__note">Приветствие задерживается. Можно написать первым — вам ответят здесь.</p>
          )}
          {(status.kind === "closed" || status.kind === "elsewhere") && (
            <div className="web-chat__offer" role="group" aria-label={status.kind === "closed" ? "Чат закончен" : "Идёт другой разговор"}>
              <p>
                {status.kind === "closed"
                  ? `Этот чат закончен. Сейчас у вас идёт разговор «${status.current.title}» — продолжить можно там.`
                  : `Сейчас у вас идёт разговор «${status.current.title}». Продолжите его или вернитесь в этот чат — он начнётся заново.`}
              </p>
              <div className="web-chat__offer-actions">
                <Button href={`/c/${encodeURIComponent(status.current.code)}`} size="sm">
                  Перейти в текущий чат
                </Button>
                {status.kind === "elsewhere" && (
                  <Button type="button" size="sm" variant="secondary" onClick={reopen}>
                    Вернуться в этот чат
                  </Button>
                )}
              </div>
            </div>
          )}
          {/* Лента общая: под названием этого чата, когда идёт другой, она читалась бы как чужая */}
          {status.kind !== "elsewhere" && items.map((item) => <ChatBubble key={item.id} item={item} />)}
          {/* Готовые ответы — только под последним сообщением консультанта: ответил человек — их нет */}
          {status.kind === "ready" && last?.from === "bot" && last.quickReplies && (
            <div className="web-chat__quick-replies" role="group" aria-label="Быстрые ответы">
              {last.quickReplies.map((reply) => (
                <Button key={reply} type="button" size="sm" variant="secondary" className="web-chat__quick-reply" disabled={sending} onClick={() => void send(undefined, reply)}>
                  {reply}
                </Button>
              ))}
            </div>
          )}
          {waitingForReply && status.kind !== "elsewhere" && (
            <div className="web-chat__typing" aria-label="Печатает">
              <span />
              <span />
              <span />
            </div>
          )}
          {pollProblem && status.kind === "ready" && <Banner tone="danger">{pollProblem}</Banner>}
          {pushOffer === "ask" && (
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
          )}
          {pushOffer === "ios-install" && (
            <div className="web-chat__offer" role="group" aria-label="Уведомления на iPhone">
              <p>
                Чтобы получать ответы и напоминания на iPhone, добавьте чат на экран «Домой»: нажмите «Поделиться» внизу Safari, затем
                «На экран „Домой“». Откройте чат со значка и включите уведомления.
              </p>
              <div className="web-chat__offer-actions">
                <Button type="button" size="sm" variant="secondary" onClick={dismissPush}>
                  Понятно
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {status.kind !== "closed" && status.kind !== "elsewhere" && (
        <form className="web-chat__composer" onSubmit={send}>
          <div className="web-chat__column">
            {sendError && <p className="web-chat__error" role="alert">{sendError}</p>}
            {dictation.view?.error && <p className="web-chat__error" role="alert">{dictation.view.error}</p>}
            <div className={`web-chat__field${status.kind !== "ready" ? " web-chat__field--disabled" : ""}`}>
              <div className="web-chat__input">
                <Textarea
                  autoGrow
                  aria-label="Сообщение"
                  placeholder="Напишите сообщение"
                  rows={1}
                  maxLength={MESSAGE_MAX_LENGTH}
                  value={draft}
                  disabled={status.kind !== "ready"}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div className="web-chat__field-actions">
                {dictation.view && <VoiceButton view={dictation.view} disabled={status.kind !== "ready"} />}
                <Button
                  type="submit"
                  size="lg"
                  icon={ArrowUpIcon}
                  aria-label="Отправить"
                  className="web-chat__send"
                  // Пока сообщение уходит, кнопка занята: повторное нажатие не проходит
                  loading={sending && Boolean(draft.trim())}
                  disabled={!draft.trim() || status.kind !== "ready"}
                  // Фокус остаётся в поле: на iPhone клавиатура не закрывается после каждого сообщения
                  onPointerDown={keepInputFocus}
                  onMouseDown={keepInputFocus}
                />
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

/** Квадрат «стоп» — закрашенный: так он читается в кружке кнопки. */
const StopGlyph: PhosphorIcon = forwardRef<SVGSVGElement, IconProps>((props, ref) => <SquareIcon ref={ref} {...props} weight="fill" />);
StopGlyph.displayName = "StopGlyph";

/** Микрофон в поле: нажал — говорит, нажал ещё раз — текст дописан в поле, его можно поправить и отправить. */
function VoiceButton({ view, disabled }: { view: VoiceInputView; disabled: boolean }) {
  const labels = russianLabels;
  const busy = view.state === "connecting" || view.state === "stopping" || view.polishing;
  const recording = !busy && view.state === "listening";
  const label = busy ? (view.polishing ? labels.voicePolishing : labels.voiceConnecting) : recording ? labels.voiceStop : labels.voiceStart;
  return (
    <Button
      type="button"
      size="lg"
      variant="ghost"
      icon={recording ? StopGlyph : MicrophoneIcon}
      aria-label={label}
      aria-pressed={busy ? undefined : recording}
      className={`web-chat__voice${recording ? " web-chat__voice--recording" : ""}`}
      // Подключение и обработка сказанного: кнопка занята, нажатия не проходят
      loading={busy}
      disabled={disabled}
      onClick={view.onToggle}
      onPointerDown={keepInputFocus}
      onMouseDown={keepInputFocus}
    />
  );
}

function ChatBubble({ item }: { item: WebChatItem }) {
  return (
    <div className={`web-chat__bubble web-chat__bubble--${item.from}`} data-from={item.from}>
      {item.imageUrl && (
        // Картинка своя, отдаётся только этому посетителю: оптимизатор Next её не получит
        // eslint-disable-next-line @next/next/no-img-element
        <img className="web-chat__image" src={item.imageUrl} alt="Картинка от консультанта" loading="lazy" />
      )}
      {item.video &&
        (item.video.embedUrl ? (
          <div className="web-chat__video">
            <iframe
              src={item.video.embedUrl}
              title={item.video.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              loading="lazy"
            />
          </div>
        ) : (
          <a href={item.video.url} target="_blank" rel="noreferrer">
            {item.video.title}
          </a>
        ))}
      {item.video && item.video.embedUrl && <p className="web-chat__video-title">{item.video.title}</p>}
      {item.text && <p className="web-chat__text">{linkified(item.text)}</p>}
    </div>
  );
}

type Session = { ok: true; pushKey: string | null } | { ok: false; error: string; retryable: boolean; current?: WebChatElsewhere["current"] };
const sessions = new Map<string, Promise<Session>>();

/**
 * Вход посетителя — один на загрузку страницы. Два одновременных запроса без cookie завели бы двух посетителей,
 * и cookie досталась бы любому из них (React в разработке запускает эффект дважды).
 */
function openSession(code: string): Promise<Session> {
  let session = sessions.get(code);
  if (!session) {
    session = requestSession(code, takeResumeFromAddress(code));
    sessions.set(code, session);
  }
  return session;
}

/** Следующий вход — заново, а не прошлый ответ: повтор после сбоя или возврат в этот чат из другого. */
function forgetSession(code: string): void {
  sessions.delete(code);
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

async function requestSession(code: string, resume: string | null): Promise<Session> {
  const failed = "Не получилось открыть чат. Проверьте интернет и попробуйте снова.";
  const response = await fetch("/api/web-chat/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, resume, timeZone: browserTimeZone() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as { pushKey?: string | null; error?: string; current?: WebChatElsewhere["current"] } | null;
  if (!response?.ok) {
    sessions.delete(code);
    // Ссылка устарела — повтор не поможет
    return { ok: false, error: body?.error ?? failed, retryable: response?.status !== 404, ...(body?.current && { current: body.current }) };
  }
  if (resume) removeStorage(PENDING_RESUME_KEY + code);
  return { ok: true, pushKey: body?.pushKey ?? null };
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
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

function keepInputFocus(event: { preventDefault(): void }): void {
  event.preventDefault();
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;

function linkified(text: string) {
  return text.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1 ? (
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/** При равном времени ответ бота раньше: человек отвечает на то, что видел. */
const order = (item: WebChatItem) => (item.from === "bot" ? 0 : 1);

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isTouch(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

function readDismissed(): boolean {
  return readStorage(PUSH_DISMISSED_KEY) === "1";
}

function rememberDismissed(): void {
  // Без хранилища просьба просто появится снова
  writeStorage(PUSH_DISMISSED_KEY, "1");
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Без хранилища — только то, что в памяти страницы
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Нечего убирать
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
