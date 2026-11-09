// In-memory stand-ins for DynamoDB and Redis, so the race reproduces with
// `node --test` and no infrastructure. They model only what matters here:
// network latency, an eventually consistent GSI, and Redis's atomic SET NX.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (max) => sleep(Math.random() * max);

// Table keyed by (user_id, conversation_id), plus a participant GSI on
// (user_id, other_user_id). GSI reads only see rows older than gsiLagMs.
export class FakeDynamo {
  constructor({ latencyMs = 5, gsiLagMs = 20 } = {}) {
    this.rows = new Map();
    this.latencyMs = latencyMs;
    this.gsiLagMs = gsiLagMs;
    this.failNextQuery = false;
  }

  async put(row) {
    await jitter(this.latencyMs);
    // The primary key includes conversation_id, so a second conversation for
    // the same pair is never a conflict. Nothing here rejects a duplicate.
    this.rows.set(`${row.user_id}#${row.conversation_id}`, { ...row, writtenAt: Date.now() });
  }

  async queryByParticipants(user_id, other_user_id) {
    await jitter(this.latencyMs);
    if (this.failNextQuery) {
      this.failNextQuery = false;
      throw new Error('ProvisionedThroughputExceededException');
    }
    const visibleBefore = Date.now() - this.gsiLagMs;
    return [...this.rows.values()].filter(
      (r) => r.user_id === user_id && r.other_user_id === other_user_id && r.writtenAt <= visibleBefore,
    );
  }

  conversationsFor(a, b) {
    const ids = new Set();
    for (const r of this.rows.values()) {
      if ((r.user_id === a && r.other_user_id === b) || (r.user_id === b && r.other_user_id === a)) {
        ids.add(r.conversation_id);
      }
    }
    return ids;
  }
}

export class FakeRedis {
  constructor({ latencyMs = 2 } = {}) {
    this.store = new Map();
    this.latencyMs = latencyMs;
  }

  #live(key) {
    const e = this.store.get(key);
    if (e && e.expiresAt <= Date.now()) this.store.delete(key);
    return this.store.get(key);
  }

  async get(key) {
    await jitter(this.latencyMs);
    return this.#live(key)?.value ?? null;
  }

  // set(key, value, { nx, ex }) — the check and the write happen in one
  // synchronous step after the await, which is what makes NX atomic.
  async set(key, value, { nx = false, ex } = {}) {
    await jitter(this.latencyMs);
    if (nx && this.#live(key)) return null;
    this.store.set(key, { value, expiresAt: ex ? Date.now() + ex * 1000 : Infinity });
    return 'OK';
  }

  async del(key) {
    await jitter(this.latencyMs);
    return this.store.delete(key) ? 1 : 0;
  }

  // Equivalent of the Lua script:
  //   if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0
  async compareAndDelete(key, expected) {
    await jitter(this.latencyMs);
    if (this.#live(key)?.value !== expected) return 0;
    this.store.delete(key);
    return 1;
  }
}
