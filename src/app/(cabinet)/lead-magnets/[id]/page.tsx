import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/access";
import { getEditorServices } from "@/modules/editor";
import { getLeadMagnet, listVersionSummaries } from "@/modules/lead-magnets";
import { countPending } from "@/modules/corrections";
import { listFields } from "@/modules/people";
import { getDatabase } from "@/modules/platform/db";
import { isUuid } from "@/modules/platform/uuid";
import { listImages } from "@/modules/images";
import { listKnowledgeBases } from "@/modules/knowledge";
import { listVideos } from "@/modules/videos";
import { voiceConfigured } from "@/modules/voice/relay-options";
import { CONSTRUCTOR_PANEL_COOKIE } from "./constructor-panel-cookie";
import { ROLE_SWAP_MODE_COOKIE } from "./role-swap-cookie";
import { EditorLoader } from "./editor-loader";

export const dynamic = "force-dynamic";

export default async function LeadMagnetPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const { db } = getDatabase();
  const lead = isUuid(id) ? await getLeadMagnet(db, id) : null;
  if (!lead) notFound();

  const services = await getEditorServices();
  // Чаты обычно уже есть: тогда лидмагнит заново не читается
  const [constructorChatId, previewChatId, versions, fields, videos, images, knowledge] = await Promise.all([
    lead.constructorChatId ?? services.constructor.ensureChat(id),
    lead.previewChatId ?? services.preview.ensurePreview(id),
    listVersionSummaries(db, id),
    listFields(db),
    listVideos(db),
    listImages(db),
    listKnowledgeBases(db),
  ]);
  const [status, constructorHasMessages, pendingCorrections, roleSwap] = await Promise.all([
    services.preview.status(id),
    services.constructor.hasMessages(constructorChatId),
    countPending(db, id),
    services.roleSwap.current(id),
  ]);

  // Сервер не знает ширину окна, но телефон видно по заголовкам: ему вкладки рисуются в узком виде с первого кадра
  const requestHeaders = await headers();
  const onPhone = requestHeaders.get("sec-ch-ua-mobile") === "?1" || /iPhone|iPod|Android.+Mobile/i.test(requestHeaders.get("user-agent") ?? "");

  const cookieStore = await cookies();
  return (
    <EditorLoader
      onPhone={onPhone}
      constructorPanelOpen={cookieStore.get(CONSTRUCTOR_PANEL_COOKIE)?.value === "1"}
      roleSwapMode={cookieStore.get(ROLE_SWAP_MODE_COOKIE)?.value === "1"}
      roleSwap={roleSwap}
      leadMagnetId={id}
      draft={lead.draft}
      draftVersionId={lead.draftVersionId}
      constructorChatId={constructorChatId}
      constructorHasMessages={constructorHasMessages}
      preview={status ?? { chatId: previewChatId, stageName: null, day: null, days: null, finished: false }}
      versions={versions.map((version) => ({ ...version, createdAt: version.createdAt.toISOString() }))}
      fields={fields}
      videos={videos.map(({ id, title, description }) => ({ id, title, description }))}
      images={images.map(({ id, title, description }) => ({ id, title, description }))}
      knowledge={knowledge.map(({ id, title, charCount }) => ({ id, title, charCount }))}
      modelMenu={services.constructor.modelMenu()}
      pendingCorrections={pendingCorrections}
      voiceAvailable={voiceConfigured()}
    />
  );
}
