import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/primitives";
import { requireUser } from "@/modules/access";
import { CHANNEL_LABELS, createBotServiceFromEnv } from "@/modules/channels";
import { listBotLeadMagnets } from "@/modules/lead-magnets";
import { getDatabase } from "@/modules/platform/db";
import { PageHeader } from "@/ui";
import { BotSettingsForm, DeleteBotForm } from "./bot-settings-form";

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
        <Link href="/bots" className="app-focus w-fit text-[length:var(--yk-text-small-size)] underline">
          ← Ко всем ботам
        </Link>
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
