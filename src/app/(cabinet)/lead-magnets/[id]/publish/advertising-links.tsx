import { CopyableLink } from "@/ui";

/**
 * Ссылки, в которые рекламщик сам вписывает метку, без доступа к кабинету. Правила длинные и нужны не всем:
 * они свёрнуты под «Подробнее», чтобы не стоять перед формой новой ссылки.
 * Примеры не создают записей: метка появится после первого старта человека в боте.
 */
export function AdvertisingLinks({ examples }: { examples: Array<{ channel: string; url: string }> }) {
  return (
    <details className="group text-[length:var(--yk-text-small-size)]">
      <summary className="app-focus w-fit cursor-pointer font-semibold">Рекламщик может сам вписать метку в ссылку — подробнее</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p>
          Замените <code>video_01</code> названием объявления: до 41 знака, латинские буквы, цифры, <code>_</code> и <code>-</code>.
          Остальную часть ссылки не меняйте. Большие и маленькие буквы не различаются.
        </p>
        <ul aria-label="Примеры рекламных ссылок" className="flex flex-col gap-3">
          {examples.map(({ channel, url }) => (
            <li key={channel} className="flex flex-col gap-1">
              <span className="font-semibold">{channel}</span>
              <CopyableLink url={url} channel={channel} />
            </li>
          ))}
        </ul>
        <p className="text-[var(--yk-muted)]">
          Метка появится в отчёте и фильтре «Люди», когда человек начнёт разговор, а не когда откроет ссылку. Если человек
          уже приходил по другой ссылке, засчитается первая. Обычные utm-метки здесь не работают.
        </p>
      </div>
    </details>
  );
}
