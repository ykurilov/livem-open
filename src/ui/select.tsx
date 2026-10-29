"use client";
import { useSyncExternalStore } from "react";
import { Select as DesignSelect } from "@ykurilov/ds-react";
export interface SelectOption { value: string; label: string; }
export interface SelectProps { options: SelectOption[]; value?: string; onValueChange?(value: string): void; placeholder?: string; "aria-label"?: string; disabled?: boolean; className?: string; }
const subscribe = () => () => {};
export function Select({ options, value, onValueChange, placeholder, disabled, ...rest }: SelectProps) {
  // This controlled picker needs its onChange handler; do not accept edits before hydration.
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return <DesignSelect disabled={disabled || !hydrated} value={value} onChange={event => onValueChange?.(event.target.value)} {...rest}>
    {placeholder ? <option value="" disabled>{placeholder}</option> : null}
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </DesignSelect>;
}
