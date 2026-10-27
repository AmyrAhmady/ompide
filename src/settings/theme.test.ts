import { expect, it } from 'vitest';
import { defaultThemes, parseTheme, themeVariables } from './theme';

it('provides complete light/dark defaults and custom overrides with fallback', () => {
  for (const theme of Object.values(defaultThemes)) expect(parseTheme(theme)).toEqual(theme);
  const theme = parseTheme({ schemaVersion: 1, name: 'Custom', base: 'dark', colors: { 'editor.background': '#123456' } });
  expect(theme.colors['editor.background']).toBe('#123456');
  expect(theme.colors['panel.border']).toBe(defaultThemes.dark.colors['panel.border']);
  expect(themeVariables(theme)['--editor-background']).toBe('#123456');
});
it('rejects unsupported schemas, arbitrary CSS, and malformed syntax colors', () => {
  for (const value of [null, { schemaVersion: 2 }, { schemaVersion: 1, name: 'Bad', base: 'dark', colors: { 'editor.background': 'url(https://example.com)' } }, { schemaVersion: 1, name: 'Bad', base: 'light', tokenColors: [{}] }]) expect(() => parseTheme(value)).toThrow();
});
