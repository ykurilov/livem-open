import { startTransition, type FormEvent } from "react";

/**
 * Отправка формы в действие без `<form action>`: после него React сбрасывает поля, и при ошибке набранное пропадало бы.
 * Нажатая кнопка уходит вместе с полями: её `name`/`value` доходят до действия.
 */
export function submitKeepingFields(action: (formData: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    startTransition(() => action(formData));
  };
}
