import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS, createBotServiceFromEnv } from "@/modules/channels";
import { listBotLeadMagnets } from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { createSenlerSettingsFromEnv } from "@/modules/senler";
import { ArrowLink, PageHeader } from "@/ui";
import { BotSettingsForm, DeleteBotForm } from "./bot-settings-form";
import { PhotosKeyForm } from "./photos-key-form";
import { SenlerDisconnectForm, SenlerGroupsForm, SenlerKeyForm } from "./senler-form";

export const dynamic = "force-dynamic";

export default async function BotPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const botService = createBotServiceFromEnv();
  const bot = await botService.getBot(id);
  if (!bot) notFound();
  const activeConversations = await botService.countActiveConversations(id);
  const leadMagnets = await listBotLeadMagnets(getDatabase().db, id);
  const publishedCount = leadMagnets.filter((lead) => lead.published).length;

  return (
    <>
      <PageHeader title={`Бот ${bot.title}`} description={`${CHANNEL_LABELS[bot.channel]} · @${bot.username}`} />
      <div className="flex flex-col gap-[var(--yk-space-6)]">
        <ArrowLink href="/bots">Ко всем ботам</ArrowLink>
        {bot.canSendPhotos ? null : (
          <Card>
            <CardHeader>
              <CardTitle>Картинки</CardTitle>
            </CardHeader>
            <CardContent>
              <PhotosKeyForm botId={bot.id} />
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Если человек пришёл без кода</CardTitle>
          </CardHeader>
          <CardContent>
            <BotSettingsForm
              botId={bot.id}
              mode={bot.noCodeMode}
              defaultLeadMagnetId={bot.defaultLeadMagnetId}
              leadMagnets={leadMagnets.map((lead) => ({
                value: lead.id,
                label: lead.published ? lead.name : `${lead.name} (не опубликован)`,
              }))}
            />
          </CardContent>
        </Card>
        {bot.channel === "vk" ? (
          // Senler отвечает до 10 секунд: остальная страница не ждёт его
          <Suspense fallback={<SenlerCardShell>Загружаем настройки Senler…</SenlerCardShell>}>
            <SenlerCard botId={bot.id} leadMagnets={leadMagnets} />
          </Suspense>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Удаление бота</CardTitle>
          </CardHeader>
          <CardContent>
            <DeleteBotForm botId={bot.id} publishedCount={publishedCount} activeConversations={activeConversations} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Senler у бота ВК: ключ, группа подписчиков и свои группы лидмагнитов. Группы — живым списком из Senler. */
async function SenlerCard(props: { botId: string; leadMagnets: Array<{ id: string; name: string }> }) {
  const senler = createSenlerSettingsFromEnv();
  const settings = await senler.load(props.botId);
  const groups = settings ? await senler.listGroups(props.botId) : null;

  return (
    <SenlerCardShell>
        <span className="max-w-xl text-[length:var(--yk-text-small-size)]">
          Кто пришёл по ссылке лидмагнита, сразу попадёт в группу подписчиков Senler. Подписчикам Senler, которые пишут без ссылки, бот не отвечает: с ними
          работают рассылки Senler.
        </span>
        {settings?.lastError ? (
          <Alert variant="danger" title="Senler: есть ошибка">
            {settings.lastError}
          </Alert>
        ) : null}
        {settings && groups ? (
          groups.ok ? (
            <SenlerGroupsForm
              // Новый ключ — форма заново берёт выбранные группы, а не держит прежние
              key={settings.keyUpdatedAt.toISOString()}
              botId={props.botId}
              groups={groups.groups.map((group) => ({ value: group.id, label: group.name || `Группа ${group.id}` }))}
              defaultGroupId={settings.defaultGroupId}
              leadMagnets={props.leadMagnets.map((lead) => ({ id: lead.id, name: lead.name, groupId: settings.leadMagnetGroups[lead.id] ?? null }))}
            />
          ) : (
            <Alert variant="danger" title="Не удалось загрузить группы Senler">
              {groups.error}
            </Alert>
          )
        ) : null}
        <SenlerKeyForm botId={props.botId} connected={Boolean(settings)} />
        {settings ? <SenlerDisconnectForm botId={props.botId} /> : null}
    </SenlerCardShell>
  );
}

function SenlerCardShell(props: { children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Senler</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--yk-space-6)]">{props.children}</CardContent>
    </Card>
  );
}
