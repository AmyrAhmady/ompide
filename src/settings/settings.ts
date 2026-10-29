export interface Settings {
  theme: 'light' | 'dark';
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  formatOnSave: boolean;
  languageServerPath: string;
  compilerPath: string;
  pawnPath: string;
}
export const defaults: Settings = {
  theme: 'dark', fontSize: 14, fontFamily: 'Consolas, "Cascadia Code", monospace',
  tabSize: 4, insertSpaces: true, wordWrap: false, minimap: false, formatOnSave: false,
  languageServerPath: '',
  compilerPath: '', pawnPath: '',
};
export function parseSettings(value: unknown): Settings {
  const settings = { ...defaults };
  if (typeof value !== 'object' || value === null) return settings;
  const source = value as Record<string, unknown>;
  if (source.theme === 'light' || source.theme === 'dark') settings.theme = source.theme;
  for (const key of ['fontSize', 'tabSize'] as const) {
    const maximum = key === 'fontSize' ? 48 : 8;
    const minimum = key === 'fontSize' ? 8 : 1;
    if (typeof source[key] === 'number' && Number.isInteger(source[key]) && source[key] >= minimum && source[key] <= maximum) settings[key] = source[key];
  }
  if (typeof source.fontFamily === 'string' && source.fontFamily.length <= 256) settings.fontFamily = source.fontFamily;
  if (typeof source.languageServerPath === 'string' && source.languageServerPath.length <= 32768) settings.languageServerPath = source.languageServerPath;
  for (const key of ['compilerPath', 'pawnPath'] as const) if (typeof source[key] === 'string' && source[key].length <= 32768) settings[key] = source[key];
  for (const key of ['insertSpaces', 'wordWrap', 'minimap', 'formatOnSave'] as const) if (typeof source[key] === 'boolean') settings[key] = source[key];
  return settings;
}
