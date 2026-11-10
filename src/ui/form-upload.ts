import { unstable_rethrow } from "next/navigation";

export const FORM_SEND_FAILED = "Не получилось отправить форму — попробуйте ещё раз, набранное осталось";
/** Для кнопки без полей: набранного нет, обещать его нечего. */
export const ACTION_SEND_FAILED = "Не получилось: нет связи с сервером. Попробуйте ещё раз.";

/** Файл больше предела: сервер его всё равно не примет, а слишком большое тело он отвергает, не дойдя до проверки. */
export function isFileTooLarge(file: File | null | undefined, maxBytes: number): boolean {
  return Boolean(file && file.size > maxBytes);
}

/**
 * Отказ самой отправки (сеть, слишком большое тело) становится ошибкой в форме, а не экраном сбоя на месте набранного.
 * Переход на другую страницу из действия проходит как есть.
 */
export function keepingFormOnSendFailure<S extends { error?: string }>(
  action: (previous: S, formData: FormData) => Promise<S>,
  failure: string = FORM_SEND_FAILED,
) {
  return async (previous: S, formData: FormData): Promise<S> => {
    try {
      return await action(previous, formData);
    } catch (error) {
      unstable_rethrow(error);
      return { error: failure } as S;
    }
  };
}
