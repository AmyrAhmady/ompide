// Runs against the real debug desktop application with an explicitly enabled loopback CDP port.
// Start Vite, then set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// only for the application process. This does not mock Tauri commands or PawnKit.
import { chromium, expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('1420'));
if (!page) { await browser.close(); throw new Error('The debug desktop application is not connected to Vite'); }
const workspace = await mkdtemp(path.join(tmpdir(), 'pawn desktop '));
const preferences = path.join(process.env.APPDATA, 'mp.open.editor/preferences.json');
let previous;
let seeded = false;
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); if (message.type() === 'warning') console.error('SERVER/WARNING:', message.text()); });
try {
  try { previous = await readFile(preferences); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(preferences), { recursive: true });
  await cp(path.join(root, 'fixtures/minimal'), workspace, { recursive: true, filter: file => !file.includes(`${path.sep}output`) });
  seeded = true;
  await writeFile(preferences, JSON.stringify({ recentWorkspaces: [workspace], settings: { theme: 'dark' } }));
  await page.reload();
  await page.getByRole('button', { name: workspace, exact: true }).click();
  await expect(page.locator('.window-title')).toHaveText(path.basename(workspace));
  await expect(page.getByText('Pawn language server connected', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'main.pwn', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'main.pwn', exact: true })).toBeVisible();
  await page.locator('.menu summary').getByText('File', { exact: true }).click();
  const openFolder = page.getByRole('menuitem', { name: 'Open Folder… Ctrl+K Ctrl+O', exact: true });
  await expect(openFolder).toBeVisible();
  expect(await openFolder.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(element.ownerDocument.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  await page.locator('.menu summary').getByText('File', { exact: true }).click();
  const results = await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    const session = Reflect.get(workbench, 'language');
    const active = workbench.getSnapshot().active;
    const document = session.client.code2ProtocolConverter.asUri(Reflect.get(workbench, 'documents').get(active).model.uri);
    const completion = await session.client.sendRequest('textDocument/completion', { textDocument: { uri: document }, position: { line: 4, character: 19 } });
    const definition = await session.client.sendRequest('textDocument/definition', { textDocument: { uri: document }, position: { line: 4, character: 18 } });
    return { completion, definition, active, modelId: Reflect.get(workbench, 'documents').get(active).model.id };
  });
  expect((Array.isArray(results.completion) ? results.completion : results.completion.items).some(item => item.label === 'Add')).toBe(true);
  expect(JSON.stringify(results.definition)).toContain('math.inc');
  // Exercise the installed Monaco provider, not only a raw request.
  await page.evaluate(async uri => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    await workbench.openUri(uri, 5, 20);
  }, results.active);
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget.visible')).toBeVisible();
  await expect(page.locator('.suggest-widget.visible')).toContainText('Add');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F12');
  await expect(page.getByRole('tab', { name: 'math.inc', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'main.pwn', exact: true }).click();
  expect(await page.evaluate(async uri => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    const model = Reflect.get(workbench, 'documents').get(uri).model;
    await workbench.openUri(uri);
    return { modelId: Reflect.get(workbench, 'documents').get(uri).model.id, reused: Reflect.get(workbench, 'documents').get(uri).model === model, position: Reflect.get(workbench, 'codeEditor').getPosition() };
  }, results.active)).toEqual({ modelId: results.modelId, reused: true, position: { lineNumber: 5, column: 20 } });
  await page.screenshot({ path: path.join(root, 'test-results/native-editor-dark.png') });
  // Real typing, save, undo, cancel/discard and reopen preserve the disk contents.
  await page.locator('.monaco-editor').click({ position: { x: 250, y: 100 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// desktop smoke 🦀');
  await expect(page.locator('.tab.active .dirty')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab.active .dirty')).toHaveCount(0);
  expect(await readFile(path.join(workspace, 'main.pwn'), 'utf8')).toContain('// desktop smoke 🦀');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.tab.active .dirty')).toBeVisible();
  await page.getByRole('button', { name: 'Close main.pwn', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'main.pwn', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close main.pwn', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'main.pwn', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+t');
  await expect(page.getByRole('tab', { name: 'main.pwn', exact: true })).toBeVisible();
  expect(await readFile(path.join(workspace, 'main.pwn'), 'utf8')).toContain('// desktop smoke 🦀');
  // External disk changes must reload clean buffers and preserve dirty buffers.
  const mainPath = path.join(workspace, 'main.pwn');
  await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '\n// external clean change');
  await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll('\u00a0', ' ')).toContain('external clean change');
  await expect(page.locator('.tab.active .dirty')).toHaveCount(0);
  await page.locator('.monaco-editor').click({ position: { x: 200, y: 100 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// keep this dirty edit');
  await writeFile(mainPath, (await readFile(mainPath, 'utf8')) + '\n// external conflicting change');
  await expect(page.locator('.external-notice')).toContainText('changed on disk');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('keep this dirty edit');
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('external conflicting change');
  await page.getByRole('button', { name: 'Reload from Disk', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('external conflicting change');
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('keep this dirty edit');
  await rename(mainPath, path.join(workspace, 'moved.pwn'));
  await expect(page.locator('.external-notice')).toContainText('moved or deleted');
  await expect(page.getByRole('button', { name: 'moved.pwn', exact: true })).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('external conflicting change');
  await rename(path.join(workspace, 'moved.pwn'), mainPath);
  await expect(page.locator('.external-notice')).toHaveCount(0);
  // Invalid argument count must reach Monaco's Problems UI via the client's diagnostic feature.
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    const document = Reflect.get(workbench, 'documents').get(workbench.getSnapshot().active);
    document.model.setValue(document.model.getValue().replace('Add(1, 2)', 'Add(1)'));
  });
  await page.keyboard.press('Control+j');
  await expect.poll(async () => page.locator('.problems-panel li').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.keyboard.press('Control+s');
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('combobox').selectOption('light');
  await expect(page.locator('.workbench')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.monaco-editor-background').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect.poll(async () => JSON.parse(await readFile(preferences, 'utf8')).settings.theme).toBe('light');
  await page.getByLabel('Font family', { exact: true }).fill('Consolas');
  await page.getByLabel('Font size', { exact: true }).fill('18');
  await page.getByLabel('Tab size', { exact: true }).fill('2');
  await page.getByLabel('Word wrap', { exact: true }).check();
  await page.getByLabel('Minimap', { exact: true }).check();
  await expect.poll(async () => JSON.parse(await readFile(preferences, 'utf8')).settings).toMatchObject({ theme: 'light', fontFamily: 'Consolas', fontSize: 18, tabSize: 2, wordWrap: true, minimap: true });
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'test-results/native-editor-light.png') });
  // Save All must persist each model, and history must grant only previously opened files.
  await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    for (const document of Reflect.get(workbench, 'documents').values()) document.model.setValue(document.model.getValue() + '\n// save all smoke\n');
  });
  await page.keyboard.press('Control+Alt+s');
  await expect(page.locator('.tab .dirty')).toHaveCount(0);
  for (const file of ['main.pwn', 'math.inc']) expect(await readFile(path.join(workspace, file), 'utf8')).toContain('// save all smoke');
  expect(JSON.parse(await readFile(preferences, 'utf8')).recentFiles).toContain(path.join(workspace, 'main.pwn'));
  expect(await page.evaluate(async outside => {
    const { native } = await import('/src/lib/native.ts');
    try { await native.recentDocument(outside); return 'unexpected access'; } catch (error) { return error.code; }
  }, path.join(root, 'README.md'))).toBe('permissionDenied');
  await page.getByRole('button', { name: 'Close main.pwn', exact: true }).click();
  await page.getByRole('button', { name: 'Close math.inc', exact: true }).click();
  await page.getByRole('button', { name: path.join(workspace, 'main.pwn'), exact: true }).click();
  await expect(page.getByRole('tab', { name: 'main.pwn', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'math.inc', exact: true }).click();
  await page.getByRole('tab', { name: 'main.pwn', exact: true }).click();
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
  await page.locator('.monaco-editor').click({ position: { x: 150, y: 30 } });
  await page.keyboard.type('main() {}');
  await page.getByRole('button', { name: 'Close Untitled-1', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveCount(0);
  if (process.argv.includes('--close')) {
    await page.evaluate(async () => {
      const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
      const { workbench } = await import(moduleUrl);
      for (const document of Reflect.get(workbench, 'documents').values()) document.model.setValue(document.model.getValue() + '\n// unsaved close test');
    });
    const exit = async () => { await page.locator('.menu summary').getByText('File', { exact: true }).click(); await page.getByRole('menuitem', { name: 'Exit', exact: true }).click(); };
    await exit();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.locator('.tab .dirty')).toHaveCount(2);
    await exit();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    const closed = page.waitForEvent('close');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await closed;
    console.log('Native Exit: cancel preserves all tabs and edits; discard closes the real window');
  }
  console.log('Real desktop: Tauri channel, completion UI, F12 navigation, new/edit/save/save-all/undo, dirty close prompts, reopen/recent-file scope, external clean/dirty changes and rename, Problems diagnostics, and persisted Light/Dark switching passed');
  if (errors.length) throw new Error(errors.join('\n'));
} catch (error) {
  console.error('Desktop verification failed:', error);
  console.error('Captured browser errors:', errors);
  if (!page.isClosed()) console.error('Runtime diagnostic evidence:', await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    const state = workbench.getSnapshot();
    const document = Reflect.get(workbench, 'documents').get(state.active);
    const session = Reflect.get(workbench, 'language');
    const collection = [];
    session?.client.diagnostics?.forEach((uri, diagnostics) => collection.push({ uri: uri.toString(), diagnostics }));
    const textDocument = document && { uri: session?.client.code2ProtocolConverter.asUri(document.model.uri) };
    return { status: state.status, problems: state.problems, active: state.active, text: document?.model.getValue(), modelUri: document?.model.uri.toString(), collection, raw: session?.client.isRunning() ? await session.client.sendRequest('textDocument/diagnostic', { textDocument }) : undefined, formatting: session?.client.isRunning() ? await session.client.sendRequest('textDocument/formatting', { textDocument, options: { tabSize: 4, insertSpaces: true } }) : undefined };
  }));
  throw error;
} finally {
  try { if (!page.isClosed()) await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => /\/src\/app\/workbench\.ts(?:\?|$)/.test(url));
    const { workbench } = await import(moduleUrl);
    await Reflect.get(workbench, 'settingsQueue');
    await Reflect.get(workbench, 'stopLanguage').call(workbench);
    await Reflect.get(workbench, 'stopWatching').call(workbench);
  });
  if (!page.isClosed()) await page.reload();
  } finally {
    if (seeded) { if (previous) await writeFile(preferences, previous); else await rm(preferences, { force: true }); }
    await browser.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => console.error('Temporary workspace cleanup failed:', error.message));
  }
}
