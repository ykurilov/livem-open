"use client";
import { Tabs as DesignTabs, TabList, Tab, TabPanel } from "@ykurilov/ds-react";
import { createContext, useContext, type ComponentProps } from "react";
const Value = createContext<string | undefined>(undefined);
export function Tabs(props: ComponentProps<typeof DesignTabs>) { return <Value value={props.value}><DesignTabs {...props} /></Value>; }
export function TabsList(props: ComponentProps<typeof TabList>) { return <TabList aria-label="Разделы лидмагнита" {...props} />; }
export const TabsTrigger = Tab;
/** Preserve the constructor on desktop and streaming hidden panels across tab switches. */
export function TabsContent({ forceMount, ...props }: ComponentProps<typeof TabPanel> & { forceMount?: boolean }) {
  const value = useContext(Value);
  const active = value === props.value;
  const desktopConstructor = Object.hasOwn(props, "role") && props.role === undefined;
  if (!active && !forceMount && !desktopConstructor) return null;
  return <TabPanel {...props} hidden={desktopConstructor ? false : !active} data-state={active ? "active" : "inactive"} />;
}
