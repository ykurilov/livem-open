"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { ComponentProps } from "react";
import { PeopleFilterForm } from "../people/people-filter-form";

/** Совпадает ли выбор в «Кому» с применённым фильтром: пока нет, рассылка не уходит по невидимой выборке. */
const RecipientFilterApplied = createContext<{ applied: boolean; setApplied(applied: boolean): void }>({ applied: true, setApplied: () => {} });

export function RecipientFilterAppliedProvider({ children }: { children: ReactNode }) {
  const [applied, setApplied] = useState(true);
  return <RecipientFilterApplied.Provider value={{ applied, setApplied }}>{children}</RecipientFilterApplied.Provider>;
}

/** Форма «Кому» рассылки: сообщает форме рассылки, применён ли выбор. */
export function MailingRecipientFilterForm(props: Omit<ComponentProps<typeof PeopleFilterForm>, "onAppliedChange">) {
  const { setApplied } = useContext(RecipientFilterApplied);
  return <PeopleFilterForm {...props} onAppliedChange={setApplied} />;
}

export const useRecipientFilterApplied = () => useContext(RecipientFilterApplied).applied;
