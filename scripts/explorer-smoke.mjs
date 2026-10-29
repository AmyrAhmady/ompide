// Real Windows desktop Explorer workflows. Uses disposable files and restores
// only its own Recycle Bin items through the core integration-test helper.
/* global document */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 15_000 });
const project = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'pawn-explorer-smoke-'));
const preferences = path.join(process.env.APPDATA, 'mp.open.editor/preferences.json');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('1420'));
if (!page) throw new Error('Start the native debug app connected to Vite with loopback CDP port 9222.');
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack || error.message));
const evidence = [];
let previous;
let seeded = false;

async function evaluate(operation, argument) {
  return page.evaluate(async ({ operation, argument }) => {
    const source = performance.getEntriesByType('resource').map((entry) => entry.name).find((url) => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(source);
    return await (0, eval)(operation)(workbench, argument);
  }, { operation: operation.toString(), argument });
}

function restoreRecycledFixtures() {
  execFileSync('cargo', ['test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'pawn-core', 'restore_explorer_smoke_items', '--', '--ignored'], {
    cwd: project,
    env: { ...process.env, PAWN_IDE_EXPLORER_SMOKE_ROOT: directory },
    stdio: 'inherit',
  });
}

const row = (name) => page.getByRole('treeitem', { name, exact: true });
const dialog = (name) => page.getByRole('dialog', { name, exact: true });

async function create(folder, name) {
  const label = folder ? 'New Folder…' : 'New File…';
  await page.getByRole('button', { name: label, exact: true }).click();
  await dialog(label).getByLabel('Name', { exact: true }).fill(name);
  await dialog(label).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog(label)).toHaveCount(0);
}

async function append(text) {
  await evaluate((workbench) => workbench.focusEditor());
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
}

