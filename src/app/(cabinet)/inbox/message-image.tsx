"use client";
import { ImageIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { InboxImage } from "@/modules/inbox";

/** Картинка в переписке: превью ссылкой на полный размер. Файла нет или он не загрузился — подпись вместо сломанной картинки. */
export function MessageImage({ image, label, missingText }: { image: InboxImage; label: string; missingText: string }) {
  const [broken, setBroken] = useState(false);
  if (!image.url || broken) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--yk-muted)]">
        <ImageIcon size={14} aria-hidden /> {missingText}
      </span>
    );
  }
  return (
    <a href={image.url} target="_blank" rel="noreferrer" className="app-focus block w-fit max-w-full" aria-label={`${label} — открыть крупно`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- картинку отдаёт наш адрес кабинета, оптимизатор не нужен */}
      <img
        src={image.url}
        alt={label}
        loading="lazy"
        onError={() => setBroken(true)}
        className="max-h-64 max-w-full rounded-[var(--yk-radius-2)] border border-[var(--yk-border)] object-contain"
      />
    </a>
  );
}
