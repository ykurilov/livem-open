import type { UsageSum } from "@ykurilov/agent-chat-core";
import type { UsageTotals } from "./types";

export const NO_USAGE: UsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };

/** Сумма расхода по всем моделям. */
export function totalUsage(sums: Array<UsageSum | UsageTotals>): UsageTotals {
  return sums.reduce<UsageTotals>(
    (total, sum) => ({
      inputTokens: total.inputTokens + sum.inputTokens,
      cachedInputTokens: total.cachedInputTokens + sum.cachedInputTokens,
      outputTokens: total.outputTokens + sum.outputTokens,
      reasoningTokens: total.reasoningTokens + sum.reasoningTokens,
      costUsd: total.costUsd + sum.costUsd,
    }),
    NO_USAGE,
  );
}
