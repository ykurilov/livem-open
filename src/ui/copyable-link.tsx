"use client";

import { CheckIcon as Check, CopyIcon as Copy } from "@phosphor-icons/react/dist/ssr";
import { useEffect, useState } from "react";
import { Button } from "./primitives";

/** Сколько держится «Скопировано», прежде чем кнопка снова зовёт копировать. */
const COPIED_MS = 2_000;

/**
 * Ссылка, которую эксперт раздаёт людям: адрес и «Копировать» рядом.
 * `channel` — для кого ссылка; входит в имя кнопки для экранного диктора, чтобы кнопки в списке различались.
 */
export function CopyableLink({ url, channel, testId }: { url: string; channel: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <a href={url} className="min-w-0 break-all text-[var(--yk-accent)] underline underline-offset-2 hover:no-underline" target="_blank" rel="noreferrer">
          <code className="select-all break-all" data-testid={testId}>
            {url}
          </code>
        </a>
        {/* Контур, а не серая заливка: в тёмной теме серая кнопка сливается с карточкой */}
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Скопировано" : "Копировать"}
          <span className="sr-only"> · {channel}</span>
        </Button>
      </span>
      {failed ? <span role="status">Не удалось скопировать. Выделите ссылку и скопируйте вручную.</span> : null}
    </span>
  );
}
