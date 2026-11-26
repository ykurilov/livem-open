"use client";

import { Button as DesignButton } from "@ykurilov/ds-react";
import {
  ArrowCounterClockwiseIcon,
  ChatCircleTextIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  ListBulletsIcon,
  RocketLaunchIcon,
  SidebarSimpleIcon,
  TreeStructureIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/ui";
import { cn } from "@/ui/primitives";

const EDITOR_TABS: { value: string; label: string; icon: Icon }[] = [
  { value: "preview", label: "Разговор", icon: ChatCircleTextIcon },
  { value: "flow", label: "Сценарий", icon: TreeStructureIcon },
  { value: "settings", label: "Настройки", icon: GearSixIcon },
  { value: "history", label: "История", icon: ClockCounterClockwiseIcon },
  { value: "log", label: "Лог", icon: ListBulletsIcon },
];

/** «Начать заново» тестового разговора: есть только на «Разговоре», когда разговор уже идёт. */
export interface EditorRestart {
  onRestart(): void;
  restarting?: boolean;
  disabled?: boolean;
}

/**
 * Левая часть общей строки над колонками: название, вкладки, «Начать заново», «Публикация» и кнопка конструктора, пока он закрыт.
 * Правая часть строки — шапка самого конструктора (constructor-chats.tsx), той же высоты.
 * Вкладки и кнопки сжимаются по ширине самой полосы (globals.css, `.editor-bar`): тесно — остаются значки с подсказкой.
 */
export function EditorHeader({
  name,
  leadMagnetId,
  constructorOpen,
  onOpenConstructor,
  compact,
  restart,
  children,
}: {
  name: string;
  leadMagnetId: string;
  constructorOpen: boolean;
  onOpenConstructor(): void;
  /** На доске «Сценария» полоса ниже и с полями по краям. */
  compact: boolean;
  restart?: EditorRestart | null;
  children?: ReactNode;
}) {
  return (
    <header
      data-constructor={constructorOpen ? "open" : "closed"}
      data-restart={restart ? "" : undefined}
      className={cn("editor-bar flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 lg:flex-nowrap", compact && "px-3 py-1.5")}>
      {/* На телефоне название — своя строка, под ним «Публикация» и «Конструктор» по краям одного ряда, ниже вкладки */}
      <h1 className="min-w-0 flex-1 truncate text-[length:var(--yk-text-body-size)] font-semibold max-lg:basis-full" title={name}>
        {name}
      </h1>
      {children}
      {/* На узком экране вкладки — своя строка во всю ширину, в один ряд */}
      <TabsList className="editor-tabs shrink-0 max-lg:order-last max-lg:flex max-lg:w-full max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:[scrollbar-width:none]">
        {EDITOR_TABS.map(({ value, label, icon: TabIcon }) => (
          <TabsTrigger key={value} value={value} aria-label={label} title={label}>
            <TabIcon aria-hidden size={16} className="editor-bar__icon shrink-0" />
            <span className="editor-bar__label">{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {restart ? (
        // Перезапуск нужен и после правки в «Настройках» или «Сценарии»: проверка начнётся с сохранённого черновика
        <DesignButton
          variant="secondary"
          size="sm"
          icon={ArrowCounterClockwiseIcon}
          aria-label="Начать заново"
          title="Начать заново"
          loading={restart.restarting ?? false}
          disabled={restart.disabled ?? false}
          onClick={restart.onRestart}
          className="editor-bar__action editor-bar__restart shrink-0"
        >
          <span className="editor-bar__label">Начать заново</span>
        </DesignButton>
      ) : null}
      <DesignButton
        href={`/lead-magnets/${leadMagnetId}/publish`}
        variant="primary"
        size="sm"
        icon={RocketLaunchIcon}
        aria-label="Публикация"
        title="Публикация"
        className="editor-bar__action shrink-0"
      >
        <span className="editor-bar__label">Публикация</span>
      </DesignButton>
      {!constructorOpen && (
        <DesignButton
          variant="secondary"
          size="sm"
          icon={SidebarSimpleIcon}
          aria-label="Конструктор"
          aria-expanded={false}
          aria-controls="constructor-panel"
          title="Показать конструктор"
          onClick={onOpenConstructor}
          className="editor-bar__action editor-bar__open-constructor shrink-0"
        >
          <span className="editor-bar__label">Конструктор</span>
        </DesignButton>
      )}
    </header>
  );
}
