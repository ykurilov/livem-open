"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Насколько близко к низу ленты эксперт считается «внизу»: новое сообщение подтянет ленту к себе. */
const NEAR_BOTTOM_PX = 80;

/**
 * Лента переписки своей высоты: открывается на последнем сообщении, а поле ответа под ней остаётся на экране.
 * Страница сама обновляется — эксперт, читавший внизу, видит новое сообщение; листавший старое остаётся на месте.
 */
export function ThreadMessages({ personId, lastMessageId, children }: { personId: string; lastMessageId: string | null; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const openedFor = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (atBottom.current) element.scrollTop = element.scrollHeight;
    if (openedFor.current === personId) return;
    openedFor.current = personId;
    // Открыли переписку — на экране и последний вопрос, и поле ответа под ним
    element.closest("[data-inbox-thread]")?.scrollIntoView({ block: "nearest" });
  }, [personId, lastMessageId]);

  return (
    <div
      ref={list}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
      }}
      tabIndex={0}
      aria-label="Сообщения"
      className="app-focus -mx-2 flex max-h-[35dvh] flex-col gap-2 overflow-y-auto overscroll-contain px-2 lg:max-h-[45dvh]"
      data-testid="inbox-messages"
    >
      {children}
    </div>
  );
}
