import { expect, it } from 'vitest';
import { BufferVersion } from './documents';

it('handles undo back to the saved version and edits made while a save is in flight', () => {
  const buffer = new BufferVersion(1);
  buffer.changed(2);
  expect(buffer.dirty).toBe(true);
  const captured = buffer.current;
  buffer.changed(3);
  buffer.savedAt(captured);
  expect(buffer.dirty).toBe(true);
  buffer.changed(2); // Undo the edit made while saving.
  expect(buffer.dirty).toBe(false);
  buffer.changed(1); // Undo past the saved state.
  expect(buffer.dirty).toBe(true);
});
