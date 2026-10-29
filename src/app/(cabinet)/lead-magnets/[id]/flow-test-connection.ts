import type { FlowNoticeLines, FlowTestChatConnection } from "@ykurilov/agent-chat-flows/react";
import type { ReactNode } from "react";

const PREVIEW_API = "/api/preview";

async function post<Result>(path: string, body: unknown): Promise<Result> {
  const response = await fetch(`${PREVIEW_API}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: { kind?: string; message?: string } } | null;
    // Код нужен доске: «впереди ничего нет» — не поломка, а подсказка
    throw Object.assign(new Error(failure?.error?.message ?? `Не получилось (${response.status})`), { code: failure?.error?.kind });
  }
  return (await response.json()) as Result;
}

/**
 * Тестовый чат доски — тот же разговор «Проверки» лидмагнита: первое открытие берёт идущий разговор, «Начать заново»
 * затирает его и заводит новый (после чего страница перечитывает статус). Права и отказы — на сервере.
 */
export function previewFlowTestConnection(input: {
  leadMagnetId: string;
  renderChat(chatId: string, options: { noticeLines: FlowNoticeLines }): ReactNode;
  onRestarted(): void;
}): FlowTestChatConnection {
  let opened = false;
  return {
    async start() {
      const restart = opened;
      opened = true;
      const result = await post<{ chatId: string }>("flow-test/start", { leadMagnetId: input.leadMagnetId, ...(restart && { restart: true }) });
      if (restart) input.onRestarted();
      return result;
    },
    // Пояс браузера: по нему дни тестового разговора, если эксперт ещё не писал
    advance: (chatId, ms) => post(`${chatId}/flow-test/advance`, { ms, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    advanceToNextDay: (chatId) =>
      post(`${chatId}/flow-test/advance`, { to: "next_day_start", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    advanceToNextFirstMessage: (chatId) =>
      post(`${chatId}/flow-test/advance`, { to: "next_first_message", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    readRun: async (chatId) => (await post<{ run: Awaited<ReturnType<FlowTestChatConnection["readRun"]>> }>(`${chatId}/flow-test/run`, {})).run,
    renderChat: input.renderChat,
  };
}
