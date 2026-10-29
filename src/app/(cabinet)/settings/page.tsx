import { Alert, Button, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { getChatStorage } from "@/modules/platform/chat-storage";
import { systemClock } from "@/modules/platform/clock";
import { getDatabase } from "@/modules/platform/db";
import { requireEnv } from "@/modules/platform/env";
import { readSettings } from "@/modules/platform/settings";
import { formatUsd, readSpendingOverview, type SpendingOverview } from "@/modules/spending";
import { PageHeader } from "@/ui";
import { acknowledgeOverrunAction } from "./actions";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

/** Сумма из базы без хвостовых нулей: «1.000000» → «1». */
const plainUsd = (value: string | null) => (value === null ? "" : String(Number(value)));

export default async function Page() {
  await requireUser();
  const { db } = getDatabase();
  const [settings, overview] = await Promise.all([
    readSettings(db),
    readSpendingOverview({ db, clock: systemClock, chatStorage: await getChatStorage(requireEnv("DATABASE_URL")) }),
  ]);

  return (
    <>
      <PageHeader title="Настройки" />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <Card>
          <CardHeader>
            <CardTitle>Расход за месяц</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
            <MonthSpending overview={overview} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Лимиты и тревоги</CardTitle>
          </CardHeader>
          <CardContent>
            <SettingsForm
              values={{
                dailyLimitUsd: plainUsd(settings.dailyLimitUsd),
                monthlyBudgetUsd: plainUsd(settings.monthlyBudgetUsd),
                privacyPolicyUrl: settings.privacyPolicyUrl ?? "",
                alertChatId: settings.alertChatId ?? "",
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function MonthSpending({ overview }: { overview: SpendingOverview }) {
  const { spentUsd, budgetUsd, share } = overview;
  return (
    <>
      <p data-testid="month-spending">
        {budgetUsd === null
          ? `${formatUsd(spentUsd)} — месячный бюджет не задан`
          : `${formatUsd(spentUsd)} из ${formatUsd(budgetUsd)} (${Math.round((share ?? 0) * 100)}%)`}
      </p>
      {overview.emergencyStopped ? (
        <Alert variant="danger" title="Аварийная остановка">
          Расход дошёл до двойного бюджета, консультант не отвечает людям. Ждут ответа: {overview.pausedPassages}. Поднимите
          бюджет — бот напишет им сам.
        </Alert>
      ) : null}
      {overview.overrunAwaitingAck ? (
        <Alert
          variant="warm"
          title="Бюджет израсходован"
          action={
            <form action={acknowledgeOverrunAction}>
              <Button type="submit" variant="secondary" size="sm">
                Вижу
              </Button>
            </form>
          }
        >
          Бот продолжает отвечать. Тревога повторяется раз в час, пока вы не нажмёте «Вижу» или не поднимете бюджет.
        </Alert>
      ) : null}
    </>
  );
}
