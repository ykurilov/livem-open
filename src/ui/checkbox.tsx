"use client";
import { Checkbox as DesignCheckbox } from "@ykurilov/ds-react";
import type { ComponentProps } from "react";
type Props = Omit<ComponentProps<typeof DesignCheckbox>, "checked" | "onChange"> & { checked?: boolean | "indeterminate"; onCheckedChange?(checked: boolean): void; };
export function Checkbox({ checked, onCheckedChange, ...rest }: Props) {
  return <DesignCheckbox checked={checked === undefined ? undefined : checked === true} indeterminate={checked === "indeterminate"} onChange={event => onCheckedChange?.(event.target.checked)} {...rest} />;
}
