"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FunnelSimpleIcon as Funnel } from "@phosphor-icons/react/dist/ssr";
import { Button, Input } from "@/ui/primitives";
import type { PassageStatus } from "@/modules/conversations";
import type { FieldCondition, FieldDefinition, PeopleFilter, PeopleFilterOptions } from "@/modules/people";
import { FIELD_DELETED, conditionFromDraft, toDraft, type DraftCondition, type DraftConditionErrors } from "./field-condition-draft";
import { Select, type SelectOption } from "@/ui";
import { ALL_PEOPLE_PARAM, searchParamsFromFilter } from "./filter-url";
import { PASSAGE_STATUS_LABELS } from "./status-labels";

const ANY = "any";
/** Пункт списка для условия с несколькими вариантами: форма выбирает один, а условие из ссылки или черновика держит все. */
const SEVERAL_OPTIONS = "several";

/** Ширина списков фильтра не зависит от имён ботов и меток: длинное имя сокращается, а не растягивает форму. */
const FILTER_SELECT_WIDTH = "w-full sm:w-52";

const single = (list: readonly string[] | undefined) => list?.[0] ?? ANY;

/**
 * `basePath` — страница, куда ведёт фильтр (по умолчанию «Люди»; рассылки выбирают получателей той же формой).
 * `markAll` — пустой фильтр уходит в адрес явно: у черновика рассылки пустой адрес значит «сохранённый фильтр».
 * `onAppliedChange` — совпадает ли выбор в форме с применённым фильтром (рассылка не уходит по невидимой выборке).
 */
