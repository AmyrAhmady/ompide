import dark from './themes/dark.json';
import light from './themes/light.json';

export type ThemeColor = keyof typeof dark.colors;
export interface Theme {
  schemaVersion: 1;
  name: string;
  base: 'light' | 'dark';
  colors: Record<ThemeColor, string>;
  tokenColors: { scope: string; settings: { foreground: string } }[];
}
export const defaultThemes: Record<'dark' | 'light', Theme> = { dark: dark as Theme, light: light as Theme };
const hex = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseTheme(value: unknown): Theme {
  if (!object(value) || value.schemaVersion !== 1 || !['light', 'dark'].includes(String(value.base)) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64) {
    throw new Error('Expected schemaVersion 1, a name (1–64 characters), and base light or dark');
  }
  const base = value.base as 'light' | 'dark';
  const defaults = defaultThemes[base];
  const colors = { ...defaults.colors };
  if (value.colors !== undefined) {
    if (!object(value.colors)) throw new Error('colors must be an object');
    for (const [key, color] of Object.entries(value.colors)) {
      if (!Object.prototype.hasOwnProperty.call(colors, key) || typeof color !== 'string' || !hex.test(color)) throw new Error(`Invalid color token: ${key}`);
      colors[key as ThemeColor] = color;
    }
  }
  let tokenColors = defaults.tokenColors;
  if (value.tokenColors !== undefined) {
    if (!Array.isArray(value.tokenColors) || value.tokenColors.length > 500) throw new Error('tokenColors must be an array with at most 500 rules');
    tokenColors = value.tokenColors.map((rule: unknown) => {
      if (!object(rule) || typeof rule.scope !== 'string' || rule.scope.length > 256 || !object(rule.settings) || typeof rule.settings.foreground !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(rule.settings.foreground)) throw new Error('Invalid syntax color rule');
      return { scope: rule.scope, settings: { foreground: rule.settings.foreground } };
    });
  }
  return { schemaVersion: 1, name: value.name, base, colors, tokenColors };
}

export function themeVariables(theme: Theme): Record<string, string> {
  return Object.fromEntries(Object.entries(theme.colors).map(([token, color]) => [`--${token.replaceAll('.', '-')}`, color]));
}
