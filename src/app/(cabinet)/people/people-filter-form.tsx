"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Input } from "@/ui/primitives";
import type { PassageStatus } from "@/modules/conversations";
import type { FieldCondition, FieldDefinition, PeopleFilter, PeopleFilterOptions } from "@/modules/people";
import { Select, type SelectOption } from "@/ui";
import { searchParamsFromFilter } from "./filter-url";
import { PASSAGE_STATUS_LABELS } from "./status-labels";

const ANY = "any";

/** Условие в форме: числа — строками, пока человек их набирает. */
interface DraftCondition {
  key: number;
  fieldId: string;
  equals: string;
  option: string;
  min: string;
  max: string;
  contains: string;
}

function toDraft(condition: FieldCondition, key: number): DraftCondition {
  return {
    key,
    fieldId: condition.fieldId,
    equals: condition.kind === "boolean" ? String(condition.equals) : "true",
    option: condition.kind === "choice" ? (condition.anyOf[0] ?? "") : "",
    min: condition.kind === "number" && condition.min !== undefined ? String(condition.min) : "",
    max: condition.kind === "number" && condition.max !== undefined ? String(condition.max) : "",
    contains: condition.kind === "text" ? condition.contains : "",
  };
}

function toCondition(draft: DraftCondition, field: FieldDefinition | undefined): FieldCondition | null {
  if (!field) return null;
  const number = (value: string) => (value.trim() === "" ? undefined : Number(value.replace(",", ".")));
  switch (field.type) {
    case "boolean":
      return { fieldId: field.id, kind: "boolean", equals: draft.equals === "true" };
    case "choice":
      return draft.option ? { fieldId: field.id, kind: "choice", anyOf: [draft.option] } : null;
    case "number": {
      const min = number(draft.min);
      const max = number(draft.max);
      if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))) return null;
      return { fieldId: field.id, kind: "number", ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
    }
    case "text":
      return draft.contains.trim() ? { fieldId: field.id, kind: "text", contains: draft.contains.trim() } : null;
  }
}

const single = (list: readonly string[] | undefined) => list?.[0] ?? ANY;

/** `basePath` — страница, куда ведёт фильтр (по умолчанию «База»; рассылки выбирают получателей той же формой). */
export function PeopleFilterForm(props: { options: PeopleFilterOptions; fields: FieldDefinition[]; filter: PeopleFilter; basePath?: string }) {
  const basePath = props.basePath ?? "/people";
  const router = useRouter();
  const [botId, setBotId] = useState(single(props.filter.botIds));
  const [leadMagnetId, setLeadMagnetId] = useState(single(props.filter.leadMagnetIds));
  const [linkId, setLinkId] = useState(single(props.filter.linkIds));
  const [status, setStatus] = useState(single(props.filter.statuses));
  const [conditions, setConditions] = useState<DraftCondition[]>(() => (props.filter.fieldConditions ?? []).map(toDraft));
  const [nextKey, setNextKey] = useState(conditions.length);

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
  const fieldById = new Map(props.fields.map((field) => [field.id, field]));

  const choose = (options: SelectOption[], anyLabel: string) => [{ value: ANY, label: anyLabel }, ...options];
  const update = (key: number, change: Partial<DraftCondition>) =>
    setConditions((current) => current.map((condition) => (condition.key === key ? { ...condition, ...change } : condition)));

  function submit(event: FormEvent) {
    event.preventDefault();
    const pick = (value: string) => (value === ANY ? undefined : [value]);
    const filter: PeopleFilter = {
      botIds: pick(botId),
      leadMagnetIds: pick(leadMagnetId),
      linkIds: pick(linkId),
      statuses: pick(status) as PassageStatus[] | undefined,
      fieldConditions: conditions.flatMap((draft) => toCondition(draft, fieldById.get(draft.fieldId)) ?? []),
    };
    const params = searchParamsFromFilter(filter);
    setSubmittedFilterKey(params.toString());
    router.push(`${basePath}?${params}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-[var(--yk-space-4)]">
      <div className="flex flex-wrap gap-[var(--yk-space-4)]">
        <Select
          aria-label="Бот"
          value={botId}
          onValueChange={setBotId}
          options={choose(
            props.options.bots.map((bot) => ({ value: bot.id, label: bot.title })),
            "Все боты",
          )}
        />
        <Select
          aria-label="Лидмагнит"
          value={leadMagnetId}
          onValueChange={setLeadMagnetId}
          options={choose(
            props.options.leadMagnets.map((lead) => ({ value: lead.id, label: lead.name })),
            "Все лидмагниты",
          )}
        />
        <Select
          aria-label="Метка"
          value={linkId}
          onValueChange={setLinkId}
          options={choose(
            props.options.links.map((link) => ({ value: link.id, label: `${link.label} — ${link.leadMagnetName}` })),
            "Все метки",
          )}
        />
        <Select
          aria-label="Статус"
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
        return (
          <div key={condition.key} className="flex flex-wrap items-center gap-[var(--yk-space-4)]" data-testid="field-condition">
            <Select
              aria-label="Поле"
              value={condition.fieldId}
              onValueChange={(fieldId) => update(condition.key, { fieldId, option: "" })}
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
                value={condition.option || undefined}
                onValueChange={(option) => update(condition.key, { option })}
                options={field.options.map((option) => ({ value: option, label: option }))}
              />
            ) : null}
            {field?.type === "number" ? (
              <>
                <Input aria-label="От" placeholder="от" inputMode="decimal" className="w-28" value={condition.min} onChange={(event) => update(condition.key, { min: event.target.value })} />
                <Input aria-label="До" placeholder="до" inputMode="decimal" className="w-28" value={condition.max} onChange={(event) => update(condition.key, { max: event.target.value })} />
              </>
            ) : null}
            {field?.type === "text" ? (
              <Input aria-label="Содержит" placeholder="содержит" className="w-60" value={condition.contains} onChange={(event) => update(condition.key, { contains: event.target.value })} />
            ) : null}
            <Button
              type="button"
              variant="ghost"
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
        <Button type="button" variant="ghost" onClick={() => router.push(basePath)}>
          Сбросить
        </Button>
      </div>
    </form>
  );
}
