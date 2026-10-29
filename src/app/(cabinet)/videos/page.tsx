import { FilmSlateIcon as Clapperboard } from "@phosphor-icons/react/dist/ssr";
import { timeLabel } from "@ykurilov/agent-chat-videos";
import { requireUser } from "@/modules/access";
import { getDatabase } from "@/modules/platform/db";
import { listVideos, type Video } from "@/modules/videos";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import { AddVideoButton, VideoActions } from "./video-dialogs";

export const dynamic = "force-dynamic";

const columns: DataTableColumn<Video>[] = [
  {
    key: "title",
    header: "Ролик",
    render: (video) => (
      <div className="flex flex-col">
        <a href={video.url} target="_blank" rel="noreferrer" className="app-focus w-fit font-semibold underline">
          {video.title}
        </a>
        <span className="text-[var(--yk-muted)]">{video.description}</span>
      </div>
    ),
  },
  {
    key: "duration",
    header: "Длительность",
    render: (video) => (
      <div className="flex flex-col">
        <span>{video.durationSeconds ? timeLabel(video.durationSeconds) : "—"}</span>
        {video.chapters.length > 0 ? <span className="text-[var(--yk-muted)]">глав: {video.chapters.length}</span> : null}
      </div>
    ),
  },
  { key: "actions", header: "", align: "right", render: (video) => <VideoActions video={video} /> },
];

export default async function Page() {
  await requireUser();
  const videos = await listVideos(getDatabase().db);
  return (
    <>
      <PageHeader
        title="Видео"
        action={<AddVideoButton />}
      />
      <DataTable columns={columns} rows={videos} rowKey={(video) => video.id} empty={{ icon: Clapperboard, title: "Роликов пока нет", hint: "Нажмите «Добавить ролик»." }} />
    </>
  );
}
