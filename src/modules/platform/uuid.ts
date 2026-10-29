const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Похоже ли значение на UUID: чужое значение из адреса или формы не должно доходить до базы. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
