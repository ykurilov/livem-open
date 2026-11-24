/**
 * Расход ИИ в таблице источников — с одной точностью на всю колонку, чтобы суммы читались столбиком:
 * есть хоть одна сумма меньше доллара — три знака у всех, иначе два.
 */
export function sourcesCostFormatter(costs: number[]): (usd: number) => string {
  const digits = costs.some((usd) => usd > 0 && usd < 1) ? 3 : 2;
  return (usd) => `$${usd.toFixed(digits)}`;
}
