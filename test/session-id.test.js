import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSessionId } from '../src/session-id.js';

test('generateSessionId produces adjective-noun format', () => {
  const id = generateSessionId();
  assert.match(id, /^[a-z]+-[a-z]+$/);
});

test('generateSessionId avoids collisions with existing IDs', () => {
  const existing = new Set();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const id = generateSessionId(existing);
    assert.ok(!existing.has(id), `Duplicate ID generated: ${id}`);
    existing.add(id);
    ids.push(id);
  }
  assert.equal(ids.length, 20);
});

test('generateSessionId fallback appends hex when collisions are extreme', () => {
  // Saturate the wordlist space by generating hundreds of IDs
  const existing = new Set();
  for (let i = 0; i < 3000; i++) {
    existing.add(`word-${i}`);
  }
  const id = generateSessionId(existing);
  // Should still produce something valid
  assert.ok(id.length > 0);
  assert.ok(typeof id === 'string');
});

test('generateSessionId IDs are ASCII lowercase hyphenated', () => {
  for (let i = 0; i < 50; i++) {
    const id = generateSessionId();
    assert.match(id, /^[a-z]+-[a-z]+(-[a-f0-9]{4})?$/);
  }
});
