import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { ChatSkin } from "@ykurilov/agent-chat-react";
import { withSingleReply } from "./single-reply-skin";

const AgentText = (_: { markdown: string }) => null;
const AgentVideo = (_: { title: string }) => null;
const GeneratedImages = (_: { title: string }) => null;
const AgentMessage = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
const skin = { AgentText, AgentVideo, GeneratedImages, AgentMessage, ToolCallRow: () => null } as unknown as ChatSkin;

/** Что останется в сообщении «Проверки» после обёртки. */
function shown(parts: ReactElement[]): string[] {
  const Message = withSingleReply(skin).AgentMessage as (props: { children: ReactNode }) => ReactElement<{ children: ReactNode }>;
  const message = Message({ children: parts });
  return Children.toArray(message.props.children).flatMap((part) =>
    isValidElement<{ markdown?: string; title?: string }>(part) ? [part.props.markdown ?? `▶ ${part.props.title}`] : [],
  );
}

describe("один ответ в «Проверке»", () => {
  it("текст до карточки видео — как текст до вызова инструмента: человек его не получит, и в «Проверке» его нет", () => {
    const parts = [
      createElement(AgentText, { key: "1", markdown: "Сейчас покажу." }),
      createElement(AgentVideo, { key: "2", title: "Промпты" }),
      createElement(AgentText, { key: "3", markdown: "Посмотрите ролик." }),
    ];
    expect(shown(parts)).toEqual(["▶ Промпты", "Посмотрите ролик."]);
  });

  it("картинка из архива — тоже вызов инструмента: текст до неё человек не получит, в «Проверке» его нет", () => {
    const parts = [
      createElement(AgentText, { key: "1", markdown: "Сейчас покажу." }),
      createElement(GeneratedImages, { key: "2", title: "Готовое приложение" }),
      createElement(AgentText, { key: "3", markdown: "Нажмите на него." }),
    ];
    expect(shown(parts)).toEqual(["▶ Готовое приложение", "Нажмите на него."]);
  });
});
