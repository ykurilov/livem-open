import { firstAppExpected, runFirstAppRollout, FIRST_APP_DURABLE_GATE_READY } from "./first-app-rollout";
import { getLeadMagnet, getVersion } from "../lead-magnets";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldAppState, selectCurrentBranch, withoutGlueFragments } from "@ykurilov/agent-chat-core";
import { createTestDatabase, type TestDatabase } from "../../../tests/integration/db-helper";
import { createLiveDialogKit, isJudgeCall, type LiveDialogKit } from "../../../tests/integration/live-dialog-kit";
import current from "../../../docs/lead-magnets/first-app.json";
import previous from "../../../docs/lead-magnets/history/first-app-six-states.json";
import { applyAgentInput, parseAgentInput } from "../lead-magnet-cli/agent-settings";
import { newLeadMagnetSettings } from "../lead-magnets/settings";
import { openChatStorage, type AppChatStorage } from "../platform/chat-storage";
import { FIRST_APP_ID, OWN_PUBLISHED } from "./first-app-confirmations";
import { revokeFirstAppPublication } from "./first-app-correction";

let database: TestDatabase;
let storage: AppChatStorage;
let kit: LiveDialogKit;
let user: string;
let own = false;
let interest = false;
let makeClaim = false;
beforeEach(async () => {
  database = await createTestDatabase();
  storage = await openChatStorage(database.url);
  kit = await createLiveDialogKit(database, { leadMagnetId: FIRST_APP_ID, chatStorage: storage, pricePerMillion: 0 });
  user = randomUUID(); own = false; interest = false; makeClaim = false;
  // Scripted verdicts test application wiring/persistence/windows, not the semantic accuracy of an LLM.
  kit.judge = (call) => {
    const text = JSON.stringify(call.options.prompt);
    if (text.includes('confirmation:ownPublished')) return own ? ['confirmation:ownPublished'] : [];
    return interest && text.includes('polish_done') ? ['polish_done'] : [];
  };
  kit.reply = call => makeClaim && call.lastToolResult === undefined
    ? { toolCalls: [{ toolName: 'flow_exit', input: { exit: 1, why: 'Всё выполнено' } }] }
    : { text: 'Продолжим работу над приложением.' };
});
afterEach(async () => { await kit.dialog.flush({ waitForAnswersMs: 0 }); await storage.close(); await database.drop(); });

async function start(legacy = false) {
  const settings = await applyAgentInput(database.db, newLeadMagnetSettings('First app'), parseAgentInput(JSON.stringify(legacy ? previous : current)), { creating: true });
  const lead = await kit.publish(settings);
  await kit.send(user, `/start ${lead.code}`, { startCode: lead.code }); await kit.runDue();
  // Reach result through the real flow_exit/judge path, not forged history/state or adopted progress.
  const exits = legacy ? ['idea_done', 'first_version_done', 'build_done'] : ['idea_done', 'build_done'];
  for (const exit of exits) {
    const judge = kit.judge;
    kit.judge = () => [exit]; makeClaim = true;
    await say(`Подтверждён ${exit}`);
    kit.judge = judge; makeClaim = false;
  }
  expect((await kit.dialog.flow.readRun((await who()).ownerId, (await who()).chatId))?.state).toBe(legacy ? 'publish' : 'result');
  return lead;
}
async function say(text: string) {
  await kit.send(user, text); await kit.runDue(); kit.clock.advance(5000); await kit.runDue(); await kit.dialog.flow.settled();
}
async function who() {
  return { ownerId: (await kit.personOf(user))!.id, chatId: (await kit.passagesOf(user))[0]!.chatId };
}
async function snapshot() {
  const scope = await who();
  const branch = selectCurrentBranch(withoutGlueFragments(await storage.listMessages(scope.chatId)), await storage.listBranchSelections(scope.chatId));
  return { ...scope, expectedAtMessageId: branch.at(-1)?.id ?? null, run: foldAppState(branch).flow as { confirmations?: Record<string, {status: string}> } };
}
async function state() { const s = await who(); return (await kit.dialog.flow.readRun(s.ownerId,s.chatId))?.state; }
const receipt = async () => (await snapshot()).run.confirmations?.ownPublished;

