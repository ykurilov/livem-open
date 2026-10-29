import { authMode } from "@/auth";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/ui/primitives";

export const dynamic = "force-dynamic";

function safeNext(raw: string | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

const PASSWORD_ERRORS: Record<string, string> = {
  invalid: "Неверная почта или пароль",
  too_many: "Слишком много попыток. Подождите 15 минут и попробуйте снова.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const denied = error === "access_denied";
  const byPassword = authMode({ env: process.env }) === "password";
  const passwordError = error ? PASSWORD_ERRORS[error] : undefined;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-[var(--yk-space-4)] p-[var(--yk-space-6)]">
      <Card>
        <CardHeader>
          <CardTitle>Живые лидмагниты</CardTitle>
          <CardDescription>Кабинет эксперта. Войдите, чтобы продолжить.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-[var(--yk-space-4)]">
          {denied ? (
            <Alert variant="danger" title="Этому адресу вход закрыт">
              Войдите под другой почтой или попросите добавить ваш адрес в список.
            </Alert>
          ) : null}
          {byPassword ? (
            <form method="post" action="/api/auth/login" className="flex flex-col gap-[var(--yk-space-4)]">
              {passwordError ? (
                <Alert variant="danger" title="Не получилось войти">
                  {passwordError}
                </Alert>
              ) : null}
              <input type="hidden" name="next" value={safeNext(next)} />
              <Field label="Почта" required>
                <Input name="email" type="email" autoComplete="username" autoFocus />
              </Field>
              <Field label="Пароль" required>
                <Input name="password" type="password" autoComplete="current-password" />
              </Field>
              <Button type="submit">Войти</Button>
            </form>
          ) : (
            <Button asChild>
              <a href={`/api/auth/login?next=${encodeURIComponent(safeNext(next))}`}>Войти</a>
            </Button>
          )}
          {denied ? (
            <Button asChild variant="ghost">
              <a href="/api/auth/logout">Выйти из текущего аккаунта</a>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
