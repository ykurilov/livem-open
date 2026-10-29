import { RobotIcon as Bot } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { CHANNEL_LABELS, createBotServiceFromEnv, type BotSummary, type NoCodeMode } from "@/modules/channels";
import { DataTable, PageHeader, type DataTableColumn } from "@/ui";
import { ConnectBotForm } from "./connect-bot-form";

export const dynamic = "force-dynamic";

const AVAILABLE_CHANNELS = (["telegram", "vk", "max"] as const).map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] }));

const NO_CODE_LABELS: Record<NoCodeMode, string> = { nothing: "Ничего", default: "Лидмагнит по умолчанию", menu: "Меню" };

const columns: DataTableColumn<BotSummary>[] = [
  {
    key: "bot",
    header: "Бот",
    render: (bot) => (
      <div className="flex flex-col">
        <span className="font-semibold">{bot.title}</span>
        <span className="text-[var(--yk-muted)]">@{bot.username}</span>
      </div>
    ),
  },
  { key: "channel", header: "Мессенджер", render: (bot) => CHANNEL_LABELS[bot.channel] },
  {
    key: "status",
    header: "Статус",
    render: (bot) =>
      bot.status === "ok" ? (
        <Badge variant="success">Работает</Badge>
      ) : (
        <div className="flex flex-col items-start gap-1">
          <Badge variant="warm">Ошибка</Badge>
          {bot.statusError ? <span className="text-[var(--yk-muted)]">{bot.statusError}</span> : null}
        </div>
      ),
  },
  { key: "noCode", header: "Без кода", render: (bot) => NO_CODE_LABELS[bot.noCodeMode] },
  {
    key: "settings",
    header: "",
    align: "right",
    render: (bot) => (
      <Link href={`/bots/${bot.id}`} className="app-focus underline">
        Настроить
      </Link>
    ),
  },
];

export default async function Page() {
  const bots = await createBotServiceFromEnv().listBots();

  return (
    <>
      <PageHeader title="Боты" />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Card>
          <CardHeader>
            <CardTitle>Подключить бота</CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectBotForm channels={AVAILABLE_CHANNELS} />
          </CardContent>
        </Card>
        <DataTable columns={columns} rows={bots} rowKey={(bot) => bot.id} empty={{ icon: Bot, title: "Ботов пока нет", hint: "Подключите первого выше." }} />
      </div>
    </>
  );
}
