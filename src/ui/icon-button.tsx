"use client";
import { Button, type ButtonAsButtonProps, type IconComponent } from "@ykurilov/ds-react";
export interface IconButtonProps extends Omit<ButtonAsButtonProps, "icon" | "children" | "aria-label"> { label: string; icon: IconComponent; }
export function IconButton({ label, icon, variant = "ghost", ...rest }: IconButtonProps) {
  return <Button type="button" variant={variant} icon={icon} aria-label={label} title={label} {...rest} />;
}