try {
  try { previous = await readFile(preferences); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await cp(path.join(project, 'fixtures/minimal'), directory, { recursive: true, filter: (file) => !file.includes(`${path.sep}output`) });
  await mkdir(path.dirname(preferences), { recursive: true });
  seeded = true;
  await writeFile(preferences, JSON.stringify({ recentWorkspaces: [directory], settings: { theme: 'dark' } }));
  await page.reload();
  await page.getByRole('button', { name: directory, exact: true }).click();
  await expect(row('main.pwn')).toBeVisible();

  await create(true, 'scripts');
  await expect(row('scripts')).toBeFocused();
  await create(false, 'nested.inc');
  assert.equal((await stat(path.join(directory, 'scripts/nested.inc'))).isFile(), true);
  await expect(page.getByRole('tab', { name: 'nested.inc', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Pawn IDE', exact: true })).toBeFocused();
  await append('// readable source\n');
  await page.keyboard.press('Control+s');
  await expect.poll(() => readFile(path.join(directory, 'scripts/nested.inc'), 'utf8')).toContain('readable source');
  const originalSource = await readFile(path.join(directory, 'scripts/nested.inc'));
  evidence.push('Toolbar creation makes real folders/files, selects the new folder, opens the new file and saves typed source.');

  await row('nested.inc').focus();
  await page.keyboard.press('Insert');
  await dialog('New File…').getByLabel('Name', { exact: true }).fill('nested.inc');
  await dialog('New File…').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog('New File…').getByRole('alert')).toContainText('already exists');
  await dialog('New File…').getByLabel('Name', { exact: true }).fill('../escape.inc');
  await dialog('New File…').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog('New File…').getByRole('alert')).toContainText('single file or folder name');
  await dialog('New File…').getByLabel('Name', { exact: true }).fill('sibling.inc');
  await dialog('New File…').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog('New File…')).toHaveCount(0);
  assert.deepEqual(await readFile(path.join(directory, 'scripts/nested.inc')), originalSource);
  await evaluate((workbench, target) => workbench.openPath(target), path.join(directory, 'scripts/nested.inc'));
  await append('// unsaved first\n');
  await evaluate((workbench, target) => workbench.openPath(target), path.join(directory, 'scripts/sibling.inc'));
  await append('// unsaved second\n');
  evidence.push('Keyboard creation rejects collisions and traversal without overwriting existing source.');

  await row('scripts').focus();
  await page.keyboard.press('F2');
  await dialog('Rename…').getByLabel('Name', { exact: true }).fill('renamed-scripts');
  await dialog('Rename…').getByRole('button', { name: 'Rename', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: /^Save changes to / });
  await expect(prompt).toContainText('nested.inc');
  await prompt.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(prompt).toContainText('sibling.inc');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog('Rename…').getByRole('button', { name: 'Rename', exact: true })).toBeEnabled();
  assert.equal((await stat(path.join(directory, 'scripts'))).isDirectory(), true);
  const retained = await evaluate((workbench) => workbench.getSnapshot().tabs.filter((tab) => tab.dirty).map((tab) => tab.name));
  assert.deepEqual(retained.sort(), ['nested.inc', 'sibling.inc']);
  await dialog('Rename…').getByRole('button', { name: 'Cancel', exact: true }).click();
  evidence.push('Cancelling the second dirty-file prompt during a folder rename keeps both unsaved buffers and the original disk paths.');

  await page.keyboard.press('Control+Alt+s');
  await row('scripts').focus();
  await page.keyboard.press('F2');
  await dialog('Rename…').getByLabel('Name', { exact: true }).fill('renamed-scripts');
  await dialog('Rename…').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog('Rename…')).toHaveCount(0);
  await expect(row('renamed-scripts')).toBeVisible();
  const renamedTabs = await evaluate((workbench) => workbench.getSnapshot().tabs);
  assert.equal(renamedTabs.filter((tab) => /renamed-scripts/.test(tab.uri)).length, 2);
  assert.match(await readFile(path.join(directory, 'renamed-scripts/nested.inc'), 'utf8'), /unsaved first/);
  await expect(page.locator('.external-notice')).toHaveCount(0);
  evidence.push('A confirmed folder rename moves real files, remaps all open document URIs and preserves saved contents without stale deleted-file notices.');

  await row('renamed-scripts').click();
  await expect(row('renamed-scripts')).toHaveAttribute('aria-expanded', 'true');
  await row('nested.inc').focus();
  await page.keyboard.press('ArrowUp');
  await expect(row('renamed-scripts')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(row('nested.inc')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Explorer actions', exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: /Move to Recycle Bin/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row('nested.inc')).toBeFocused();
  await row('renamed-scripts').click();
  await expect(row('nested.inc')).toHaveCount(0);
  await evaluate((workbench, target) => workbench.openPath(target), path.join(directory, 'renamed-scripts/nested.inc'));
  await page.keyboard.press('Control+Shift+f');
  await expect(page.locator('.workspace-search')).toBeVisible();
  await page.keyboard.press('Control+Shift+e');
  await expect(row('nested.inc')).toBeFocused();
  evidence.push('Arrow navigation, keyboard context-menu navigation/Escape, and Ctrl+Shift+E reveal work across a collapsed nested path and the Search sidebar.');

  await row('nested.inc').focus();
  await page.keyboard.press('F2');
  await dialog('Rename…').getByLabel('Name', { exact: true }).fill('NESTED.inc');
  await dialog('Rename…').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog('Rename…')).toHaveCount(0);
  await expect(row('NESTED.inc')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'NESTED.inc', exact: true })).toHaveAttribute('aria-selected', 'true');
  evidence.push('Case-only Windows rename updates disk spelling, the Explorer row and the active document tab.');

  await row('NESTED.inc').focus();
  await page.keyboard.press('F2');
  await dialog('Rename…').getByLabel('Name', { exact: true }).fill('sibling.inc');
  await dialog('Rename…').getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog('Rename…').getByRole('alert')).toContainText('destination is open in another tab');
  assert.match(await readFile(path.join(directory, 'renamed-scripts/NESTED.inc'), 'utf8'), /unsaved first/);
  assert.match(await readFile(path.join(directory, 'renamed-scripts/sibling.inc'), 'utf8'), /unsaved second/);
  await dialog('Rename…').getByRole('button', { name: 'Cancel', exact: true }).click();
  evidence.push('Renaming onto another open file is rejected without replacing either file or editor.');

  await row('renamed-scripts').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Move to Recycle Bin… Delete', exact: true }).click();
  await expect(dialog('Move to Recycle Bin…')).toContainText('everything inside');
  await dialog('Move to Recycle Bin…').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await stat(path.join(directory, 'renamed-scripts'))).isDirectory(), true);
  await row('renamed-scripts').focus();
  await page.keyboard.press('Delete');
  await dialog('Move to Recycle Bin…').getByRole('button', { name: 'Move to Recycle Bin', exact: true }).click();
  await expect(dialog('Move to Recycle Bin…')).toHaveCount(0);
  await expect(row('renamed-scripts')).toHaveCount(0);
  await expect(row('main.pwn')).toBeFocused();
  assert.equal((await evaluate((workbench) => workbench.getSnapshot().tabs)).filter((tab) => /renamed-scripts/.test(tab.uri)).length, 0);
  restoreRecycledFixtures();
  assert.match(await readFile(path.join(directory, 'renamed-scripts/NESTED.inc'), 'utf8'), /unsaved first/);
  evidence.push('Deletion requires explicit confirmation, Cancel leaves the folder intact, and the real Recycle Bin preserves the entire folder for restoration.');

  for (const theme of ['light', 'dark']) {
    await evaluate((workbench, theme) => workbench.settings({ theme }), theme);
    await page.getByRole('button', { name: 'Refresh Explorer', exact: true }).click();
    await expect(row('renamed-scripts')).toBeVisible();
    await row('renamed-scripts').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await mkdir(path.join(project, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(project, `test-results/explorer-${theme}.png`) });
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(project, 'test-results/explorer-workflows.json'), JSON.stringify(evidence, null, 2));
  console.log(evidence.join('\n'));
} catch (error) {
  console.error('Explorer verification failed:', error);
  console.error('Browser errors:', errors);
  console.error('Focus:', await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 500)));
  console.error('UI:', (await page.locator('body').innerText()).slice(-3500));
  throw error;
} finally {
  try {
    const closed = page.waitForEvent('close', { timeout: 20_000 });
    await evaluate(async (workbench) => {
      await Reflect.get(workbench, 'settingsQueue');
      workbench.subscribe(() => { if (workbench.getSnapshot().prompt) workbench.answerPrompt('discard'); });
      await workbench.quit();
    });
    await closed;
    restoreRecycledFixtures();
  } finally {
    if (seeded) {
      if (previous) await writeFile(preferences, previous);
      else await rm(preferences, { force: true });
    }
    await browser.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
