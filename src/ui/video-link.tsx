import { PlayIcon } from "@phosphor-icons/react/dist/ssr";

/** Ролик, который прислал консультант: название ссылкой со значком воспроизведения и с какого места смотреть. */
export function VideoLink({ video }: { video: { title: string; url: string; startLabel?: string } }) {
  return (
    <span className="block">
      <a href={video.url} target="_blank" rel="noreferrer" className="app-focus inline-flex items-center gap-1 font-semibold underline">
        <PlayIcon size={14} aria-hidden /> {video.title}
      </a>
      {video.startLabel ? <span className="block text-[var(--yk-muted)]">с {video.startLabel}</span> : null}
    </span>
  );
}
