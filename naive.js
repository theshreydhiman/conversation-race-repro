import { randomUUID } from 'node:crypto';

// The original check-then-create. Two overlapping calls can both see "none"
// and both create, because the read and the write are not atomic.
export async function createConversation(db, userId, otherUserId) {
  const existing = await db.queryByParticipants(userId, otherUserId);
  if (existing.length) return { conversationId: existing[0].conversation_id, created: false };

  const conversationId = randomUUID();
  await Promise.all([
    db.put({ user_id: userId, other_user_id: otherUserId, conversation_id: conversationId }),
    db.put({ user_id: otherUserId, other_user_id: userId, conversation_id: conversationId }),
  ]);
  return { conversationId, created: true };
}
