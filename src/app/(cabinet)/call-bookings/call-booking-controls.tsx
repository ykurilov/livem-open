"use client";

import { Checkbox, Dialog } from "@ykurilov/ds-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { ACTION_SEND_FAILED, keepingFormOnSendFailure } from "@/ui/form-upload";
import { Alert, Badge, Button, Field, Textarea } from "@/ui/primitives";
import { useHydrated } from "@/ui/use-hydrated";
import { cancelCallBookingAction, disconnectCallNoticeAction, startCallNoticeConnectAction, type CallBookingActionState } from "./actions";

/** Пока эксперт подключает бота, страница перечитывается: после «Старта» блок сам покажет «Подключён». */
const CONNECT_REFRESH_MS = 3_000;

/** `defaultMessage` — что уйдёт человеку, если эксперт не напишет своё. */
export function CancelCallButton({ bookingId, label, defaultMessage }: { bookingId: string; label: string; defaultMessage: string }) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [tellPerson, setTellPerson] = useState(true);
  const [state, cancel, pending] = useActionState<CallBookingActionState, FormData>(
    keepingFormOnSendFailure(cancelCallBookingAction.bind(null, bookingId), ACTION_SEND_FAILED),
    {},
  );
  useEffect(() => {
    if (state.done) setOpen(false);
  }, [state]);
  return (
    <>
      <Button variant="secondary" size="sm" disabled={!hydrated} onClick={() => setOpen(true)}>
        Отменить
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Отменить запись?">
        <p>{label}</p>
        <p className="app-muted mt-2">Время снова станет свободным.</p>
        <form action={cancel} className="mt-[var(--yk-space-4)] flex flex-col gap-[var(--yk-space-4)]">
          <Checkbox name="tellPerson" checked={tellPerson} onChange={(event) => setTellPerson(event.target.checked)}>
            Сообщить человеку
          </Checkbox>
          {tellPerson ? (
            <Field label="Своими словами" hint="Необязательно. Пусто — уйдёт текст из подсказки в поле. Дальше разговор продолжит консультант.">
              <Textarea name="text" rows={3} placeholder={defaultMessage} />
            </Field>
          ) : null}
          {state.error ? <Alert variant="danger" title="Не отменено">{state.error}</Alert> : null}
          <div className="app-dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Не отменять
            </Button>
            <Button type="submit" variant="destructive" loading={pending}>
              Отменить запись
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export interface NoticeBotView {
  botId: string;
  name: string;
  state: "connected" | "waiting" | "off";
  failure: string | null;
}

function NoticeBotRow({ bot }: { bot: NoticeBotView }) {
  const [connectState, connect, connecting] = useActionState<CallBookingActionState, FormData>(
    keepingFormOnSendFailure(startCallNoticeConnectAction.bind(null, bot.botId), ACTION_SEND_FAILED),
    {},
  );
  const [disconnectState, disconnect, disconnecting] = useActionState<CallBookingActionState, FormData>(
    keepingFormOnSendFailure(disconnectCallNoticeAction.bind(null, bot.botId), ACTION_SEND_FAILED),
    {},
  );
  const link = bot.state === "connected" ? null : connectState.link;
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--yk-border)] pb-[var(--yk-space-3)] last:border-b-0" data-testid={`notice-bot-${bot.botId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{bot.name}</span>
          {bot.state === "connected" ? <Badge variant="success">Подключён</Badge> : bot.state === "waiting" ? <Badge variant="warm">Ждёт «Старта»</Badge> : null}
        </span>
        <span className="flex gap-2">
          <form action={connect}>
            <Button type="submit" variant={bot.state === "connected" ? "secondary" : "primary"} size="sm" loading={connecting}>
              {bot.state === "connected" ? "Подключить заново" : "Подключить"}
            </Button>
          </form>
          {bot.state !== "off" ? (
            <form action={disconnect}>
              <Button type="submit" variant="secondary" size="sm" loading={disconnecting}>
                Отключить
              </Button>
            </form>
          ) : null}
        </span>
      </div>
      {link ? (
        <p>
          Откройте{" "}
          <a href={link} target="_blank" rel="noreferrer" className="underline" data-testid="notice-connect-link">
            ссылку на бота
          </a>{" "}
          со своего аккаунта и нажмите «Старт». Бот ответит, что уведомления подключены.
        </p>
      ) : null}
      {bot.failure ? <Alert variant="danger" title="Уведомление не дошло">{bot.failure}</Alert> : null}
      {connectState.error || disconnectState.error ? <Alert variant="danger" title={connectState.error ?? disconnectState.error ?? ""} /> : null}
    </li>
  );
}

export function NoticeBots({ bots }: { bots: NoticeBotView[] }) {
  const router = useRouter();
  const waiting = bots.some((bot) => bot.state === "waiting");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, CONNECT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [waiting, router]);
  return (
    <ul className="flex flex-col gap-[var(--yk-space-3)]">
      {bots.map((bot) => (
        <NoticeBotRow key={bot.botId} bot={bot} />
      ))}
    </ul>
  );
}
