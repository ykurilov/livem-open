import { z } from "zod";

// Неверные аргументы edit_lead_magnet — одной-двумя строками: какая правка не так и как правильно (eval 19.10).
// Ошибка схемы от SDK — это простыня проверки по всем вариантам правки и сами аргументы целиком: модель в ней теряется.

/** Вариант правки: строгий объект с `op`. */
type ChangeOption = z.ZodObject<z.ZodRawShape>;

/** Ключ, внутри которого пишется вложенное целиком: нода, сценарий, «Дни и время». */
const NESTED_KEYS = ["state", "flow", "schedule"];

const MAX_REPORTED = 3;

const NEEDED_TYPE: Record<string, string> = {
  string: "нужен текст",
  number: "нужно число",
  int: "нужно целое число",
  array: "нужен массив",
  object: "нужен объект",
  record: "нужен объект",
};

const opOf = (option: ChangeOption) => (option.shape.op as z.ZodLiteral<string>).value;
const quoted = (items: readonly PropertyKey[]) => items.map((item) => `«${String(item)}»`).join(", ");

const optional = (option: ChangeOption, key: PropertyKey | undefined) => {
  const schema = option.shape[key as string];
  return schema !== undefined && z.safeParse(schema, undefined).success;
};

function issueText(issue: z.core.$ZodIssue, change: Record<string, unknown>, option: ChangeOption): string {
  const at = issue.path.map(String).join(".");
  const missing = issue.path.length === 1 && change[issue.path[0] as string] === undefined;
  if (missing && issue.code !== "unrecognized_keys") return `нет «${at}»`;
  // Свои сообщения схемы — уже по-русски: «Нет поля «ending». Поля: …»
  if (issue.code !== "unrecognized_keys" && !/^Invalid/.test(issue.message)) return issue.message;
  switch (issue.code) {
    case "unrecognized_keys": {
      const nested = NESTED_KEYS.find((key) => key in option.shape);
      return `лишние ключи ${quoted(issue.keys)}${nested ? `: всё это пишется внутри ${nested}` : ""}`;
    }
    case "invalid_type":
      return `«${at}»: ${NEEDED_TYPE[issue.expected] ?? `нужен ${issue.expected}`}${optional(option, issue.path[0]) ? " или убери ключ" : ""}`;
    case "invalid_value":
      return `«${at}»: одно из ${issue.values.map(String).join(", ")}`;
    default:
      return `«${at}» не подходит`;
  }
}

/** Правке нужен op из списка: какие есть, ошибка называет один раз в конце. */
const UNKNOWN_OP = Symbol("unknown op");

/** Что не так с одной правкой; `null` — правка верна. */
function changeProblem(change: unknown, options: readonly ChangeOption[]): string | typeof UNKNOWN_OP | null {
  if (typeof change !== "object" || change === null || Array.isArray(change)) return "не объект";
  const record = change as Record<string, unknown>;
  const candidates = options.filter((option) => opOf(option) === record.op);
  if (candidates.length === 0) return UNKNOWN_OP;

  const results = candidates.map((option) => ({ option, result: option.safeParse(change) }));
  if (results.some(({ result }) => result.success)) return null;
  const [best] = results.sort((a, b) => a.result.error!.issues.length - b.result.error!.issues.length);
  const { option, result } = best!;
  const problems = result.error!.issues.slice(0, 2).map((issue) => issueText(issue, record, option));
  // Кусок инструкции ноды правится по stateId, а не по field
  if (record.stateId === undefined && !("stateId" in option.shape) && candidates.some((one) => "stateId" in one.shape))
    problems.push(typeof record.field === "string" ? `кусок инструкции ноды — stateId: «${record.field}» вместо field` : "для куска инструкции ноды — stateId");
  return `${problems.join("; ")}. Ключи: ${Object.keys(option.shape).join(", ")}`;
}

/** Короткая ошибка для модели по аргументам, которые не прошли схему. */
export function describeEditInputIssues(input: unknown, options: readonly ChangeOption[]): string {
  const done = "Ничего не изменено.";
  if (typeof input !== "object" || input === null) return `Нужен вызов {"changes": [правки]}. ${done}`;
  const { changes, ...rest } = input as Record<string, unknown>;
  if (typeof changes === "string") return `changes пришёл строкой, и она не разбирается как JSON. ${done} Пришли changes массивом объектов, не строкой`;
  if (!Array.isArray(changes)) return `Нужен вызов {"changes": [правки]}: changes — массив. ${done}`;
  if (changes.length === 0) return `changes пуст: нужна хотя бы одна правка. ${done}`;
  const extra = Object.keys(rest);
  let unknownOp = false;
  const lines = [
    ...(extra.length > 0 ? [`Лишние ключи вызова ${quoted(extra)}: в нём только changes`] : []),
    ...changes.flatMap((change, index) => {
      const problem = changeProblem(change, options);
      if (problem === null) return [];
      const op = (change as { op?: unknown }).op;
      const which = `Правка №${index + 1}${typeof op === "string" ? ` (op «${op}»)` : ""}`;
      if (problem !== UNKNOWN_OP) return [`${which}: ${problem}`];
      unknownOp = true;
      return [`${which}: ${typeof op === "string" ? "такого op нет" : "нет op"}`];
    }),
  ];
  const shown = lines.slice(0, MAX_REPORTED);
  if (lines.length > shown.length) shown.push(`И ещё ${lines.length - shown.length}`);
  if (unknownOp) shown.push(`Есть op: ${[...new Set(options.map(opOf))].join(", ")}`);
  return `${shown.join("\n")}\n${done}`;
}
