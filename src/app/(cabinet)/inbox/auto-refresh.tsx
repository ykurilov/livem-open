"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Как часто «Входящие» перечитывают список, переписку и счётчик, пока вкладка на экране. */
export const INBOX_REFRESH_MS = 15_000;

/**
 * «Входящие» обновляются сами: новое сообщение и счётчик видны без перезагрузки. Страница перечитывается на месте —
 * набранный ответ и прокрутка остаются. Скрытая вкладка не опрашивает, а при возврате обновляется сразу.
 */
export function InboxAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, INBOX_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
