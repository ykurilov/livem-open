import { Button, EmptyState } from "@ykurilov/ds-react";

/** Адрес, которого в приложении нет. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-[var(--yk-space-6)]">
      <EmptyState
        title="Такой страницы нет"
        description="Проверьте адрес: возможно, в нём опечатка или ссылка устарела."
        actions={
          <Button href="/">На главную</Button>
        }
      />
    </main>
  );
}
