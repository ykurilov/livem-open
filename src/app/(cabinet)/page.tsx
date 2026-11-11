import { randomUUID } from "node:crypto";
import { ArrowRightIcon, MagnetIcon as Magnet } from "@phosphor-icons/react/dist/ssr";
import { Badge, Card, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS, createBotServiceFromEnv, createChannelAdapters } from "@/modules/channels";
import { listAttachedBotsByLeadMagnet, listLeadMagnetCards, listWebLinksByLeadMagnet } from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { EmptyState } from "@/ui";
import { PendingLink } from "@/ui/navigation-progress";
import { CardPublishButton } from "./card-publish-button";
import { botProblem, channelChoices } from "./lead-magnets/[id]/publish/channel-choices";
import { LeadMagnetsHeaderWithCreate } from "./create-lead-magnet-form";

export const dynamic = "force-dynamic";

export default async function LeadMagnetsPage() {
  await requireUser();
  const { db } = getDatabase();
  const [cards, attachedBots, bots, webLinks] = await Promise.all([
    listLeadMagnetCards(db),
    listAttachedBotsByLeadMagnet(db),
    createBotServiceFromEnv().listBots(),
    listWebLinksByLeadMagnet(db, createChannelAdapters()),
  ]);
  const brokenBotIds = new Set(bots.filter((bot) => botProblem(bot)).map((bot) => bot.id));

  return (
    <>
      <LeadMagnetsHeaderWithCreate requestId={randomUUID()} startOpen={cards.length === 0} />

      {cards.length === 0 ? (
        <EmptyState icon={Magnet} title="Лидмагнитов пока нет" hint="Создайте первый: введите название выше." />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-[var(--yk-space-4)]">
          {cards.map((card) => {
            const attached = attachedBots.get(card.id) ?? [];
            const href = `/lead-magnets/${card.id}`;
            return (
              <li key={card.id}>
                {/* Ссылка в названии растянута на всю карточку; кнопки внизу лежат поверх неё. Фокус ссылки — рамка всей карточки */}
                <Card className="app-clickable-card relative h-full">
                  <div className="flex items-start justify-between gap-[var(--yk-space-3)]">
                    <CardTitle className="min-w-0">
                      <PendingLink href={href} data-card-link className="text-inherit no-underline outline-none after:absolute after:inset-0 after:rounded-[var(--yk-radius-lg)] after:content-[''] focus-visible:outline-none">
                        {card.name}
                      </PendingLink>
                    </CardTitle>
                    <Badge variant={card.published ? "success" : "neutral"} className="shrink-0">
                      {card.published ? "Опубликован" : "Черновик"}
                    </Badge>
                  </div>
                  {card.cardDescription ? <p className="app-muted line-clamp-2">{card.cardDescription}</p> : null}
                  {/* Нижняя строка прижата к низу: у карточек одного ряда она на одной высоте */}
                  <div className="mt-auto flex items-center justify-between gap-[var(--yk-space-2)] pt-[var(--yk-space-2)]">
                    <CardPublishButton
                      leadMagnetId={card.id}
                      name={card.name}
                      draftVersionId={card.draftVersionId}
                      channels={channelChoices(bots, attached, card.sendsImages)}
                      published={card.published}
                      webLink={webLinks.get(card.id) ?? null}
                      connections={attached.map((bot) => ({
                        channel: bot.channel,
                        channelLabel: CHANNEL_LABELS[bot.channel],
                        username: bot.username,
                        broken: brokenBotIds.has(bot.botId),
                      }))}
                    />
                    {/* Только вид кнопки: нажатие проходит к ссылке названия под ней, по Tab карточку открывает название */}
                    <span aria-hidden className="app-card-action yk-button yk-button--outline yk-button--sm pointer-events-none shrink-0">
                      Открыть <ArrowRightIcon />
                    </span>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
