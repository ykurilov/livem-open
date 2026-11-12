"use client";

import { FlowLabelsProvider, FlowTestChat, type FlowNoticeLines } from "@ykurilov/agent-chat-flows/react";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { oduvanchikFlowEditorSkin } from "@ykurilov/agent-chat-skin-oduvanchik/flows";
import { flowLabels } from "@/ui/flow-labels";
import { useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { leadMagnetFlowChecks } from "@/modules/flows/app-checks";
import { leadMagnetFlowCatalog } from "@/modules/flows/catalog";
import type { FieldDefinition } from "@/modules/people";
import type { LeadMagnetSettings } from "@/modules/lead-magnets";
import { removeSalesCardAction, saveFlowAction, saveSalesCardAction, saveSettingsAndFlowAction } from "../actions";
import { SalesCardsProvider, withSalesCards, type SalesCardsBoard } from "./sales-cards-board";
import { combineUnsavedEdits } from "./unsaved-edits";
import { previewFlowTestConnection } from "./flow-test-connection";

/** Перемотка часов тестового чата на доске: 15 минут, час, три часа (касания молчуну). */
const ADVANCE_STEPS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];

/** Доска с разделами заготовок эксперта: у этапа и общей шпаргалкой в обзоре. */
const boardSkin = withSalesCards(oduvanchikFlowEditorSkin);

export interface FlowTabProps {
  leadMagnetId: string;
  /** Версия черновика, с которой открыта доска: если черновик уже другой, сохранение ляжет поверх с предупреждением. */
  draftVersionId: string;
  /** Сценарий на доске, в том числе несохранённый: его хранит редактор, чтобы правка пережила переключение вкладок. */
  value: AgentFlow;
  /** Сценарий, как он лежит в черновике на сервере: от него доска считает «Сохранено» после возврата с другой вкладки. */
  savedValue: AgentFlow;
  onChange(flow: AgentFlow): void;
  fields: FieldDefinition[];
  /** Черновик правит конструктор — доска закрыта на правку. */
  locked: boolean;
  /** Настройки черновика, как они лежат на сервере: от них видно, меняли ли в форме основную инструкцию. */
  savedSettings: LeadMagnetSettings;
  /** Несохранённая правка «Настроек»: сохранится вместе с доской; `null` — правки нет. */
  unsavedSettings: LeadMagnetSettings | null;
  /** Сценарий сохранён новой версией `versionId`; `overwroteNewerDraft` — черновик успел измениться. */
  onSaved(result: { versionId: string; overwroteNewerDraft: boolean; flow: AgentFlow }): void;
  /** Экран чата «Проверки» для тестового чата рядом с доской. */
  renderChat(chatId: string, options: { noticeLines: FlowNoticeLines }): ReactNode;
  /** «Начать заново» в тестовом чате заменило разговор «Проверки»: страница перечитывает его статус. */
  onPreviewRestarted(): void;
  /** Заготовка сохранена или удалена новой версией черновика: страница перечитывает черновик. */
  onSalesCardsChanged(): void;
}

/** Итог сохранения для доски: тип `FlowSaveResult` SDK 0.52 наружу не отдаёт. */
type FlowSaveResult = Awaited<ReturnType<NonNullable<ComponentProps<typeof FlowTestChat>["onSave"]>>>;

/** Путь замечания сервера на доске: от корня сценария (`states[2].exits[0]`); замечание не про сценарий — без пути. */
function boardPath(path: string): string | undefined {
  if (path === "flow") return undefined;
  return path.startsWith("flow.") ? path.slice("flow.".length) : undefined;
}

