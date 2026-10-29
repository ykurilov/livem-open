import type { Metadata } from "next";
import type { ReactNode } from "react";
import { tokens } from "@ykurilov/ds-tokens";
import "./globals.css";

export const metadata: Metadata = {
  title: "Живые лидмагниты",
};

// Тема ставится до гидратации, чтобы не мигал светлый фон
const themeScript = `
(function () {
  try {
    var saved = localStorage.getItem("theme");
    var dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? ${JSON.stringify(tokens.color.dark.bg)} : ${JSON.stringify(tokens.color.light.bg)});
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={tokens.color.light.bg} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
