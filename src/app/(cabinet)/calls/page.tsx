import Link from "next/link";
import { requireUser } from "@/modules/access";
import { readCallCalendarWeek, timeZoneOffsetLabel } from "@/modules/booking";
import { localDate } from "@/modules/program/calendar";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { CALLS_TABS, PageHeader, SectionTabs } from "@/ui";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives";
import { CalendarSettingsForm, DeleteWindowButton, WindowDialog } from "./calendar-forms";

export const dynamic = "force-dynamic";

/** Все пояса с текущим смещением: «Europe/Moscow (UTC+3)». */
function timeZoneOptions(current: string, now: Date) {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add(current);
  return [...zones].map((zone) => ({ value: zone, label: `${zone.replaceAll("_", " ")} (${timeZoneOffsetLabel(zone, now)})` }));
}

export default async function Page({ searchParams }: { searchParams: Promise<{ week?: string | string[] }> }) {
  await requireUser();
  const { week } = await searchParams;
  const now = systemClock.now();
  const calendar = await readCallCalendarWeek(getDatabase().db, { now, ...(typeof week === "string" && { week }) });
  const today = localDate(now, calendar.timeZone);
  const hasWindows = calendar.days.some((day) => day.windows.length > 0);

  return (
    <>
      <PageHeader title="Созвоны" tabs={<SectionTabs label="Разделы «Созвоны»" tabs={CALLS_TABS} />} />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Card>
          <CardHeader>
            <CardTitle>Неделя</CardTitle>
            <CardDescription>
              Окна — время, когда вы готовы созваниваться. Консультант режет их на созвоны по {calendar.callMinutes} минут и предлагает людям ближайшие
              свободные. Время — по поясу {calendar.timeZone.replaceAll("_", " ")} ({calendar.offset}).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
            <nav aria-label="Недели" className="flex flex-wrap items-center gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link href={`/calls?week=${calendar.previousWeek}`}>← Раньше</Link>
              </Button>
              <Button asChild variant="secondary" size="sm">
                <Link href="/calls">Эта неделя</Link>
              </Button>
              <Button asChild variant="secondary" size="sm">
                <Link href={`/calls?week=${calendar.nextWeek}`}>Позже →</Link>
              </Button>
              <span className="app-muted">
                {calendar.days[0]!.label} — {calendar.days[6]!.label}
              </span>
            </nav>
            {!hasWindows ? <p className="app-muted">На этой неделе окон нет — консультанту нечего предложить. Добавьте окно в нужный день.</p> : null}
            <ol className="grid gap-[var(--yk-space-3)] sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" data-testid="call-week">
              {calendar.days.map((day) => (
                <li
                  key={day.date}
                  data-testid={`call-day-${day.date}`}
                  className={`flex min-w-0 flex-col gap-2 rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] p-[var(--yk-space-3)] ${day.past ? "opacity-60" : ""}`}
                >
                  <div className={day.date === today ? "font-semibold" : ""}>
                    {day.label}
                    {day.date === today ? " · сегодня" : ""}
                  </div>
                  {day.windows.map((window) => (
                    <div key={`${window.id}-${day.date}`} className="flex flex-col gap-1 rounded-[var(--yk-radius-sm)] bg-[var(--yk-surface-2)] p-2">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="whitespace-nowrap font-semibold tabular-nums">{window.time}</span>
                        <span className="flex">
                          <WindowDialog window={window} defaultDate={day.date} label={`Изменить окно ${day.label}, ${window.time}`} />
                          <DeleteWindowButton windowId={window.id} weekly={window.weekly} label={`Удалить окно ${day.label}, ${window.time}`} />
                        </span>
                      </div>
                      {window.weekly ? <span className="app-muted">каждую неделю</span> : null}
                    </div>
                  ))}
                  {day.bookings.map((booking) => (
                    <div key={booking.id} className="app-muted">
                      <span className="tabular-nums">{booking.time}</span>{" "}
                      {booking.personId ? <Link href={`/people/${booking.personId}`}>{booking.personName ?? "Человек"}</Link> : (booking.personName ?? "Человек")}
                    </div>
                  ))}
                  {!day.past ? <WindowDialog defaultDate={day.date} label="Добавить окно" /> : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Пояс и длительность</CardTitle>
          </CardHeader>
          <CardContent>
            <CalendarSettingsForm timeZone={calendar.timeZone} callMinutes={calendar.callMinutes} timeZones={timeZoneOptions(calendar.timeZone, now)} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
