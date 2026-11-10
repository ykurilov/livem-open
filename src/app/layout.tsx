import type { Metadata } from "next";
import type { ReactNode } from "react";
import { tokens } from "@ykurilov/ds-tokens";
import { themeScript } from "@ykurilov/ds-react/theme-script";
import { THEME_STORAGE_KEY } from "@/ui/theme-storage-key";
import "./globals.css";

export const metadata: Metadata = {
  title: "Живые лидмагниты",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={tokens.color.light.bg} />
        <script dangerouslySetInnerHTML={{ __html: themeScript(THEME_STORAGE_KEY) }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
