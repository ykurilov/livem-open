"use client";

import { ChatWorkspace, type ChatWorkspaceProps, type ChatWorkspaceView } from "@ykurilov/agent-chat-react";
import { oduvanchikSkin } from "@ykurilov/agent-chat-skin-oduvanchik";
import { CaretDownIcon, CaretUpIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { IconButton } from "@/ui/icon-button";
import { constructorChatsApi } from "@/modules/constructor/chats-api";

type ChatProps = Omit<ChatWorkspaceProps, "api" | "renderWorkspace" | "initialChatId">;

/**
 * Чаты эксперта с конструктором лидмагнита в узкой панели: в шапке — открытый чат, «Новый чат» и закрытие; список
 * (выбрать, переименовать, удалить) раскрывается на месте чата. Список и поведение — SDK, у каждого лидмагнита свой
 * адрес списка, поэтому и запомненный открытый чат у каждого свой.
 */
export function ConstructorChats({
  leadMagnetId,
  busy,
  onClose,
  ...chatProps
}: ChatProps & {
  leadMagnetId: string;
  /** Открытый чат ведёт ход: сменить чат или завести новый нельзя — замок черновика видит только открытый чат. */
  busy: boolean;
  onClose(): void;
}) {
  return (
    <ChatWorkspace
      {...chatProps}
      api={constructorChatsApi(leadMagnetId)}
      renderWorkspace={(view) => <ConstructorChatsFrame view={view} busy={busy} onClose={onClose} />}
    />
  );
}

function ConstructorChatsFrame({ view, busy, onClose }: { view: ChatWorkspaceView; busy: boolean; onClose(): void }) {
  const [listOpen, setListOpen] = useState(false);
  const { list } = view;
  // Ход начался при открытом списке (просьба из «Поменяемся ролями»): список прячется, видна идущая переписка
  const showList = listOpen && list !== undefined && !busy;
  const busyHint = busy ? "Дождитесь ответа конструктора" : undefined;
  const closeAfter = <T,>(action: (value: T) => void) => (value: T) => {
    action(value);
    setListOpen(false);
  };

  let listView: ReactNode = null;
  if (showList)
    listView = (
      <div className="oduvanchik-chat min-h-0 flex-1 overflow-y-auto pr-3">
        <oduvanchikSkin.ChatList {...list} onSelect={closeAfter(list.onSelect)} onCreate={() => closeAfter(list.onCreate)(undefined)} />
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center gap-1">
        <span className="shrink-0 font-semibold">Конструктор</span>
        {list ? (
          <>
            <button
              type="button"
              aria-label="Чаты конструктора"
              aria-expanded={showList}
              title={busyHint ?? view.activeTitle}
              disabled={busy}
              onClick={() => setListOpen(!showList)}
              className="ml-1 flex min-h-9 min-w-0 flex-1 items-center gap-1 rounded-[var(--yk-radius-md)] px-2 text-left text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)] enabled:hover:bg-[var(--yk-surface-2)] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[var(--yk-accent)]"
            >
              <span className="min-w-0 truncate">{view.activeTitle}</span>
              {showList ? <CaretUpIcon aria-hidden className="shrink-0" /> : <CaretDownIcon aria-hidden className="shrink-0" />}
            </button>
            <IconButton label="Новый чат с конструктором" icon={PlusIcon} size="sm" disabled={list.creating || busy} onClick={() => closeAfter(list.onCreate)(undefined)} />
          </>
        ) : (
          <span className="flex-1" />
        )}
        <IconButton label="Закрыть конструктор" icon={XIcon} size="sm" onClick={onClose} />
      </div>
      {listView}
      {/* Чат остаётся в странице и под списком: не теряет историю, начатый ход и набранный текст */}
      <div className={showList ? "hidden" : "min-h-0 flex-1"}>{view.children}</div>
    </div>
  );
}
