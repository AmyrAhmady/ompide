import { expect, it } from 'vitest';
import { createTranslator, describeError } from './i18n';
import english from '../locales/en.json';

it('loads an additional locale with named interpolation and English fallback', () => {
  const translate = createTranslator('fr', { 'editor.closeTab': 'Fermer {name}' });
  expect(translate('editor.closeTab', { name: 'main.pwn' })).toBe('Fermer main.pwn');
  expect(translate('command.save')).toBe('Save');
  expect(translate('status.position', { line: 5, column: 2 })).toBe('Ln 5, Col 2');
});
it('selects plural forms and maps backend codes to English resources', () => {
  const translate = createTranslator();
  expect(translate('status.problems', { count: 1 })).toBe('1 problem');
  expect(translate('status.problems', { count: 2 })).toBe('2 problems');
  expect(describeError({ code: 'conflict' })).toBe(english['error.conflict']);
  expect(describeError({ code: 'unknown' })).toBe(english['error.operationFailed']);
  expect(describeError({ code: 'toolVersion', parameters: { expected: '0.33.75', actual: 'pawn 1.34.38' } })).toContain('Expected pawnlsp 0.33.75, but the executable reports pawn 1.34.38');
});
