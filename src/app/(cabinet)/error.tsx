"use client";

import { useEffect } from "react";
import { Button, EmptyState } from "@ykurilov/ds-react";

/** Сбой страницы кабинета: меню остаётся, на месте страницы — повтор и выход к лидмагнитам. */
export default function CabinetError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <EmptyState
      title="Страница не открылась"
      description="Сбой на нашей стороне. Нажмите «Повторить» — обычно это помогает. Не помогло — вернитесь к лидмагнитам и попробуйте позже."
      actions={
        <>
          <Button onClick={retry}>Повторить</Button>
          <Button href="/" variant="secondary">К лидмагнитам</Button>
        </>
      }
    />
  );
}
