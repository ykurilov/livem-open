import { CalendarBlankIcon as CalendarBlank } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { requireUser } from "@/modules/access";
import { callCancelledByExpertText, listCallBookings, listCallNoticeBots, readCallCalendar, slotLabel, type CallBookingListRow } from "@/modules/booking";
import { CHANNEL_LABELS, type ChannelKind } from "@/modules/channels";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { CALLS_TABS, DataTable, PageHeader, SectionTabs, type DataTableColumn } from "@/ui";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives";
import { CancelCallButton, NoticeBots } from "./call-booking-controls";

export const dynamic = "force-dynamic";

type Row = CallBookingListRow & { when: string; upcoming: boolean; defaultCancelMessage: string };

function statusOf(row: Row) {
  if (row.status === "booked" && row.reminderFailure)
    return (
      <span className="flex flex-col items-start gap-1">
        {row.upcoming ? <Badge variant="success">записан</Badge> : <Badge>созвон прошёл</Badge>}
        <Badge variant="warm">напоминание не дошло</Badge>
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{row.reminderFailure}</span>
      </span>
    );
  if (row.status === "booked") return row.upcoming ? <Badge variant="success">записан</Badge> : <Badge>созвон прошёл</Badge>;
  if (row.status === "rescheduled") return <Badge>перенёс</Badge>;
  if (row.cancelledBy === "expert" && row.cancelMessageFailure)
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge variant="warm">отменили вы</Badge>
        <Badge variant="warm">сообщение об отмене не дошло</Badge>
        <span className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">{row.cancelMessageFailure}</span>
      </span>
    );
  return <Badge variant="warm">{row.cancelledBy === "expert" ? "отменили вы" : "отменил"}</Badge>;
}

const columns: DataTableColumn<Row>[] = [
  { key: "when", header: "Когда", render: (row) => <span className="tabular-nums">{row.when}</span> },
  {
    key: "person",
    header: "Кто",
    cardLine: "plain",
    render: (row) => (row.personId ? <Link href={`/people/${row.personId}`}>{row.personName ?? "Человек"}</Link> : (row.personName ?? "Человек")),
  },
  { key: "leadMagnet", header: "Лидмагнит", cardLine: "labeled", render: (row) => row.leadMagnetName ?? "—" },
  { key: "status", header: "Статус", cardLine: "plain", render: statusOf },
  {
    key: "actions",
    header: "",
    align: "right",
    render: (row) =>
      row.status === "booked" && row.upcoming ? (
        <CancelCallButton bookingId={row.id} label={`${row.when} — ${row.personName ?? "человек"}`} defaultMessage={row.defaultCancelMessage} />
      )  : null,
  },
];

export default async function Page() {
  await requireUser();
  const { db } = getDatabase();
  const now = systemClock.now();
  const [bookings, calendar, bots] = await Promise.all([listCallBookings(db, { now }), readCallCalendar(db), listCallNoticeBots(db)]);
  // Сначала ближайшие будущие, прошедшие — ниже, свежие сверху
  const rows: Row[] = bookings.map((booking) => ({
    ...booking,
    when: slotLabel(booking, calendar.timeZone),
    upcoming: booking.endsAt > now,
    defaultCancelMessage: callCancelledByExpertText(booking, calendar.timeZone),
  }));
  const ordered = [...rows.filter((row) => row.upcoming), ...rows.filter((row) => !row.upcoming).reverse()];

  return (
    <>
      <PageHeader title="Созвоны" tabs={<SectionTabs label="Разделы «Созвоны»" tabs={CALLS_TABS} />} />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <DataTable
          columns={columns}
          rows={ordered}
          rowKey={(row) => row.id}
          empty={{ icon: CalendarBlank, title: "Записей пока нет", hint: "Их делает консультант, когда в лидмагните включена «Запись на созвон» и в календаре есть окна." }}
        />
        <Card data-testid="call-notices">
          <CardHeader>
            <CardTitle>Уведомлять о записи</CardTitle>
            <CardDescription>Бот пришлёт вам новую запись, перенос или отмену. Подключите бота, в котором вы сами есть.</CardDescription>
          </CardHeader>
          <CardContent>
            {bots.length === 0 ? (
              <p className="app-muted">
                Ботов пока нет. <Link href="/bots">Подключите бота</Link> в Telegram, ВКонтакте или Max.
              </p>
            ) : (
              <NoticeBots
                bots={bots.map((bot) => ({
                  botId: bot.botId,
                  name: `${CHANNEL_LABELS[bot.channel as ChannelKind] ?? bot.channel}: ${bot.title}${bot.username ? ` (@${bot.username})` : ""}`,
                  state: bot.state,
                  failure: bot.failure,
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
