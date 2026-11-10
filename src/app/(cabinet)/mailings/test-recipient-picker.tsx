"use client";

import { useId, useState } from "react";
import { Input } from "@/ui/primitives";
import type { TestRecipientOption } from "./test-recipient-option";

interface TestRecipientPickerProps {
  /** Что сейчас показывает список: первые по имени или найденные поиском. */
  options: TestRecipientOption[];
  selected: TestRecipientOption | null;
  onSearch(search: string): void;
  onSelect(option: TestRecipientOption): void;
}

/** Одно поле «Кому прислать пробу»: пишешь часть имени — ниже список, выбираешь себя. */
export function TestRecipientPicker({ options, selected, onSearch, onSelect }: TestRecipientPickerProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);

  const choose = (option: TestRecipientOption) => {
    onSelect(option);
    setOpen(false);
    setTyped("");
    onSearch("");
  };

  return (
    <div className="relative w-full sm:w-96">
      <Input
        role="combobox"
        aria-label="Кому прислать пробу"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Начните писать своё имя"
        value={open ? typed : (selected?.label ?? "")}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setTyped(event.target.value);
          setActive(0);
          setOpen(true);
          onSearch(event.target.value);
        }}
        onKeyDown={(event) => {
          // Enter здесь выбирает человека, а не отправляет форму рассылки
          if (event.key === "Enter") {
            event.preventDefault();
            if (open && options[active]) choose(options[active]);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, options.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Кому прислать пробу"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-[var(--yk-radius-md)] border border-[var(--yk-border)] bg-[var(--yk-surface)] py-1 shadow-lg"
        >
          {options.length === 0 ? (
            <li className="px-3 py-2 text-[var(--yk-muted)]">Никого не нашли — вы есть среди людей, если писали своему боту</li>
          ) : (
            options.map((option, index) => (
              <li
                key={option.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.id === selected?.id}
                // Выбор до потери фокуса полем: иначе список закроется раньше щелчка
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
                className={`cursor-pointer px-3 py-2 ${index === active ? "bg-[var(--yk-surface-2)]" : ""} ${option.id === selected?.id ? "font-semibold" : ""}`}
              >
                {option.label}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
