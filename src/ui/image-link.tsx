import { ImageIcon } from "@phosphor-icons/react/dist/ssr";

/** Картинка, которую показал консультант: превью и название ссылкой на полный размер. */
export function ImageLink({ image }: { image: { title: string; url: string } }) {
  return (
    <a href={image.url} target="_blank" rel="noreferrer" className="app-focus flex w-fit flex-col gap-1 font-semibold underline">
      {/* eslint-disable-next-line @next/next/no-img-element -- файл архива отдаёт наш адрес, оптимизатор не нужен */}
      <img src={image.url} alt={image.title} loading="lazy" className="max-h-48 w-auto rounded-[var(--yk-radius-2)] border border-[var(--yk-border)]" />
      <span className="inline-flex items-center gap-1">
        <ImageIcon size={14} aria-hidden /> {image.title}
      </span>
    </a>
  );
}
