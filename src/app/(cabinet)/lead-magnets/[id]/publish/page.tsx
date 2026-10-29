import { ChartBarIcon as BarChart3, RobotIcon as Bot } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS, createBotServiceFromEnv, createChannelAdapters, type ChannelKind } from "@/modules/channels";
import {
  describePublication,
  getLeadMagnet,
  leadMagnetReport,
  listLabeledLinks,
  programReport,
  type LinkReportRow,
  type StageStopRow,
} from "@/modules/lead-magnets";
import { planChatMigration } from "@/modules/flows";
import { getChatStorage } from "@/modules/platform/chat-storage";
import { getDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";
import { isUuid } from "@/modules/platform/uuid";
import { formatUsd } from "@/modules/spending";
import { DataTable, EmptyState, PageHeader, type DataTableColumn } from "@/ui";
import { ChatMigrationCard } from "./chat-migration";
import { ENTRY_LABEL_SEPARATOR } from "@/modules/lead-magnets/start-payload";
import { AdvertisingLinks } from "./advertising-links";
import { LabeledLinks } from "./labeled-links";
import { ProgramReportCard } from "./program-report";
import { PurchaseReportCard } from "./purchase-report";
import { purchaseReport } from "@/modules/purchases/report";
import { PublishForm, type ChannelChoice } from "./publish-form";
import { UnpublishForm } from "./unpublish-form";

export const dynamic = "force-dynamic";

// Мессенджеры, в которых можно опубликовать лидмагнит
const AVAILABLE_CHANNELS: ChannelKind[] = ["telegram", "vk", "max"];

export default async function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const { db } = getDatabase();
  const lead = isUuid(id) ? await getLeadMagnet(db, id) : null;
  if (!lead) notFound();

  const adapters = createChannelAdapters();
  const [publication, bots, labeledLinks, report, program, migration, purchases] = await Promise.all([
    describePublication(db, adapters, id),
    createBotServiceFromEnv().listBots(),
    listLabeledLinks(db, adapters, id),
    leadMagnetReport(db, id),
    programReport(db, await getChatStorage(requireEnv("DATABASE_URL")), id),
    planChatMigration(db, id),
    purchaseReport(db, id),
  ]);
  const published = publication.snapshotId !== null;
  const draftChanged = published && publication.snapshotId !== lead.draftVersionId;

  const channels: ChannelChoice[] = AVAILABLE_CHANNELS.map((channel) => ({
    channel,
    label: CHANNEL_LABELS[channel],
    bots: bots
      .filter((bot) => bot.channel === channel)
      .map((bot) => ({ value: bot.id, label: `${bot.title} (@${bot.username})` })),
    selected: publication.bots.find((bot) => bot.channel === channel)?.botId ?? null,
  }));

  return (
    <>
      <PageHeader title={`Публикация: ${lead.draft.name}`} />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Link href={`/lead-magnets/${id}`} className="app-focus w-fit text-[length:var(--yk-text-small-size)] underline">
          ← К редактору
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Боты
              {published ? <Badge variant="success">Опубликован</Badge> : <Badge variant="cool">Черновик</Badge>}
              {draftChanged ? <Badge variant="warm">Есть неопубликованные правки</Badge> : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {bots.length === 0 ? (
              <EmptyState
                icon={Bot}
                title="Ботов пока нет"
                hint="Подключите бота, затем вернитесь сюда."
                action={
                  <Button asChild variant="secondary" size="sm">
                    <Link href="/bots">Подключить бота</Link>
                  </Button>
                }
              />
            ) : (
              <PublishForm leadMagnetId={id} draftVersionId={lead.draftVersionId} channels={channels} published={published} />
            )}
            {published ? <UnpublishForm leadMagnetId={id} /> : null}
          </CardContent>
        </Card>
        {published && migration ? (
          <ChatMigrationCard
            leadMagnetId={id}
            view={{
              total: migration.total,
              pending: migration.pending,
              targets: migration.targets,
              groups: migration.groups.map((group) => ({ ...group, versionAt: group.versionAt.toISOString() })),
            }}
          />
        ) : null}
        {published ? (
          <Card>
            <CardHeader>
              <CardTitle>Ссылки</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-[length:var(--yk-text-small-size)]" aria-label="Ссылки на лидмагнит">
                {publication.bots.map((bot) => (
                  <li key={bot.botId} className="flex flex-col">
                    <span className="font-semibold">
                      {CHANNEL_LABELS[bot.channel]} · @{bot.username}
                    </span>
                    {bot.link ? (
                      <code className="select-all break-all" data-testid={`entry-link-${bot.channel}`}>
                        {bot.link}
                      </code>
                    ) : (
                      <span>Ссылка появится после подключения мессенджера</span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
        {published ? (
          <Card>
            <CardHeader>
              <CardTitle>Ссылки с метками</CardTitle>
            </CardHeader>
            <CardContent>
              {publication.code ? (
                <AdvertisingLinks
                  examples={publication.bots.flatMap((bot) => {
                    const adapter = adapters[bot.channel];
                    return adapter ? [{
                      channel: CHANNEL_LABELS[bot.channel],
                      url: adapter.entryLink(bot, `${publication.code}${ENTRY_LABEL_SEPARATOR}video_01`),
                    }] : [];
                  })}
                />
              ) : null}
              <div className="mt-6">
                <LabeledLinks
                  leadMagnetId={id}
                  links={labeledLinks.map((link) => ({
                    id: link.id,
                    label: link.label,
                    hasPeople: link.hasPeople,
                    urls: link.urls.map((entry) => ({ ...entry, channelLabel: CHANNEL_LABELS[entry.channel] })),
                  }))}
                />
              </div>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Отчёт</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
            <DataTable
              columns={linkColumns}
              rows={report.byLink}
              rowKey={(row) => row.linkId ?? "without-link"}
              empty={{ icon: BarChart3, title: "Отчёта пока нет", hint: "Он появится после публикации." }}
            />
            {report.stoppedByStage.length > 0 ? (
              <>
                <span className="text-[length:var(--yk-text-small-size)] font-semibold">Где люди бросили разговор</span>
                <DataTable columns={stageColumns} rows={report.stoppedByStage} rowKey={(row) => row.stageId} />
              </>
            ) : null}
          </CardContent>
        </Card>
        {program ? <ProgramReportCard report={program} /> : null}
        {purchases ? <PurchaseReportCard report={purchases} /> : null}
      </div>
    </>
  );
}

const linkColumns: DataTableColumn<LinkReportRow>[] = [
  {
    key: "link",
    header: "Источник / объявление",
    render: (row) => (
      <span className="flex items-center gap-2">
        {row.isMain ? "Основная ссылка и меню бота" : (row.label ?? "Без ссылки (лидмагнит по умолчанию)")}
        {row.archived ? <Badge variant="neutral">В архиве</Badge> : null}
      </span>
    ),
  },
  { key: "arrived", header: "Начали разговор", align: "right", numeric: true, render: (row) => row.arrived },
  { key: "completed", header: "Завершило", align: "right", numeric: true, render: (row) => row.completed },
  { key: "cost", header: "Расход ИИ", align: "right", numeric: true, render: (row) => formatUsd(row.costUsd) },
];

const stageColumns: DataTableColumn<StageStopRow>[] = [
  { key: "stage", header: "Этап", render: (row) => row.name },
  { key: "stopped", header: "Остановились", align: "right", numeric: true, render: (row) => row.stopped },
];
