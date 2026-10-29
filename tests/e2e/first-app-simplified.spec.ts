import { expect, test } from "@playwright/test";
import { seal } from "../../src/auth/core/cookie-seal";
import { readFileSync } from "node:fs";
const blueprint = JSON.parse(readFileSync("docs/lead-magnets/first-app.json", "utf8"));
import { applyAgentInput, parseAgentInput } from "../../src/modules/lead-magnet-cli/agent-settings";
import { createLeadMagnet, getLeadMagnet, saveDraft } from "../../src/modules/lead-magnets";
import { connectDatabase } from "../../src/modules/platform/db";
import { E2E_BASE_URL, E2E_COOKIE_SECRET, E2E_EMAIL, e2eDatabaseUrl } from "./e2e-env";

test('first-app: четыре задачи и два окончания в настоящем FlowTestChat, draft only', async ({page,context}) => {
  test.setTimeout(180000);
  const connection=connectDatabase(e2eDatabaseUrl(),{poolSize:2});
  try {
    const lead=await createLeadMagnet(connection.db,{name:'Твоё первое приложение - четыре задачи'});
    const settings=await applyAgentInput(connection.db,lead.draft,parseAgentInput(JSON.stringify(blueprint)),{creating:true});
    await saveDraft(connection.db,lead.id,settings,'manual');
    const session={user:{id:'e2e-expert',email:E2E_EMAIL,roles:[]},accessToken:'e2e',refreshToken:'e2e',accessTokenExpiresAt:Date.now()+86400000};
    await context.addCookies([{name:'auth_session',value:await seal(session,E2E_COOKIE_SECRET),url:E2E_BASE_URL}]);
    await page.setViewportSize({width:1680,height:1050});
    expect((await page.goto(`/lead-magnets/${lead.id}`))?.status()).toBe(200);
    const tab=page.getByRole('tab',{name:'Сценарий'});
    await expect(async()=>{await tab.click();await expect(tab).toHaveAttribute('aria-selected','true',{timeout:1000});}).toPass({timeout:60000});
    const board=page.getByRole('tabpanel',{name:'Сценарий'});
    await expect(board.getByRole('application')).toBeVisible({timeout:60000});
    await expect(board.locator('.react-flow__node')).toHaveCount(6);
    for(const id of ['idea','build','result','course','final','deadline']) await expect(board.locator(`.react-flow__node[data-id="${id}"]`)).toHaveCount(1);
    for(const id of ['@any','first_version','publish','polish']) await expect(board.locator(`.react-flow__node[data-id="${id}"]`)).toHaveCount(0);
    // The canvas starts below compact app/editor headers, without Studio's page padding.
    const canvasBox = (await board.getByRole('application').boundingBox())!;
    expect(canvasBox.y).toBeLessThan(185);
    await board.locator('.react-flow__node[data-id="idea"]').click();
    const reminderDays = board.getByRole('combobox', { name: 'Когда действуют напоминания этапа', exact: true });
    if (!(await reminderDays.count())) await board.getByText('Дополнительно', { exact: true }).click();
    await reminderDays.scrollIntoViewIfNeeded();
    await expect(reminderDays).toHaveValue('untilProgramDay');
    await expect(reminderDays.locator('option:checked')).toHaveText('до дня воронки включительно');
    await expect(board.getByText(/Дни воронки считаются от начала участия человека/)).toBeVisible();
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await page.screenshot({ path: test.info().outputPath('compact-board-reminders.png') });
    await board.locator('[data-flow-fullscreen-toggle]').click();
    await expect(board.locator('[data-flow-fullscreen][role="dialog"]')).toBeVisible();
    await page.screenshot({path:test.info().outputPath('first-app-sdk077-four-states.png')});
    expect((await getLeadMagnet(connection.db,lead.id))!.publishedSnapshotId).toBeNull();
    // The app does not persist a tab in URL/storage. Reload returns to its original start tab.
    expect((await page.reload())?.status()).toBe(200);
    await page.getByRole('tab',{name:'Сценарий'}).click();
    await expect(page.getByRole('tabpanel',{name:'Сценарий'}).locator('.react-flow__node')).toHaveCount(6);
  } finally {await connection.close();}
});
