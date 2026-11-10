"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps } from "react";

/**
 * Полоска вверху окна, пока страница кабинета открывается: нажатие видно сразу, даже если страница считается несколько секунд.
 * Заглушка `loading.tsx` тут не подходит: она пересоздаёт страницу, и «Входящие» теряли набранный ответ.
 */
export function NavigationProgress({ active }: { active: boolean }) {
  return active ? <span aria-hidden className="app-navigation-progress" /> : null;
}

function LinkProgress() {
  return <NavigationProgress active={useLinkStatus().pending} />;
}

/** Ссылка кабинета с полоской перехода. */
export function PendingLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      {children}
      <LinkProgress />
    </Link>
  );
}
