import type { Metadata } from "next";
import type { ReactNode } from "react";
import { tokens } from "@ykurilov/ds-tokens";
import { themeInitScript } from "@/ui/theme-preference";
import "./globals.css";

export const metadata: Metadata = {
  title: "Живые лидмагниты",
};

// Тема ставится до гидратации, чтобы не мигал светлый фон. Без выбора в «Настройках» — системная тема устройства
const themeScript = themeInitScript({ light: tokens.color.light.bg, dark: tokens.color.dark.bg });

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={tokens.color.light.bg} data-auto-content={tokens.color.light.bg} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={tokens.color.dark.bg} data-auto-content={tokens.color.dark.bg} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
