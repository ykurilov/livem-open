"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebChatHandoffState, WebChatItem } from "@/modules/web-chat/web-chat";
import type { CurrentChat, OutgoingMessage, WebChatEntry, WebChatTransport } from "./transport";

/** Как часто открытый чат спрашивает новые сообщения. */
const POLL_MS = 2500;
/** Пока ждём ответ (приветствие или ответ на сообщение человека) — чаще, но недолго: обычно ответ приходит за секунды. */
const WAITING_POLL_MS = 1000;
const WAITING_POLL_WINDOW_MS = 30_000;
/** Запас при опросе: сообщение, записанное чуть раньше прошлого ответа, не потеряется (повторы отсекаются по id). */
const POLL_OVERLAP_MS = 60_000;
/** Сколько показывать «печатает» после сообщения человека: дольше ответ, скорее всего, придёт от эксперта, не сразу. */
const TYPING_MS = 90_000;
/** Столько неудачных опросов подряд (около 10 с) — уже не случайный сбой: человеку говорим, что новые сообщения не приходят. */
const POLL_FAILURES_TO_WARN = 4;

/** `elsewhere` — в этом чате написали, а у человека уже идёт другой разговор: сюда можно вернуться, начав заново. */
export type WebChatStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "closed" | "elsewhere"; current: CurrentChat };

export interface WebChatState {
  status: WebChatStatus;
  items: WebChatItem[];
  /** Кнопки мессенджеров вместо поля ввода: здесь разговор не продолжается. Только у открытого чата, иначе `null`. */
  handoff: WebChatHandoffState | null;
  /** Удачный вход: у API — билет голоса. */
  entry: Extract<WebChatEntry, { ok: true }> | null;
  sending: boolean;
  sendError: string | null;
  pollProblem: string | null;
  /** Приветствие ещё готовится. */
  waitingForGreeting: boolean;
  /** Приветствие готовится или ответ на сообщение человека в пути; ушло эксперту без автоответа — бот молчит. */
  waitingForReply: boolean;
  /** Сообщение ушло — `true`; сбой — `false`, причина в `sendError`. */
  send(message: { text: string; photo?: Blob }): Promise<boolean>;
  /** Новая попытка входа: после сбоя или чтобы вернуться в этот чат из другого. */
  reopen(): void;
}

/**
 * Разговор посетителя: вход, опрос, пока чат виден, отправка с повтором, «печатает». Как достучаться до сервера — `transport`.
 * `initialItems` и `initialHandoff` — лента и кнопки мессенджеров, собранные сервером вместе со страницей; `closed` — этот
 * чат закончен, идёт другой разговор.
 */
export function useWebChat({
  transport,
  initialItems = [],
  initialHandoff = null,
  closed = null,
  onEntered,
}: {
  transport: WebChatTransport;
  initialItems?: WebChatItem[];
  initialHandoff?: WebChatHandoffState | null;
  closed?: CurrentChat | null;
  onEntered?: (entry: Extract<WebChatEntry, { ok: true }>) => void;
}): WebChatState {
  const [status, setStatus] = useState<WebChatStatus>(closed ? { kind: "closed", current: closed } : { kind: "loading" });
  const [items, setItems] = useState<WebChatItem[]>(initialItems);
  const [handoff, setHandoff] = useState<WebChatHandoffState | null>(initialHandoff);
  const [entry, setEntry] = useState<Extract<WebChatEntry, { ok: true }> | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pollProblem, setPollProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pollFailures = useRef(0);
  const itemsRef = useRef<WebChatItem[]>(initialItems);
  const pendingRef = useRef<OutgoingMessage | null>(null);
  const onEnteredRef = useRef(onEntered);
  onEnteredRef.current = onEntered;

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
    const feed = await transport.feed(since);
    if (feed.kind !== "feed") {
      // Вход потерян — опрос сам не починится; сеть или сервер — после нескольких сбоев подряд
      if (feed.kind === "lost") setPollProblem("Чат перестал обновляться. Обновите страницу.");
      else if (++pollFailures.current >= POLL_FAILURES_TO_WARN)
        setPollProblem("Нет связи с чатом: новые сообщения пока не приходят. Проверьте интернет — мы пробуем снова.");
      return;
    }
    pollFailures.current = 0;
    setPollProblem(null);
    merge(feed.items);
    setHandoff(feed.handoff);
  }, [transport, merge]);

  // Вход, первый разговор, затем опрос, пока чат виден
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
    };

    (async () => {
      const entered = await transport.enter();
      if (stopped) return;
      if (!entered.ok) {
        if (entered.current) {
          itemsRef.current = [];
          setItems([]);
          setStatus({ kind: "closed", current: entered.current });
        } else setStatus({ kind: "failed", error: entered.error, retryable: entered.retryable });
        return;
      }
      setEntry(entered);
      onEnteredRef.current?.(entered);
      await poll().catch(() => {});
      setStatus({ kind: "ready" });
      setReadyAt(Date.now());
      schedule();
    })();

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [transport, poll, closed, attempt]);

  const reopen = useCallback(() => {
    transport.forgetEntry();
    setStatus({ kind: "loading" });
    setAttempt((current) => current + 1);
  }, [transport]);

  // Сбой входа из-за сети — повтор сам, как только связь вернётся
  const retryable = status.kind === "failed" && status.retryable;
  useEffect(() => {
    if (!retryable) return;
    window.addEventListener("online", reopen);
    return () => window.removeEventListener("online", reopen);
  }, [retryable, reopen]);

  async function send({ text, photo }: { text: string; photo?: Blob }): Promise<boolean> {
    text = text.trim();
    if ((!text && !photo) || sending) return false;
    setSending(true);
    setSendError(null);
    const pending = pendingRef.current;
    const message = pending?.text === text && pending.photo === photo ? pending : { text, clientId: crypto.randomUUID(), photo };
    pendingRef.current = message;
    const sent = await transport.send(message);
    setSending(false);
    if (!sent.ok) {
      // Идёт другой разговор: переход и возврат здесь же, черновик остаётся
      if (sent.current) {
        setStatus({ kind: "elsewhere", current: sent.current });
        return false;
      }
      // Разговор ушёл в мессенджер, пока чат не обновлялся: опрос принесёт кнопки вместо поля
      if (sent.status === 409) void poll().catch(() => {});
      setSendError(sent.error ?? "Не получилось отправить. Проверьте интернет и попробуйте ещё раз.");
      return false;
    }
    pendingRef.current = null;
    // Своё сообщение — сразу из ответа; ответ бота и пометки разбора придут опросом
    if (sent.item) merge([sent.item]);
    void poll().catch(() => {});
    return true;
  }

  const last = items.at(-1);
  const waitingForGreeting = status.kind === "ready" && !last && readyAt !== null && now - readyAt < TYPING_MS;
  const waitingForReply = waitingForGreeting || (last?.from === "person" && !last.noReply && now - new Date(last.at).getTime() < TYPING_MS);

  return {
    status,
    items,
    handoff: status.kind === "ready" ? handoff : null,
    entry,
    sending,
    sendError,
    pollProblem,
    waitingForGreeting,
    waitingForReply,
    send,
    reopen,
  };
}

/** При равном времени ответ бота раньше: человек отвечает на то, что видел. */
const order = (item: WebChatItem) => (item.from === "bot" ? 0 : 1);
