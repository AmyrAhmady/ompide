import { expect, it } from 'vitest';
import { protocolUri } from './uri';

it('canonicalizes Windows drives, Unicode, spaces, reserved characters and literal percent signs', () => {
  expect(protocolUri({ scheme: 'file', authority: '', path: '/c:/Pawn 🦀 # %.pwn', toString: () => '' })).toBe('file:///C:/Pawn%20%F0%9F%A6%80%20%23%20%25.pwn');
});
it('supports Unix paths, UNC authorities, and preserves non-file schemes', () => {
  expect(protocolUri({ scheme: 'file', authority: '', path: '/home/Pawn.inc', toString: () => '' })).toBe('file:///home/Pawn.inc');
  expect(protocolUri({ scheme: 'file', authority: 'server', path: '/share/main.pwn', toString: () => '' })).toBe('file://server/share/main.pwn');
  expect(protocolUri({ scheme: 'untitled', authority: '', path: 'New', toString: () => 'untitled:New' })).toBe('untitled:New');
});
