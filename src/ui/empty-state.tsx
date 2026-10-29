import { DesignEmptyState } from "./primitives";
import type { IconComponent } from "@ykurilov/ds-react";
import type { ReactNode } from "react";
export interface EmptyStateProps { icon: IconComponent; title: string; hint?: string; action?: ReactNode; }
export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return <DesignEmptyState title={title} description={hint} actions={action} />;
}
