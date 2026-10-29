import type { StepContext } from "@ykurilov/agent-chat-core";
import type { FlowFirstReason, FlowRunView, FlowStepContextInput } from "@ykurilov/agent-chat-flows";
import { SALE_TAG } from "../flows/settings-to-flow";
import type { TurnTails } from "../platform/turn-tails";
import type { ConversationStore } from "./preview-store";
import { NAME_REST_LINE } from "./profile-name";
import { saleTailLine } from "./tail";

/**
 * Наш хвост в конце запроса каждого шага (строки сценария SDK идут после него): на ход человека — то, что приложение
 * положило перед ходом (отсчёт, пометка о вложениях), и строка продажи; на ход «пишет первым» — только строка продажи
 * по его причинам (`firstReasons`), а когда известно об оплате продукта — строка оплаты вместо неё. Имя из профиля мессенджера и запрет звать по имени, если звал недавно, — на оба вида хода. В историю не пишется, постоянная
 * инструкция не меняется — кэш цел.
 */
export function consultantStepContext(input: {
  tails: TurnTails;
  store: Pick<ConversationStore, "saleState" | "purchases">;
  /** Место чата в сценарии: нода (её метки) и день программы. */
  readRun(ownerId: string, chatId: string): Promise<FlowRunView | null>;
  /** Бот пишет первым: причины срока, один раз за ход (на его первом шаге) — для «Лога». */
  onFirstReasons?(input: { chatId: string; reasons: readonly FlowFirstReason[] }): Promise<void> | void;
  /** Имя человека из профиля мессенджера (`people.display_name`) по владельцу чата; тестовый разговор — без него. */
  personNameOf?(ownerId: string): Promise<string | null>;
  /** Человека недавно звали по имени (`nameUsedRecently`): в этом ответе — без имени. */
  nameUsedRecently?(ownerId: string, chatId: string): Promise<boolean>;
}): StepContext {
  return async (step) => {
    const { firstReasons } = step as FlowStepContextInput;
    const touch = firstReasons !== undefined && firstReasons.length > 0;
    const own = touch ? null : await input.tails.stepContext(step);
    const saleAnswer = await input.store.saleState(step.chatId);
    let sale: string | null = null;
    if (saleAnswer || touch) {
      const run = await input.readRun(step.ownerId, step.chatId);
      if (touch && step.stepNumber === 0) await input.onFirstReasons?.({ chatId: step.chatId, reasons: firstReasons });
      const tags = run?.path.findLast((entry) => entry.state === run.state)?.tags ?? [];
      sale = saleTailLine({ saleAnswer, inSale: tags.includes(SALE_TAG), day: run?.day ?? null, ...(touch && { firstReasons }) });
    }
    const name = (await input.personNameOf?.(step.ownerId))?.trim();
    const nameRest = (await input.nameUsedRecently?.(step.ownerId, step.chatId)) ? NAME_REST_LINE : null;
    // Оплата продукта главнее строки продажи: купившему не продают, ждущему оплату не напоминают
    const purchase = (await input.store.purchases?.tailLine(step.chatId)) ?? null;
    return [name ? `Имя в профиле мессенджера: ${name}` : null, nameRest, own, purchase ?? sale].filter(Boolean).join("\n") || null;
  };
}
