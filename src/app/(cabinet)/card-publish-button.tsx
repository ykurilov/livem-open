"use client";

import { ChatCircleDotsIcon, PlugIcon, WarningIcon } from "@phosphor-icons/react";
import { Button, Dialog } from "@ykurilov/ds-react";
import { Alert } from "@/ui/primitives";
import { CopyableLink } from "@/ui";
import { useState, type ComponentType } from "react";
import { MaxBrandIcon, TelegramBrandIcon, VkBrandIcon } from "@/ui/messenger-brand-icons";
import type { ChannelKind } from "@/modules/channels";
import { PublishForm, type ChannelChoice } from "./lead-magnets/[id]/publish/publish-form";
import { UnpublishForm } from "./lead-magnets/[id]/publish/unpublish-form";

const LABEL = "Подключить к боту";
const WEB_LABEL = "Веб-версия";

/** Куда подключён лидмагнит: мессенджер и бот. */
export interface CardConnection {
  channel: ChannelKind;
  channelLabel: string;
  username: string;
  /** Проверка бота нашла ошибку: лидмагнит в этом мессенджере сейчас не отвечает. */
  broken: boolean;
}

// Порядок постоянный: значки стоят на своих местах при любом наборе мессенджеров
const CHANNEL_ORDER: ChannelKind[] = ["telegram", "vk", "max"];
const CHANNEL_ICONS: Record<ChannelKind, ComponentType> = { telegram: TelegramBrandIcon, vk: VkBrandIcon, max: MaxBrandIcon, web: ChatCircleDotsIcon };

/** Плашка на карточке лидмагнита: куда он подключён, по нажатию — выбор ботов и публикация в окне, без перехода в редактор. */
export function CardPublishButton(props: {
  leadMagnetId: string;
  name: string;
  draftVersionId: string;
  channels: ChannelChoice[];
  published: boolean;
  connections: CardConnection[];
  /** Ссылка на веб-версию чата; есть только у опубликованного лидмагнита. */
  webLink: string | null;
}) {
  const [open, setOpen] = useState(false);
  // Каждое открытие — заново: выбор и сообщения прошлого раза не висят
  const [attempt, setAttempt] = useState(0);
  // Снятие с публикации убирает кнопку из окна: на её месте — итог, пока окно открыто
  const [publishedWhileOpen, setPublishedWhileOpen] = useState(props.published);
  if (props.published && !publishedWhileOpen) setPublishedWhileOpen(true);
  // Черновик с привязанным ботом не работает: ссылки его не запускают
  const connections = props.published ? CHANNEL_ORDER.flatMap((channel) => props.connections.filter((connection) => connection.channel === channel)) : [];
  // Имена ботов — в подсказке: на кнопке только значки, чтобы она не обрезалась при трёх мессенджерах
  const bots = [
    ...connections.map((connection) => `${connection.channelLabel}: @${connection.username}${connection.broken ? " — не работает" : ""}`),
    ...(props.webLink ? [WEB_LABEL] : []),
  ].join(" · ");
  const broken = connections.some((connection) => connection.broken);

  const openDialog = () => {
    setAttempt((current) => current + 1);
    setPublishedWhileOpen(props.published);
    setOpen(true);
  };

  return (
    <>
      {connections.length === 0 ? (
        <Button type="button" variant="secondary" size="sm" icon={PlugIcon} className="app-card-action relative z-10" onClick={openDialog}>
          {LABEL}
        </Button>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={broken ? WarningIcon : undefined}
          className={`app-card-action relative z-10${broken ? " text-[var(--yk-danger)]" : ""}`}
          title={bots}
          aria-label={`${broken ? "Бот не работает" : "Работает в"}: ${bots}. Сменить бота`}
          onClick={openDialog}
        >
          {broken ? "Бот не работает" : "Работает в"}
          <span className="flex items-center gap-1">
            {connections.map((connection) => {
              const Icon = CHANNEL_ICONS[connection.channel];
              return <Icon key={connection.channel} />;
            })}
            {props.webLink ? <ChatCircleDotsIcon aria-hidden /> : null}
          </span>
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={`${LABEL}: ${props.name}`}>
        <PublishForm
          key={attempt}
          leadMagnetId={props.leadMagnetId}
          draftVersionId={props.draftVersionId}
          channels={props.channels}
          published={props.published}
          connectInline
        />
        <WebLinkSection published={props.published} webLink={props.webLink} />
        {props.published ? (
          <UnpublishForm key={`unpublish-${attempt}`} leadMagnetId={props.leadMagnetId} />
        ) : publishedWhileOpen ? (
          <Alert variant="success" title="Снято с публикации" className="mt-[var(--yk-space-4)]">
            Ссылки больше не запускают лидмагнит. Начатые разговоры доиграют.
          </Alert>
        ) : null}
      </Dialog>
    </>
  );
}

/** Ссылка на веб-версию в окне: до публикации — подсказка, после — адрес с кнопкой «Копировать» (появляется сразу после «Опубликовать»). */
function WebLinkSection({ published, webLink }: { published: boolean; webLink: string | null }) {
  return (
    <div className="mt-[var(--yk-space-4)] flex flex-col gap-1" data-testid="card-web-link">
      <span className="text-[length:var(--yk-text-small-size)] font-semibold">{WEB_LABEL} · без входа и мессенджера</span>
      {published && webLink ? (
        <CopyableLink url={webLink} channel={WEB_LABEL} testId="card-entry-link-web" />
      ) : (
        <span className="app-muted text-[length:var(--yk-text-small-size)]">Ссылка появится после публикации</span>
      )}
    </div>
  );
}
