import type { ReactNode } from "react";
import { cn } from "./class-names";
import { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "./primitives";
import { EmptyState, type EmptyStateProps } from "./empty-state";

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  render(row: Row): ReactNode;
  /** Выравнивание содержимого колонки, по умолчанию слева. */
  align?: "left" | "right";
  numeric?: boolean;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey(row: Row): string;
  /** Пустое состояние, когда строк нет; без него пустая таблица — только шапка. */
  empty?: EmptyStateProps;
}

/** Где ячейка стоит в карточке узкого экрана: первая колонка — заголовок, колонка без названия — действие справа от него или строкой ниже, если не влезает. */
function cardPlace(column: DataTableColumn<unknown>, index: number) {
  if (index === 0) return "title";
  if (!column.header) return "action";
  return "field";
}

/**
 * Таблица Одуванчика; без строк — пустое состояние по эталону. Сортировку и выбор строк добавляют экраны, которым они нужны.
 * На узком экране каждая строка — карточка, : заголовок с действием сверху, остальные колонки подписанными строками ниже.
 * Это та же разметка таблицы, поэтому кнопки и диалоги в ячейках не дублируются; роли заданы явно, чтобы смена display их не стирала.
 */
export function DataTable<Row>({ columns, rows, rowKey, empty }: DataTableProps<Row>) {
  // Как в эталоне: пустой таблице шапка колонок не нужна
  if (rows.length === 0 && empty) {
    return (
      <div className="rounded-[var(--yk-radius-lg)] border border-[var(--yk-border)] bg-[var(--yk-surface)]">
        <EmptyState {...empty} />
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <Table role="table" className="w-full border-collapse text-left text-[length:var(--yk-text-small-size)] max-sm:block">
        <TableHead role="rowgroup" className="max-sm:sr-only">
          <TableRow role="row" className="border-b border-[var(--yk-border)] text-[var(--yk-muted)]">
            {columns.map((column) => (
              <TableHeaderCell
                key={column.key}
                role="columnheader"
                scope="col"
                numeric={column.numeric}
                className={cn("px-4 py-3 font-semibold", column.align === "right" && "text-right")}
              >
                {column.header}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody role="rowgroup" className="max-sm:block">
          {rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                role="row"
                className="border-b border-[var(--yk-border)] last:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-2 max-sm:p-4"
              >
                {columns.map((column, index) => {
                  const place = cardPlace(column as DataTableColumn<unknown>, index);
                  return (
                    <TableCell
                      key={column.key}
                      role="cell"
                      numeric={column.numeric}
                      data-label={place === "field" ? column.header : undefined}
                      className={cn(
                        "px-4 py-3 max-sm:p-0",
                        column.align === "right" && "text-right",
                        place === "title" && "max-sm:order-0 max-sm:min-w-0 max-sm:grow max-sm:basis-32 max-sm:text-left max-sm:font-semibold",
                        // Короткое действие встаёт справа от заголовка, широкое (форма) переносится на свою строку
                        place === "action" && "max-sm:order-1 max-sm:ml-auto max-sm:max-w-full",
                        place === "field" && "max-sm:order-2 max-sm:basis-full max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:text-right",
                        // Подпись колонки — псевдоэлементом: она не попадает в текст ячейки и не дублирует заголовок таблицы
                        place === "field" &&
                          "max-sm:before:shrink-0 max-sm:before:text-left max-sm:before:text-[var(--yk-muted)] max-sm:before:content-[attr(data-label)]",
                      )}
                    >
                      {column.render(row)}
                    </TableCell>
                  );
                })}
              </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
