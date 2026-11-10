"use client";

import { Button } from "@ykurilov/ds-react";
import { useEffect } from "react";

const RETRY_AFTER_MS = 60_000;

/** Предел открытий с адреса: в веб-приложении с экрана «Домой» обновить страницу нечем — повтор сам и кнопкой. */
export function TooManyAttempts() {
  useEffect(() => {
    const timer = setTimeout(() => window.location.reload(), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <main className="web-chat-notice">
      <p>Слишком много попыток открыть чат. Через минуту попробуем снова сами.</p>
      <Button type="button" onClick={() => window.location.reload()}>
        Попробовать снова
      </Button>
    </main>
  );
}
