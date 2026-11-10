"use client";

import { useEffect } from "react";
import { tokens } from "@ykurilov/ds-tokens";
import { themeInitScript } from "@/ui/theme-preference";
import { Button, EmptyState } from "@ykurilov/ds-react";
import "./globals.css";

const themeScript = themeInitScript({ light: tokens.color.light.bg, dark: tokens.color.dark.bg });

/** Сбой самого каркаса приложения: своя страница вместо корневой разметки, по-русски и в теме из «Настроек». */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <title>Живые лидмагниты</title>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-[var(--yk-space-6)]">
          <EmptyState
            title="Приложение не открылось"
            description="Сбой на нашей стороне. Нажмите «Повторить» — обычно это помогает. Не помогло — откройте главную и попробуйте позже."
            actions={
              <>
                <Button onClick={retry}>Повторить</Button>
                <Button href="/" variant="secondary">На главную</Button>
              </>
            }
          />
        </main>
      </body>
    </html>
  );
}
