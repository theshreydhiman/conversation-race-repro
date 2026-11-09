import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDynamo } from './fakes.js';
import * as naive from './naive.js';

const CONCURRENCY = 10;
const burst = (fn) =>
  Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => (i % 2 ? fn('alice', 'bob') : fn('bob', 'alice'))));

test('naive check-then-create makes duplicate conversations under concurrency', async () => {
  const db = new FakeDynamo();
  await burst((a, b) => naive.createConversation(db, a, b));
  assert.ok(db.conversationsFor('alice', 'bob').size > 1, 'expected the race to produce duplicates');
});
