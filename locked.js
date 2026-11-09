import { randomUUID } from 'node:crypto';

export const PAIR_LOCK_TTL_S = 30;
export const PAIR_CACHE_TTL_S = 3000;

// One key per unordered pair, so A→B and B→A contend for the same lock.
export const pairKey = (a, b) => `conversation:${[a, b].sort().join('_')}`;

// The key is both the lock and the cache. The lock's value is the new
// conversation id, so a request that loses the claim reads the winner's id
// from the same key instead of creating its own.
//
// `blindRelease: true` reproduces the first version of this fix, whose catch
// block ran DEL on any error, including errors before this request claimed.
export async function createConversation(db, redis, userId, otherUserId, { blindRelease = false } = {}) {
  const key = pairKey(userId, otherUserId);
  if (blindRelease) return createV1(db, redis, key, userId, otherUserId);

  const cached = await redis.get(key);
  if (cached) return { conversationId: cached, created: false };

  const existing = await db.queryByParticipants(userId, otherUserId);
  if (existing.length) {
    const id = existing[0].conversation_id;
    await redis.set(key, id, { ex: PAIR_CACHE_TTL_S });
    return { conversationId: id, created: false };
  }

  const conversationId = randomUUID();
  const claimed = await redis.set(key, conversationId, { nx: true, ex: PAIR_LOCK_TTL_S });

  if (!claimed) {
    const winner = await redis.get(key);
    if (winner) return { conversationId: winner, created: false };
    throw new Error('conversation claim lost and winner not visible; retry');
  }

  try {
    await Promise.all([
      db.put({ user_id: userId, other_user_id: otherUserId, conversation_id: conversationId }),
      db.put({ user_id: otherUserId, other_user_id: userId, conversation_id: conversationId }),
    ]);
    await redis.set(key, conversationId, { ex: PAIR_CACHE_TTL_S });
    return { conversationId, created: true };
  } catch (err) {
    // Release only the claim this request holds. A blind DEL here would drop
    // another request's lock and reopen the race the lock exists to close.
    await redis.compareAndDelete(key, conversationId);
    throw err;
  }
}

async function createV1(db, redis, key, userId, otherUserId) {
  try {
    const cached = await redis.get(key);
    if (cached) return { conversationId: cached, created: false };

    const existing = await db.queryByParticipants(userId, otherUserId);
    if (existing.length) return { conversationId: existing[0].conversation_id, created: false };

    const conversationId = randomUUID();
    if (!(await redis.set(key, conversationId, { nx: true, ex: PAIR_LOCK_TTL_S }))) {
      return { conversationId: await redis.get(key), created: false };
    }
    await Promise.all([
      db.put({ user_id: userId, other_user_id: otherUserId, conversation_id: conversationId }),
      db.put({ user_id: otherUserId, other_user_id: userId, conversation_id: conversationId }),
    ]);
    await redis.set(key, conversationId, { ex: PAIR_CACHE_TTL_S });
    return { conversationId, created: true };
  } catch (err) {
    await redis.del(key); // may delete a lock this request never held
    throw err;
  }
}
