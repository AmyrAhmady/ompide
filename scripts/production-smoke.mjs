// UI-only verification of the actual bundled frontend. No dev-module imports or mock IPC.
// Launch an `npm.cmd run tauri -- build --debug --no-bundle` executable with loopback CDP enabled.
import { chromium, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'toolchain/tools.json'), 'utf8'));
for (const name of ['pawnlsp']) {
  const tool = pins.tools.find(tool => tool.name === name);
  const bytes = await readFile(path.join(root, `src-tauri/target/debug/${name}.exe`));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(tool.executableSha256);
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap(context => context.pages()).find(page => /^https?:\/\/tauri\.localhost\/?/.test(page.url()));
if (!page) { await browser.close(); throw new Error('Expected the bundled tauri.localhost application, not a Vite page'); }
page.setDefaultTimeout(15_000);
const workspace = await mkdtemp(path.join(tmpdir(), 'pawn bundled '));
const preferences = path.join(process.env.APPDATA, 'mp.open.editor/preferences.json');
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
let previous;
let seeded = false;
async function exit() {
  await page.locator('.menu summary').getByText('File', { exact: true }).click();
  const closed = page.waitForEvent('close');
  await page.getByRole('menuitem', { name: 'Exit', exact: true }).click();
  await closed;
}
try {
  try { previous = await readFile(preferences); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(preferences), { recursive: true });
  await cp(path.join(root, 'fixtures/minimal'), workspace, { recursive: true, filter: file => !file.includes(`${path.sep}output`) });
  seeded = true;
  await writeFile(preferences, JSON.stringify({ recentWorkspaces: [workspace], recentFiles: [], settings: { theme: 'dark' } }));
  await page.reload();
  await page.getByRole('button', { name: workspace, exact: true }).click();
  await expect(page.locator('.window-title')).toHaveText(path.basename(workspace));
  await expect(page.getByText('Pawn language server connected', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'main.pwn', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'main.pwn', exact: true })).toBeVisible();
  await page.locator('.monaco-editor').click({ position: { x: 250, y: 100 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+f');
  await page.keyboard.type('Add');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget.visible')).toContainText('Add');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F12');
  await expect(page.getByRole('tab', { name: 'math.inc', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'main.pwn', exact: true }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// bundled runtime 🦀\n');
  await expect(page.locator('.tab.active .dirty')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab.active .dirty')).toHaveCount(0);
  expect(await readFile(path.join(workspace, 'main.pwn'), 'utf8')).toContain('// bundled runtime 🦀');
  const invalid = (await readFile(path.join(workspace, 'main.pwn'), 'utf8')).replace('Add(1, 2)', 'Add(1)');
  await page.keyboard.press('Control+a');
  await page.keyboard.type(invalid);
  await page.keyboard.press('Control+j');
  await expect.poll(() => page.locator('.problems-panel li').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab .dirty')).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await page.getByRole('combobox', { name: 'Color theme', exact: true }).selectOption('light');
  await expect(page.locator('.workbench')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.monaco-editor-background').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect.poll(async () => JSON.parse(await readFile(preferences, 'utf8')).settings.theme).toBe('light');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results/production-editor.png') });
  await exit();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Bundled frontend: native startup/IPC, real completion and F12, Unicode editing/save, real diagnostics, Light/Dark persistence, and Exit passed without Vite or development-module access');
} catch (error) {
  console.error('Bundled frontend verification failed:', error);
  console.error('Browser errors:', errors);
  if (!page.isClosed()) {
    console.error((await page.locator('body').innerText()).slice(0, 2000));
    await page.screenshot({ path: path.join(root, 'test-results/production-failure.png') });
  }
  throw error;
} finally {
  try {
    // These are disposable fixtures; reload clears any failed test's in-memory edits.
    if (!page.isClosed()) { page.once('dialog', dialog => dialog.accept()); await page.reload(); await exit(); }
  } finally {
    if (seeded) { if (previous) await writeFile(preferences, previous); else await rm(preferences, { force: true }); }
    await browser.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
