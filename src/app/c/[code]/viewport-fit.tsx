"use client";

import { useChatViewport } from "@ykurilov/agent-chat-react";
import type { RefObject } from "react";

/**
 * Подгонка чата под видимую часть экрана (клавиатура телефона). Отдельный модуль: пакет чата тяжёлый, и страница грузит его
 * после показа ленты, а не до.
 */
export default function ViewportFit({ target }: { target: RefObject<HTMLElement | null> }) {
  useChatViewport(target);
  return null;
}
