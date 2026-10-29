"use client";
import { OduvanchikAgentText } from "@ykurilov/agent-chat-skin-oduvanchik";
import { type HTMLAttributes } from "react";
import { cn } from "./primitives";
/** Saved correspondence uses the same canonical Markdown renderer as the live SDK chat. */
export function AgentMessage({ side = "agent", children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { side?: "agent" | "user" }) {
  return <div className={cn("app-saved-message", side === "user" && "app-saved-message--user", className)} {...rest}>
    {typeof children === "string" && side === "agent" ? <OduvanchikAgentText markdown={children} streaming={false} /> : children}
  </div>;
}
