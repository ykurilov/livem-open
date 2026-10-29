"use client";

import { Children, createContext, forwardRef, useContext, useId, type ComponentProps, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { cn } from "./class-names";
export { cn } from "./class-names";
export { EmptyState as DesignEmptyState, Stat, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "@ykurilov/ds-react";
import { Banner, Button as DesignButton, Card as DesignCard, Chip, TextField, Textarea as DesignTextarea } from "@ykurilov/ds-react";

/** Application composition only. All controls and their visual styles belong to Oduvanchik. */

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "size"> & {
  variant?: "primary" | "secondary" | "ghost" | "destructive" | "outline" | "link";
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
  asChild?: boolean;
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", size = "md", asChild, children, type = "button", ...rest }, ref) {
  const shared = { ...rest, variant: variant === "destructive" ? "danger" as const : variant, size: size === "icon" ? "md" as const : size };
  if (asChild) {
    const child = Children.only(children) as ReactElement<{ href: string; children: ReactNode; target?: string; rel?: string }>;
    return <DesignButton className={rest.className} variant={shared.variant} size={shared.size} loading={rest.loading} disabled={rest.disabled} href={child.props.href} target={child.props.target} rel={child.props.rel}>{child.props.children}</DesignButton>;
  }
  return <DesignButton {...shared} type={type} ref={ref}>{children}</DesignButton>;
});

export function Badge({ variant = "neutral", ...rest }: HTMLAttributes<HTMLSpanElement> & { variant?: "neutral" | "success" | "warm" | "cool" | "danger" }) {
  return <Chip tone={variant === "success" ? "success" : variant === "danger" || variant === "warm" ? "danger" : "neutral"} {...rest} />;
}
export function Alert({ variant, action, children, ...rest }: Omit<ComponentProps<typeof Banner>, "tone"> & { variant?: "neutral" | "info" | "warm" | "danger" | "success"; action?: ReactNode }) {
  return <Banner tone={variant === "danger" ? "danger" : "neutral"} role={variant === "danger" ? "alert" : "status"} {...rest}>{children}{action ? <div className="mt-2">{action}</div> : null}</Banner>;
}
export const Card = DesignCard;
export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("app-card-header", className)} {...rest} />; }
export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) { return <h2 className={cn("yk-card__title", className)} {...rest} />; }
export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) { return <p className={cn("app-muted", className)} {...rest} />; }
export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) { return <div className={className} {...rest} />; }

const FieldContext = createContext<{ id: string; labelId: string; hintId?: string; required?: boolean } | null>(null);
export function Field({ label, hint, required, children, className }: { label: ReactNode; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  const id = useId();
  return <FieldContext value={{ id, labelId: `${id}-label`, hintId: hint ? `${id}-hint` : undefined, required }}>
    <div className={cn("app-field", className)}>
      <label id={`${id}-label`} htmlFor={id} className="yk-mono-label">{label}{required ? " *" : null}</label>
      {children}
      {hint ? <div id={`${id}-hint`} className="yk-field__hint">{hint}</div> : null}
    </div>
  </FieldContext>;
}
export const Input = forwardRef<HTMLInputElement, ComponentProps<typeof TextField>>(function Input(props, ref) {
  const field = useContext(FieldContext);
  return <TextField id={field?.id} aria-labelledby={field?.labelId} aria-describedby={field?.hintId} required={field?.required} {...props} ref={ref} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof DesignTextarea>>(function Textarea(props, ref) {
  const field = useContext(FieldContext);
  return <DesignTextarea id={field?.id} aria-labelledby={field?.labelId} aria-describedby={field?.hintId} required={field?.required} {...props} ref={ref} />;
});
