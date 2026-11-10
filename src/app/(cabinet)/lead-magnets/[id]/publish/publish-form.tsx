"use client";

import { startTransition, useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RobotIcon as Bot } from "@phosphor-icons/react";
import { Dialog } from "@ykurilov/ds-react";
import { Alert, Button } from "@/ui/primitives";
import { EmptyState, Select, type SelectOption } from "@/ui";
import { ConnectBotForm } from "../../../bots/connect-bot-form";
import type { ConnectedBot } from "../../../bots/actions";
import { publishAction, type PublishState } from "./actions";
import { NO_BOT } from "./no-bot";
import { keepingFormOnSendFailure } from "@/ui/form-upload";

export interface ChannelChoice {
  channel: string;
  label: string;
  bots: SelectOption[];
  /** Сломанные боты этого мессенджера: id → что с ним по последней проверке. */
  brokenBots: Record<string, string>;
  selected: string | null;
}

/** Для какого мессенджера открыто окно подключения; `all` — ботов нет совсем, мессенджер выбирают в окне. */
type ConnectTarget = { channel: string | "all"; attempt: number } | null;

/**
 * `draftVersionId` — версия черновика на странице: опубликуется только она.
 * `connectInline` — форма сама лежит в окне: подключение нового бота открывается на её месте, а не вторым окном поверх.
 */