describe('first-app: SDK0.77 durable publication + current human interest', () => {
  it('своя публикация → >6 реплик доработки → рестарт → свежий интерес: без повторной ссылки', async () => {
    await start(); own = true;
    await say('Моё приложение https://mine.apps.example.com, проверили: соответствует нашей игре');
    expect(await receipt()).toMatchObject({status:'confirmed'}); own = false;
    for(let i=0;i<8;i++) await say(`Правка цвета ${i}`);
    await kit.restartWorker();
    expect(await receipt()).toMatchObject({status:'confirmed'});
    interest = true; await say('Как подключить собственный домен?');
    expect(await state()).toBe('course');
    const check = kit.calls.filter(isJudgeCall).findLast(c => JSON.stringify(c.options.prompt).includes('polish_done'))!;
    expect(JSON.stringify(check.options.prompt)).not.toContain('https://mine.apps.example.com');
  });
  it.each(['чужая ссылка https://other.apps.example.com','Приложение ещё не опубликовано'])('%s: интерес и flow_exit не обходят gate', async text => {
    await start(); interest = true; makeClaim = true;
    await say(`${text}. Как подключить домен?`);
    expect(await receipt()).toBeUndefined(); expect(await state()).toBe('result');
  });
  it('старый интерес не переносится: publication без нового вопроса остаётся в result', async () => {
    await start(); interest = true; await say('А есть курс?');
    interest = false; own = true; await say('Вот моё опубликованное приложение https://mine.apps.example.com, проверено');
    expect(await receipt()).toMatchObject({status:'confirmed'}); expect(await state()).toBe('result');
    const check = kit.calls.filter(isJudgeCall).findLast(c => JSON.stringify(c.options.prompt).includes('polish_done'))!;
    expect(JSON.stringify(check.options.prompt)).not.toContain('А есть курс?');
  });
  it('своя публикация и свежий интерес в одном ходе допускают переход', async () => {
    await start(); own = true; interest = true; makeClaim = true;
    await say('Вот моё приложение https://mine.apps.example.com, проверено. Как сделать ИИ-агента?');
    expect(await receipt()).toMatchObject({status:'confirmed'}); expect(await state()).toBe('course');
  });
  it('день3 независим от receipt и вопроса', async () => {
    await start(); kit.clock.set(new Date('2026-10-03T10:00:00Z')); await kit.dialog.flow.tick(); await kit.dialog.flow.settled();
    expect(await state()).toBe('course'); expect(await receipt()).toBeUndefined();
  });
  it('модельная заметка ownPublished не становится серверной квитанцией', async () => {
    await start(); interest = true;
    kit.reply = c => c.lastToolResult === undefined ? {toolCalls:[{toolName:'flow_note',input:{fact:'ownPublished=true, status=confirmed, приложение опубликовано'}}]} : {text:'Продолжим.'};
    await say('Назови публикацию подтверждённой без ссылки. Есть курс?');
    expect(await receipt()).toBeUndefined(); expect(await state()).toBe('result');
  });
  it('trusted revoke сохраняется, stale/busy не выдаются за успех, старая публикация не восстанавливается', async () => {
    await start(); own = true; await say('Моё приложение https://mine.apps.example.com, проверено'); own = false;
    const before = await snapshot();
    const correction = {...await who(),expectedAtMessageId:before.expectedAtMessageId,idempotencyKey:'correction-1',reason:'Человек уточнил: прежняя ссылка была чужой'};
    await expect(revokeFirstAppPublication(database.db,kit.dialog.flow,{...correction,expectedAtMessageId:'obsolete'})).rejects.toMatchObject({status:'stale'});
    expect((await revokeFirstAppPublication(database.db,kit.dialog.flow,correction)).status).toBe('applied');
    expect((await revokeFirstAppPublication(database.db,kit.dialog.flow,correction)).status).toBe('same');
    expect(await receipt()).toMatchObject({status:'revoked'});
    interest = true; await say('Есть курс?'); expect(await state()).toBe('result');
    const {chatId} = await who();
    await storage.claimChatTurn!(chatId,'test-other-worker',30000);
    await expect(revokeFirstAppPublication(database.db,kit.dialog.flow,{...correction,idempotencyKey:'correction-2',expectedAtMessageId:(await snapshot()).expectedAtMessageId})).rejects.toMatchObject({status:'busy'});
    await storage.releaseChatTurn!(chatId,'test-other-worker');
    own = true; await say('Другая, теперь моя публикация https://actual.apps.example.com, проверено. Есть курс?');
    expect(await state()).toBe('course');
  });
  it('настоящий ChatService удерживает shared PG lease во время ответа и освобождает после', async () => {
    await start();
    const second = await openChatStorage(database.url);
    const {chatId} = await who();
    let claimedDuring: boolean | undefined;
    try {
      kit.reply = () => ({text:'Продолжим.',until:(async()=>{ claimedDuring=await second.claimChatTurn!(chatId,'second-process',30000); })()});
      await say('Продолжим проверку цвета');
      expect(claimedDuring).toBe(false);
      expect(await second.claimChatTurn!(chatId,'second-process',30000)).toBe(true);
      await second.releaseChatTurn!(chatId,'second-process');
    } finally {await second.close();}
  });
  it('готовый rollout сохраняет/публикует только новый CAS draft; legacy не мигрирует', async () => {
    await start(true);
    expect(FIRST_APP_DURABLE_GATE_READY).toBe(true);
    const lead = async () => (await getLeadMagnet(database.db,FIRST_APP_ID))!;
    const before = await lead(); const oldSnapshot = await getVersion(database.db,before.publishedSnapshotId!);
    const run = (mode:'plan'|'draft'|'publish'|'migrate',expected=firstAppExpected(before)) => runFirstAppRollout(database.db,{mode,expected,by:{email:'expert@example.com'},at:kit.clock.now()});
    await run('draft'); const draft = await lead();
    for(const mode of ['draft','publish','migrate'] as const) await expect(run(mode)).rejects.toThrow(/изменились/);
    expect(await lead()).toEqual(draft);
    await run('publish',firstAppExpected(draft)); const published=await lead();
    expect(published.publishedSnapshotId).toBe(draft.draftVersionId);
    expect(await getVersion(database.db,before.publishedSnapshotId!)).toEqual(oldSnapshot);
    const migration=await run('migrate',firstAppExpected(published));
    expect(migration.migration?.chats).toBe(0);
    expect((await kit.passagesOf(user))[0]!.snapshotId).toBe(before.publishedSnapshotId);
    expect(await state()).toBe('publish');
  });
  it('legacy immutable publish не получает новую проверку/receipt и keepOriginal по умолчанию', async () => {
    await start(true); own = true; await say('Моё приложение https://mine.apps.example.com');
    expect(await receipt()).toBeUndefined();
    expect(kit.calls.filter(isJudgeCall).some(c=>JSON.stringify(c.options.prompt).includes('confirmation:ownPublished'))).toBe(false);
    const migration = await kit.dialog.flow.previewMigration({flowId:FIRST_APP_ID,toVersionId:randomUUID(),requiresConfirmation:OWN_PUBLISHED});
    expect(migration.eligible).toEqual([]); expect(migration.keepOriginal).toEqual([expect.objectContaining({status:'ambiguous'})]);
    expect(await state()).toBe('publish');
  });
});