/** Вкладка «Сценарий»: доска со ступенями разговора, переходами, днями и касаниями. Проверки те же, что на сервере. */
export function FlowTab({ leadMagnetId, draftVersionId, value, savedValue, onChange, fields, locked, savedSettings, unsavedSettings, onSaved, renderChat, onPreviewRestarted, onSalesCardsChanged }: FlowTabProps) {
  const catalog = useMemo(() => leadMagnetFlowCatalog(fields), [fields]);
  // Подключение живёт, пока открыт лидмагнит (оно помнит «первое открытие»), а экран чата и обновление берёт свежие
  const latest = useRef({ renderChat, onPreviewRestarted });
  latest.current = { renderChat, onPreviewRestarted };
  const testChat = useMemo(
    () =>
      previewFlowTestConnection({
        leadMagnetId,
        renderChat: (chatId, options) => latest.current.renderChat(chatId, options),
        onRestarted: () => latest.current.onPreviewRestarted(),
      }),
    [leadMagnetId],
  );

  // Отказ сервера — доске: она пишет «Не сохранено», а замечания ставит у нод и в «Проверить граф»
  const save = async (flow: AgentFlow): Promise<FlowSaveResult> => {
    let result: Awaited<ReturnType<typeof saveFlowAction>>;
    try {
      if (unsavedSettings) {
        const both = combineUnsavedEdits(savedSettings, unsavedSettings, flow);
        result = await saveSettingsAndFlowAction(leadMagnetId, both.settings, both.flow, draftVersionId);
      } else result = await saveFlowAction(leadMagnetId, flow, draftVersionId);
    } catch {
      return { ok: false, issues: [{ message: "Не сохранено: нет связи с сервером. Правка осталась на доске, попробуйте ещё раз." }] };
    }
    if (!result.ok) {
      const issues = result.issues.length > 0 ? result.issues : [{ path: "", message: result.error }];
      return { ok: false, issues: issues.map(({ path, message }) => ({ ...(boardPath(path) !== undefined && { path: boardPath(path) }), message })) };
    }
    onSaved({ ...result, flow });
    return { ok: true };
  };

  // Заготовки сохраняются сразу, мимо сохранения доски: видны до того, как страница перечитает черновик
  const [salesCards, setSalesCards] = useState({ from: savedSettings.salesCards, cards: savedSettings.salesCards ?? [] });
  if (salesCards.from !== savedSettings.salesCards) setSalesCards({ from: savedSettings.salesCards, cards: savedSettings.salesCards ?? [] });
  const salesCardsBoard: SalesCardsBoard = {
    cards: salesCards.cards,
    states: value.states.filter((state) => savedValue.states.some((saved) => saved.id === state.id)).map((state) => ({ id: state.id, title: state.title })),
    locked,
    save: async (input) => {
      const result = await saveSalesCardAction(leadMagnetId, input);
      if (result.ok) {
        const { card } = result;
        setSalesCards((current) => ({
          ...current,
          cards: current.cards.some((one) => one.id === card.id) ? current.cards.map((one) => (one.id === card.id ? card : one)) : [...current.cards, card],
        }));
        onSalesCardsChanged();
      }
      return result;
    },
    remove: async (id) => {
      const result = await removeSalesCardAction(leadMagnetId, id);
      if (result.ok) {
        setSalesCards((current) => ({ ...current, cards: current.cards.filter((card) => card.id !== id) }));
        onSalesCardsChanged();
      }
      return result;
    },
  };

  return (
    <FlowLabelsProvider labels={flowLabels}>
      <SalesCardsProvider value={salesCardsBoard}>
      {/* Пока конструктор правит черновик, доска только для просмотра: открыть ноды, проверить и прогнать можно */}
      <FlowTestChat
        testChat={testChat}
        advanceSteps={ADVANCE_STEPS}
        skin={boardSkin}
        value={value}
        savedValue={savedValue}
        onChange={onChange}
        onSave={save}
        readOnly={locked}
        catalog={catalog}
        checks={leadMagnetFlowChecks}
        // Над доской уже шапка страницы с названием: графу — всё место, панель и мини-карта по кнопке
        header="compact"
        inspector="collapsible"
        minimap="collapsed"
        fullscreen
        storageKey="livem:flow-board"
        // Корень доски берёт высоту родителя (SDK 0.52+): вкладка отдаёт ей всё место, без рамки и скруглений
        className="h-full min-h-0 flex-1 rounded-none border-0"
      />
      </SalesCardsProvider>
    </FlowLabelsProvider>
  );
}
