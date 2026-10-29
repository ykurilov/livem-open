import { notFound } from "next/navigation";
import { requireUser } from "@/modules/access";
import { getEditorServices } from "@/modules/editor";
import { getLeadMagnet, listVersions } from "@/modules/lead-magnets";
import { listFields } from "@/modules/people";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";
import { listImages } from "@/modules/images";
import { listVideos } from "@/modules/videos";
import { EditorLoader } from "./editor-loader";

export const dynamic = "force-dynamic";

export default async function LeadMagnetPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const { db } = getDatabase();
  const lead = isUuid(id) ? await getLeadMagnet(db, id) : null;
  if (!lead) notFound();

  const services = await getEditorServices();
  const [constructorChatId, previewChatId, versions, fields, videos, images] = await Promise.all([
    services.constructor.ensureChat(id),
    services.preview.ensurePreview(id),
    listVersions(db, id),
    listFields(db),
    listVideos(db),
    listImages(db),
  ]);
  const [status, constructorHasMessages] = await Promise.all([
    services.preview.status(id),
    services.constructor.hasMessages(constructorChatId),
  ]);

  return (
    <EditorLoader
      leadMagnetId={id}
      draft={lead.draft}
      draftVersionId={lead.draftVersionId}
      constructorChatId={constructorChatId}
      constructorHasMessages={constructorHasMessages}
      preview={status ?? { chatId: previewChatId, stageName: null, day: null, days: null, finished: false }}
      versions={versions.map((version) => ({
        id: version.id,
        source: version.source,
        createdAt: version.createdAt.toISOString(),
        name: version.settings.name,
      }))}
      fields={fields}
      videos={videos.map(({ id, title, description }) => ({ id, title, description }))}
      images={images.map(({ id, title, description }) => ({ id, title, description }))}
    />
  );
}
