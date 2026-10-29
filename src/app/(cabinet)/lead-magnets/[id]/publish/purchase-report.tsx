import { Stat, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import type { PurchaseReport } from "@/modules/purchases/report";
import { formatMoney } from "@/modules/purchases/money";

function Figure({ value, label, testId }: { value: string; label: string; testId: string }) {
  return <Stat value={value} label={label} data-testid={testId} />;
}

/** Отчёт «Покупки»: сколько людей лидмагнита оформили заказ продукта, сколько оплатили и на какую сумму. */
export function PurchaseReportCard({ report }: { report: PurchaseReport }) {
  return (
    <Card data-testid="purchase-report">
      <CardHeader>
        <CardTitle>Покупки</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Figure value={String(report.ordered)} label="оформили заказ" testId="purchase-ordered" />
          <Figure value={String(report.paid)} label="оплатили" testId="purchase-paid" />
          <Figure
            value={report.paidByCurrency.length ? report.paidByCurrency.map((sum) => formatMoney(sum.amount, sum.currency)).join(" + ") : formatMoney(0, null)}
            label="сумма оплат без возвратов"
            testId="purchase-sum"
          />
        </div>
        <p className="text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">
          Вернули: {report.refunded}. Пообещали оплатить: {report.promised}. Заказы приходят из GetCourse; заказ без личной метки в ссылке попадает сюда, когда человек назовёт почту, с
          которой платил.
        </p>
      </CardContent>
    </Card>
  );
}
