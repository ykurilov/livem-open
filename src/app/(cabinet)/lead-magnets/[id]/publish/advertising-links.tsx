"use client";

import { useState } from "react";
import { Button } from "@/ui/primitives";

/** Примеры не создают записей: метка появится после первого старта человека в боте. */
export function AdvertisingLinks({ examples }: { examples: Array<{ channel: string; url: string }> }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function copy(channel: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(channel);
      setError(false);
    } catch {
      setError(true);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-[length:var(--yk-text-small-size)]">
      <p>
        Рекламщик может вписать метку в ссылку без доступа к приложению. Замените <code>video_01</code> своим названием
        объявления: 1–41 символ, латинские буквы, цифры, <code>_</code> и <code>-</code>. Код и часть <code>__ad_campaign__</code> сохраняйте.
      </p>
      <p>
        Регистр метки не различается: <code>Video_01</code> и <code>video_01</code> попадут в одну строку.
        Для разных объявлений используйте разные метки; для сравнения каналов добавьте канал в название.
      </p>
      <ul aria-label="Примеры рекламных ссылок" className="flex flex-col gap-3">
        {examples.map(({ channel, url }) => (
          <li key={channel} className="flex flex-col gap-1">
            <span className="font-semibold">{channel}</span>
            <code className="select-all break-all">{url}</code>
            <Button type="button" variant="secondary" size="sm" className="w-fit" onClick={() => copy(channel, url)}>
              {copied === channel ? "Скопировано" : `Копировать · ${channel}`}
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p role="status">Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.</p> : null}
      <p className="text-[var(--yk-muted)]">
        Метка появится в отчёте и фильтре «Базы» после начала разговора, а не после открытия ссылки.
        Повторный запуск по рекламной ссылке сохраняет источник первого входа. В Telegram и MAX человек запускает бота,
        в VK — отправляет сообщение. Обычные utm-параметры здесь не работают.
      </p>
    </div>
  );
}