export function PublishForm(props: { leadMagnetId: string; draftVersionId: string; channels: ChannelChoice[]; published: boolean; connectInline?: boolean }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PublishState, FormData>(
    keepingFormOnSendFailure(publishAction.bind(null, props.leadMagnetId)),
    {},
  );
  const [selected, setSelected] = useState(() =>
    Object.fromEntries(props.channels.map((choice) => [choice.channel, choice.selected ?? NO_BOT])),
  );
  // Подключённые здесь боты видны в списке сразу, не дожидаясь, пока страница перечитает их с сервера
  const [connected, setConnected] = useState<ConnectedBot[]>([]);
  // В окне без ботов выбирать нечего: сразу подключение
  const [connectTarget, setConnectTarget] = useState<ConnectTarget>(() =>
    props.connectInline && props.channels.every((choice) => choice.bots.length === 0) ? { channel: "all", attempt: 0 } : null,
  );
  const [justConnected, setJustConnected] = useState<{ label: string; channel: string } | null>(null);
  // «Опубликовано» относится к тем ботам, с которыми нажали кнопку: другой выбор его снимает, и поздний ответ
  // прежнего выбора у нового не показывается
  const [submittedSelection, setSubmittedSelection] = useState<Record<string, string> | null>(null);
  const sameSelection = submittedSelection !== null && props.channels.every((choice) => submittedSelection[choice.channel] === selected[choice.channel]);

  const botsOf = (choice: ChannelChoice): SelectOption[] => [
    ...choice.bots,
    ...connected
      .filter((bot) => bot.channel === choice.channel && !choice.bots.some((option) => option.value === bot.id))
      .map((bot) => ({ value: bot.id, label: bot.label })),
  ];
  const problemOfSelected = (choice: ChannelChoice): string | null => choice.brokenBots[selected[choice.channel]!] ?? null;
  const noBots = props.channels.every((choice) => botsOf(choice).length === 0);
  const openConnect = (channel: string | "all") => setConnectTarget((current) => ({ channel, attempt: (current?.attempt ?? 0) + 1 }));
  const dialogChannels = props.channels
    .filter((choice) => connectTarget?.channel === "all" || choice.channel === connectTarget?.channel)
    .map((choice) => ({ value: choice.channel, label: choice.label }));

  const onConnected = (bot: ConnectedBot) => {
    setConnected((current) => [...current, bot]);
    setSelected((current) => ({ ...current, [bot.channel]: bot.id }));
    setJustConnected({ label: bot.label, channel: props.channels.find((choice) => choice.channel === bot.channel)?.label ?? bot.channel });
    setConnectTarget(null);
    router.refresh();
  };

  const connectForm = connectTarget ? <ConnectBotForm key={connectTarget.attempt} channels={dialogChannels} onConnected={onConnected} /> : null;
  const connectDialog = props.connectInline ? null : (
    <Dialog open={connectTarget !== null} onClose={() => setConnectTarget(null)} title="Подключить нового бота">
      {connectForm}
    </Dialog>
  );

  if (props.connectInline && connectTarget)
    return (
      <div className="flex flex-col gap-[var(--yk-space-4)]">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">Подключить нового бота</span>
          {/* Без ботов возвращаться некуда: пустое состояние само ведёт сюда */}
          {noBots ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConnectTarget(null)}>
              ← К выбору бота
            </Button>
          )}
        </div>
        {connectForm}
      </div>
    );

  if (noBots) {
    return (
      <>
        <EmptyState
          icon={Bot}
          title="Ботов пока нет"
          hint="Подключите бота — он сразу будет выбран для этого лидмагнита."
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => openConnect("all")}>
              Подключить бота
            </Button>
          }
        />
        {connectDialog}
      </>
    );
  }

  // Окно — рядом с формой, а не внутри: в нём своя форма, а форма в форме не работает
  return (
    <>
      <form
        className="flex max-w-xl flex-col gap-[var(--yk-space-4)]"
        onSubmit={(event) => {
          // Через action React после отправки сбрасывает форму, и списки ботов показывали бы «Не выбран»
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setSubmittedSelection(selected);
          // Подсказка «нажмите „Опубликовать“» своё отработала
          setJustConnected(null);
          startTransition(() => formAction(data));
        }}
      >
        <input type="hidden" name="draftVersionId" value={props.draftVersionId} />
        {props.channels.map((choice) => (
          <div key={choice.channel} className="flex flex-col gap-1">
            <input type="hidden" name={`bot-${choice.channel}`} value={selected[choice.channel]} />
            <span className="text-[length:var(--yk-text-small-size)] font-semibold">Бот {choice.label}</span>
            {/* На узком экране список не сжимается до «Бот ш…»: кнопка подключения уходит строкой ниже */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[min(100%,16rem)] flex-1">
                <Select
                  aria-label={`Бот ${choice.label}`}
                  options={[{ value: NO_BOT, label: "Не выбран" }, ...botsOf(choice)]}
                  value={selected[choice.channel]}
                  onValueChange={(value) => {
                    setSelected((current) => ({ ...current, [choice.channel]: value }));
                  }}
                />
              </div>
              <Button type="button" variant="secondary" size="sm" aria-label={`Подключить нового бота ${choice.label}`} onClick={() => openConnect(choice.channel)}>
                Подключить нового бота
              </Button>
            </div>
            {problemOfSelected(choice) ? (
              <Alert variant="warm" title="Этот бот сейчас не работает">
                <span className="block">{problemOfSelected(choice)}</span>
                Пока его не починить, люди по ссылке не получат ответа: проверьте бота в разделе{" "}
                <Link href="/bots" className="app-focus underline">
                  «Боты»
                </Link>{" "}
                или выберите другого.
              </Alert>
            ) : null}
          </div>
        ))}
        {justConnected ? (
          <Alert variant="success" title="Бот подключён">
            {justConnected.label} выбран для {justConnected.channel}. Нажмите «{props.published ? "Опубликовать снова" : "Опубликовать"}», чтобы он заработал.
          </Alert>
        ) : null}
        {state.error ? (
          <Alert variant="danger" title="Не получилось опубликовать">
            {state.error}
          </Alert>
        ) : null}
        {/* Сняли с публикации — успех прошлого нажатия больше не правда */}
        {state.published && props.published && sameSelection ? (
          props.channels.some(problemOfSelected) ? (
            <Alert variant="warm" title="Опубликовано, но бот не работает">
              Лидмагнит заработает, когда бот снова будет на связи. Новые разговоры пойдут по этой версии.
            </Alert>
          ) : (
            <Alert variant="success" title="Опубликовано">
              Новые разговоры пойдут по этой версии. Начатые доиграют на своей.
            </Alert>
          )
        ) : null}
        <div>
          <Button type="submit" loading={pending}>
            {props.published ? "Опубликовать снова" : "Опубликовать"}
          </Button>
        </div>
      </form>
      {connectDialog}
    </>
  );
}
