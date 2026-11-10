"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Как часто страница идущей рассылки перечитывает итог. */
const SENDING_REFRESH_MS = 3_000;

/** Пока рассылка уходит, страница сама показывает, скольким ушло: без ручного обновления. */
export function RefreshWhileSending() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, SENDING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
