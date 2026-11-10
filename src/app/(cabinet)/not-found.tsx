import { Button, EmptyState } from "@ykurilov/ds-react";

/** Удалённый лидмагнит, бот или человек из старой вкладки или закладки: меню на месте, путь — к лидмагнитам. */
export default function CabinetNotFound() {
  return (
    <EmptyState
      title="Здесь ничего нет"
      description="Возможно, это удалили, или ссылка устарела."
      actions={<Button href="/">К лидмагнитам</Button>}
    />
  );
}
