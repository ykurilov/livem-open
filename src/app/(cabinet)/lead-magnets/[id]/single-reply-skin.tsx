"use client";

import type { ChatSkin } from "@ykurilov/agent-chat-react";
import { Children, isValidElement, type ReactNode } from "react";
import { keepLastReply } from "@/modules/consultant/single-reply";

/**
 * Скин, в котором ответ консультанта виден одним ответом, как его получит человек: текст до вызова инструмента
 * пропадает, когда после вызова пошёл новый текст. Вызовы инструментов остаются на месте.
 */
export function withSingleReply(skin: ChatSkin): ChatSkin {
  const kind = {
    textOf: (part: ReactNode) =>
      isValidElement<{ markdown: string }>(part) && part.type === skin.AgentText ? part.props.markdown : null,
    // Карточка видео и картинка архива — это вызовы show_video и show_image: хранилище ответа считает их вызовами
    // инструмента, и экран тоже
    isToolCall: (part: ReactNode) =>
      isValidElement<{ Component?: unknown }>(part) &&
      (part.props.Component === skin.ToolCallRow ||
        (skin.AgentVideo !== undefined && part.type === skin.AgentVideo) ||
        (skin.GeneratedImages !== undefined && part.type === skin.GeneratedImages)),
  };
  const SingleReplyMessage: ChatSkin["AgentMessage"] = ({ children, ...props }) => (
    <skin.AgentMessage {...props}>{keepLastReply(Children.toArray(children), kind)}</skin.AgentMessage>
  );
  return { ...skin, AgentMessage: SingleReplyMessage };
}
