import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDynamo, FakeRedis } from './fakes.js';
import * as naive from './naive.js';
import * as locked from './locked.js';

const CONCURRENCY = 10;

// Half the calls go A→B and half B→A: a double-tap, a retry, and the other
// user opening the chat at the same moment.
const burst = (fn) =>
  Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => (i % 2 ? fn('alice', 'bob') : fn('bob', 'alice'))));

test('naive check-then-create makes duplicate conversations under concurrency', async () => {
  const db = new FakeDynamo();
  await burst((a, b) => naive.createConversation(db, a, b));
  assert.ok(db.conversationsFor('alice', 'bob').size > 1, 'expected the race to produce duplicates');
});

test('Redis pair lock yields exactly one conversation, and every caller gets its id', async () => {
  const db = new FakeDynamo();
  const redis = new FakeRedis();
  const results = await burst((a, b) => locked.createConversation(db, redis, a, b));

  const ids = db.conversationsFor('alice', 'bob');
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert.ok(results.every((r) => r.conversationId === id));
  assert.equal(results.filter((r) => r.created).length, 1);
});

// Request B read the cache before A claimed, then its DynamoDB query threw
// after A claimed. Modelled by a Redis whose first GET misses.
async function failWhileAnotherHoldsClaim(opts) {
  const db = new FakeDynamo();
  const redis = new FakeRedis();
  const key = locked.pairKey('alice', 'bob');
  await redis.set(key, 'claimed-by-A', { nx: true, ex: locked.PAIR_LOCK_TTL_S });

  const staleFirstGet = Object.create(redis);
  let first = true;
  staleFirstGet.get = async (k) => (first ? ((first = false), null) : redis.get(k));
  db.failNextQuery = true;

  await assert.rejects(locked.createConversation(db, staleFirstGet, 'alice', 'bob', opts));
  return redis.get(key);
}

test('v1 (blind DEL on error) drops another request\'s lock', async () => {
  assert.equal(await failWhileAnotherHoldsClaim({ blindRelease: true }), null);
});

test('fixed version leaves another request\'s lock in place', async () => {
  assert.equal(await failWhileAnotherHoldsClaim(), 'claimed-by-A');
});

test('compare-and-delete leaves another request\'s claim in place', async () => {
  const redis = new FakeRedis();
  const key = locked.pairKey('alice', 'bob');
  await redis.set(key, 'A', { nx: true, ex: 30 });
  assert.equal(await redis.compareAndDelete(key, 'B'), 0);
  assert.equal(await redis.get(key), 'A');
  assert.equal(await redis.compareAndDelete(key, 'A'), 1);
  assert.equal(await redis.get(key), null);
});
