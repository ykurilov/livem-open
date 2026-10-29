"use client";

import { FlowLabelsProvider, FlowTestChat, type FlowNoticeLines } from "@ykurilov/agent-chat-flows/react";
import type { AgentFlow } from "@ykurilov/agent-chat-flows/format";
import { oduvanchikFlowEditorSkin } from "@ykurilov/agent-chat-skin-oduvanchik/flows";
import { flowLabels } from "@/ui/flow-labels";
import { useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { leadMagnetFlowChecks } from "@/modules/flows/app-checks";
import { leadMagnetFlowCatalog } from "@/modules/flows/catalog";
import type { FieldDefinition } from "@/modules/people";
import { saveFlowAction } from "../actions";
import { previewFlowTestConnection } from "./flow-test-connection";

/** Перемотка часов тестового чата на доске: 15 минут, час, три часа (касания молчуну). */
const ADVANCE_STEPS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];

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
  /** Черновик правит конструктор или «Настройки» ждут сохранения — доска закрыта на правку. */
  locked: boolean;
  /** Почему сохранение сейчас закрыто; `null` — открыто. */
  saveBlockedBecause: string | null;
  /** Сценарий сохранён новой версией `versionId`; `overwroteNewerDraft` — черновик успел измениться. */
  onSaved(result: { versionId: string; overwroteNewerDraft: boolean }): void;
  /** Экран чата «Проверки» для тестового чата рядом с доской. */
  renderChat(chatId: string, options: { noticeLines: FlowNoticeLines }): ReactNode;
  /** «Начать заново» в тестовом чате заменило разговор «Проверки»: страница перечитывает его статус. */
  onPreviewRestarted(): void;
}

/** Итог сохранения для доски: тип `FlowSaveResult` SDK 0.52 наружу не отдаёт. */
type FlowSaveResult = Awaited<ReturnType<NonNullable<ComponentProps<typeof FlowTestChat>["onSave"]>>>;

/** Путь замечания сервера на доске: от корня сценария (`states[2].exits[0]`); замечание не про сценарий — без пути. */
function boardPath(path: string): string | undefined {
  if (path === "flow") return undefined;
  return path.startsWith("flow.") ? path.slice("flow.".length) : undefined;
}

/** Вкладка «Сценарий»: доска со ступенями разговора, переходами, днями и касаниями. Проверки те же, что на сервере. */
export function FlowTab({ leadMagnetId, draftVersionId, value, savedValue, onChange, fields, locked, saveBlockedBecause, onSaved, renderChat, onPreviewRestarted }: FlowTabProps) {
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
    if (saveBlockedBecause) return { ok: false, issues: [{ message: saveBlockedBecause }] };
    const result = await saveFlowAction(leadMagnetId, flow, draftVersionId);
    if (!result.ok) {
      const issues = result.issues.length > 0 ? result.issues : [{ path: "", message: result.error }];
      return { ok: false, issues: issues.map(({ path, message }) => ({ ...(boardPath(path) !== undefined && { path: boardPath(path) }), message })) };
    }
    onSaved(result);
    return { ok: true };
  };

  return (
    <FlowLabelsProvider labels={flowLabels}>
      {/* Пока конструктор правит черновик, доска только для просмотра: открыть ноды, проверить и прогнать можно */}
      <FlowTestChat
        testChat={testChat}
        advanceSteps={ADVANCE_STEPS}
        skin={oduvanchikFlowEditorSkin}
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
    </FlowLabelsProvider>
  );
}