export function PeopleFilterForm(props: {
  options: PeopleFilterOptions;
  fields: FieldDefinition[];
  filter: PeopleFilter;
  basePath?: string;
  markAll?: boolean;
  onAppliedChange?(applied: boolean): void;
}) {
  const basePath = props.basePath ?? "/people";
  const href = (params: URLSearchParams) => {
    if (props.markAll && params.size === 0) params.set(ALL_PEOPLE_PARAM, "1");
    return params.size ? `${basePath}?${params}` : basePath;
  };
  const router = useRouter();
  const [botId, setBotId] = useState(single(props.filter.botIds));
  const [leadMagnetId, setLeadMagnetId] = useState(single(props.filter.leadMagnetIds));
  const [linkId, setLinkId] = useState(single(props.filter.linkIds));
  const [status, setStatus] = useState(single(props.filter.statuses));
  const [conditions, setConditions] = useState<DraftCondition[]>(() => (props.filter.fieldConditions ?? []).map(toDraft));
  const [nextKey, setNextKey] = useState(conditions.length);
  // Ошибки ввода по ключу условия; правка поля снимает свою ошибку
  const [conditionErrors, setConditionErrors] = useState<Record<number, DraftConditionErrors>>({});

  // Фильтр в адресе сменился: пришёл не из этой формы (ссылка, «Сбросить») — форма показывает его. Свой фильтр форма
  // уже показывает, и правка, начатая, пока он применялся (новое условие), не теряется
  const filterKey = searchParamsFromFilter(props.filter).toString();
  const [shownFilterKey, setShownFilterKey] = useState(filterKey);
  const [submittedFilterKey, setSubmittedFilterKey] = useState<string | null>(null);
  if (filterKey !== shownFilterKey) {
    setShownFilterKey(filterKey);
    if (filterKey !== submittedFilterKey) {
      setBotId(single(props.filter.botIds));
      setLeadMagnetId(single(props.filter.leadMagnetIds));
      setLinkId(single(props.filter.linkIds));
      setStatus(single(props.filter.statuses));
      const fresh = (props.filter.fieldConditions ?? []).map(toDraft);
      setConditions(fresh);
      setNextKey(fresh.length);
    }
  }
  // На телефоне фильтры свёрнуты в одну кнопку: иначе люди начинаются только со второго экрана
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters =
    [props.filter.botIds, props.filter.leadMagnetIds, props.filter.linkIds, props.filter.statuses].filter((list) => list?.length).length +
    (props.filter.fieldConditions?.length ?? 0);
  const fieldById = new Map(props.fields.map((field) => [field.id, field]));

  const choose = (options: SelectOption[], anyLabel: string) => [{ value: ANY, label: anyLabel }, ...options];
  const update = (key: number, change: Partial<DraftCondition>) => {
    setConditions((current) => current.map((condition) => (condition.key === key ? { ...condition, ...change } : condition)));
    setConditionErrors((current) => {
      if (!(key in current)) return current;
      const rest = { ...current };
      delete rest[key];
      return rest;
    });
  };

  /** Фильтр, как он выбран в форме сейчас; `errors` — опечатки в условиях. */
  function shownFilter(): { filter: PeopleFilter; errors: typeof conditionErrors } {
    const pick = (value: string) => (value === ANY ? undefined : [value]);
    const fieldConditions: FieldCondition[] = [];
    const errors: typeof conditionErrors = {};
    for (const draft of conditions) {
      const result = conditionFromDraft(draft, fieldById.get(draft.fieldId));
      if ("errors" in result) errors[draft.key] = result.errors;
      else fieldConditions.push(result.condition);
    }
    const filter: PeopleFilter = {
      botIds: pick(botId),
      leadMagnetIds: pick(leadMagnetId),
      linkIds: pick(linkId),
      statuses: pick(status) as PassageStatus[] | undefined,
      fieldConditions,
    };
    return { filter, errors };
  }

  // Условия применённого фильтра — тем же путём, что из формы: порядок ключей из jsonb базы не важен
  const appliedConditions = (props.filter.fieldConditions ?? []).flatMap((condition) => {
    const result = conditionFromDraft(toDraft(condition, 0), fieldById.get(condition.fieldId));
    return "condition" in result ? [result.condition] : [condition];
  });
  const appliedKey = searchParamsFromFilter({ ...props.filter, fieldConditions: appliedConditions }).toString();
  const shown = shownFilter();
  const applied = Object.keys(shown.errors).length === 0 && searchParamsFromFilter(shown.filter).toString() === appliedKey;
  const { onAppliedChange } = props;
  useEffect(() => onAppliedChange?.(applied), [applied, onAppliedChange]);
  // Неприменённый выбор и ошибки в условиях не прячутся за свёрнутой кнопкой
  const showFilters = filtersOpen || !applied || Object.keys(conditionErrors).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    const { filter, errors } = shownFilter();
    setConditionErrors(errors);
    // Фильтр с опечаткой не применяется: список остался бы шире, чем написано в форме
    if (Object.keys(errors).length > 0) return;
    const params = searchParamsFromFilter(filter);
    setSubmittedFilterKey(params.toString());
    router.push(href(params));
  }

  // Адрес мог не смениться (уже «все»): неприменённый выбор и ошибки очищаются здесь, а не по смене фильтра в адресе
  function reset() {
    setBotId(ANY);
    setLeadMagnetId(ANY);
    setLinkId(ANY);
    setStatus(ANY);
    setConditions([]);
    setConditionErrors({});
    setSubmittedFilterKey("");
    router.push(href(new URLSearchParams()));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-[var(--yk-space-4)]">
      {/* Обёртка прячет кнопку на широком экране: собственный display кнопки сильнее классов Tailwind */}
      <div className="sm:hidden">
      <Button
        type="button"
        variant="secondary"
        aria-expanded={showFilters}
        onClick={() => setFiltersOpen((open) => !open)}
      >
        <Funnel aria-hidden />
        {activeFilters ? `Фильтры (${activeFilters})` : "Фильтры"}
      </Button>
      </div>
      <div className={`${showFilters ? "flex" : "hidden"} flex-col gap-[var(--yk-space-4)] sm:flex`}>
      <div className="flex flex-wrap gap-[var(--yk-space-4)]">
        <Select
          aria-label="Бот"
          className={FILTER_SELECT_WIDTH}
          value={botId}
          onValueChange={setBotId}
          options={choose(
            props.options.bots.map((bot) => ({ value: bot.id, label: bot.title })),
            "Все боты",
          )}
        />
        <Select
          aria-label="Лидмагнит"
          className={FILTER_SELECT_WIDTH}
          value={leadMagnetId}
          onValueChange={setLeadMagnetId}
          options={choose(
            props.options.leadMagnets.map((lead) => ({ value: lead.id, label: lead.name })),
            "Все лидмагниты",
          )}
        />
        <Select
          aria-label="Метка"
          className={FILTER_SELECT_WIDTH}
          value={linkId}
          onValueChange={setLinkId}
          options={choose(
            props.options.links.map((link) => ({ value: link.id, label: `${link.label} — ${link.leadMagnetName}` })),
            "Все метки",
          )}
        />
        <Select
          aria-label="Статус"
          className={FILTER_SELECT_WIDTH}
          value={status}
          onValueChange={setStatus}
          options={choose(
            Object.entries(PASSAGE_STATUS_LABELS).map(([value, label]) => ({ value, label })),
            "Любой статус",
          )}
        />
      </div>

      {conditions.map((condition) => {
        const field = fieldById.get(condition.fieldId);
        const errors = conditionErrors[condition.key];
        return (
          <div key={condition.key} className="flex flex-wrap items-center gap-[var(--yk-space-4)]" data-testid="field-condition">
            <Select
              aria-label="Поле"
              // Удалённого поля нет в списке: без заглушки список показал бы первое поле словаря
              placeholder={field ? undefined : "Поле удалено"}
              error={field ? undefined : FIELD_DELETED}
              value={field ? condition.fieldId : ""}
              onValueChange={(fieldId) => update(condition.key, { fieldId, options: [] })}
              options={props.fields.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            />
            {field?.type === "boolean" ? (
              <Select
                aria-label="Значение"
                value={condition.equals}
                onValueChange={(equals) => update(condition.key, { equals })}
                options={[
                  { value: "true", label: "да" },
                  { value: "false", label: "нет" },
                ]}
              />
            ) : null}
            {field?.type === "choice" ? (
              <Select
                aria-label="Значение"
                placeholder="Выберите вариант"
                error={errors?.option}
                value={condition.options.length > 1 ? SEVERAL_OPTIONS : condition.options[0]}
                onValueChange={(option) => option !== SEVERAL_OPTIONS && update(condition.key, { options: [option] })}
                options={[
                  ...(condition.options.length > 1 ? [{ value: SEVERAL_OPTIONS, label: condition.options.join(" или ") }] : []),
                  ...field.options.map((option) => ({ value: option, label: option })),
                ]}
              />
            ) : null}
            {field?.type === "number" ? (
              <>
                <Input aria-label="От" placeholder="от" inputMode="decimal" className="w-28" error={errors?.min} value={condition.min} onChange={(event) => update(condition.key, { min: event.target.value })} />
                <Input aria-label="До" placeholder="до" inputMode="decimal" className="w-28" error={errors?.max} value={condition.max} onChange={(event) => update(condition.key, { max: event.target.value })} />
              </>
            ) : null}
            {field?.type === "text" ? (
              <Input aria-label="Содержит" placeholder="содержит" className="w-60" error={errors?.contains} value={condition.contains} onChange={(event) => update(condition.key, { contains: event.target.value })} />
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setConditions((current) => current.filter((candidate) => candidate.key !== condition.key))}
            >
              Убрать
            </Button>
          </div>
        );
      })}

      <div className="flex flex-wrap gap-[var(--yk-space-4)]">
        <Button type="submit">Показать</Button>
        {props.fields.length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setConditions((current) => [...current, toDraft({ fieldId: props.fields[0]!.id, kind: "boolean", equals: true }, nextKey)]);
              setNextKey((key) => key + 1);
            }}
          >
            Условие по полю
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={reset}>
          Сбросить
        </Button>
        {/* В рассылке о неприменённом выборе говорит её форма; здесь — рядом с кнопкой */}
        {applied || props.onAppliedChange ? null : (
          <span className="self-center text-[length:var(--yk-text-small-size)] text-[var(--yk-muted)]">Нажмите «Показать», чтобы применить выбор</span>
        )}
      </div>
      </div>
    </form>
  );
}
