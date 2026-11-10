"use client";

import { createContext, useContext } from "react";
import { Menu } from "@ykurilov/ds-react";
import { ArrowsLeftRightIcon, CheckIcon } from "@phosphor-icons/react";
import { Button } from "@/ui/primitives";

export type ConversationRole = "client" | "consultant";

const ROLE_LABELS: Record<ConversationRole, string> = {
  client: "Я пишу за клиента",
  consultant: "Я отвечаю за консультанта",
};
/** На телефоне поле узкое: подпись короче. */
const SHORT_ROLE_LABELS: Record<ConversationRole, string> = {
  client: "За клиента",
  consultant: "За консультанта",
};

interface ConversationRoleState {
  role: ConversationRole;
  choose(role: ConversationRole): void;
}

/** Кто эксперт в «Разговоре» сейчас; `null` — у лидмагнита нет черновика, выбирать не из чего. */
export const ConversationRoleContext = createContext<ConversationRoleState | null>(null);

/** Кнопка с текущей ролью в нижней строке поля ввода; по нажатию — выбор из двух ролей. */
export function ConversationRoleMenu({ disabled = false }: { disabled?: boolean }) {
  const state = useContext(ConversationRoleContext);
  if (!state) return null;
  const entries = (Object.keys(ROLE_LABELS) as ConversationRole[]).map((role) => ({
    label: ROLE_LABELS[role],
    ...(role === state.role && { icon: CheckIcon }),
    onSelect: () => state.choose(role),
  }));
  return (
    <Menu
      label="Кто вы в разговоре"
      entries={entries}
      trigger={
        <Button variant="secondary" size="sm" disabled={disabled} title="Выбрать, за кого вы пишете в разговоре">
          <ArrowsLeftRightIcon aria-hidden />
          <span className="max-sm:hidden">{ROLE_LABELS[state.role]}</span>
          <span className="sm:hidden">{SHORT_ROLE_LABELS[state.role]}</span>
        </Button>
      }
    />
  );
}
