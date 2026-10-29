import { ImageIcon } from "@phosphor-icons/react/dist/ssr";
import { requireUser } from "@/modules/access";
import { imageUrl, listImages, type ExpertImage } from "@/modules/images";
import { getDatabase } from "@/modules/platform/db";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import { AddImageButton, ImageActions } from "./image-dialogs";

export const dynamic = "force-dynamic";

const columns: DataTableColumn<ExpertImage>[] = [
  {
    key: "title",
    header: "Картинка",
    render: (image) => (
      <div className="flex items-start gap-[var(--yk-space-4)]">
        <a href={imageUrl(image.fileName)} target="_blank" rel="noreferrer" className="app-focus shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- файл архива отдаёт наш адрес, оптимизатор не нужен */}
          <img src={imageUrl(image.fileName)} alt="" loading="lazy" className="h-16 w-24 rounded-[var(--yk-radius-lg)] border border-[var(--yk-border)] object-cover" />
        </a>
        <div className="flex flex-col">
          <a href={imageUrl(image.fileName)} target="_blank" rel="noreferrer" className="app-focus w-fit font-semibold underline">
            {image.title}
          </a>
          <span className="text-[var(--yk-muted)]">{image.description}</span>
        </div>
      </div>
    ),
  },
  { key: "size", header: "Размер", render: (image) => `${image.width} × ${image.height}` },
  { key: "actions", header: "", align: "right", render: (image) => <ImageActions image={image} /> },
];

export default async function Page() {
  await requireUser();
  const images = await listImages(getDatabase().db);
  return (
    <>
      <PageHeader title="Картинки" action={<AddImageButton />} />
      <DataTable
        columns={columns}
        rows={images}
        rowKey={(image) => image.id}
        empty={{ icon: ImageIcon, title: "Картинок пока нет", hint: "Нажмите «Добавить картинку»: например, скриншот «куда нажать»." }}
      />
    </>
  );
}
