# Duplicate-conversation race: reproduction and fix

A minimal, runnable reproduction of a production bug I fixed in a chat microservice (Node.js, DynamoDB, Redis). The original code is in a private client codebase, so this repo rebuilds the bug and the fix with in-memory fakes. Names and details are simplified, and the logic is the same.

```
npm test   # Node 20+, no dependencies, no infrastructure
```

## The bug

`createConversation(user, otherUser)` should be idempotent: one conversation per pair. It was check-then-create:

1. Query the participant GSI for an existing conversation.
2. If none, generate an id and write two rows, one per participant.

The steps aren't atomic, and DynamoDB can't reject the duplicate: the table key is `(user_id, conversation_id)` and every request generates a new id. GSI reads are eventually consistent, which widens the window. Double-taps, client retries, and both users opening the chat at once all triggered it.

```
A: query GSI → none          B: query GSI → none
A: id = AAA                  B: id = BBB
A: write 2 rows              B: write 2 rows      → two conversations for one pair
```

Users saw two threads with the same person, with messages split between them and wrong unread counts.

## The fix

One Redis key per unordered pair, `conversation:{min}_{max}`, serves as both the lock and the cache. The lock's value is the new conversation id, so a request that loses the claim reads the winner's answer from the same key.

1. **Cache hit**: return the id.
2. **Found in DynamoDB**: cache it, return it.
3. **Claim**: `SET key <new_id> NX EX 30`. Only one concurrent request gets `OK`.
4. **Lost the claim**: `GET key` and return the winner's id. Write nothing.
5. **Won the claim**: write both rows, then re-set the key with a 50-minute TTL so the lock becomes the cache.
6. **Error after claiming**: release with compare-and-delete, then rethrow.

## A bug in the first version of the fix

The first version ran `DEL key` on any error, including errors before the request had claimed anything. If request B's DynamoDB query failed while A held the claim, B deleted A's lock and a third request could create a duplicate. The fix releases only a claim the request holds, and only if the value still matches (a compare-and-delete Lua script in Redis). `blindRelease: true` in `locked.js` keeps the old behaviour so the test can show the difference.

## Tests (`race.test.js`)

| Test | Asserts |
| --- | --- |
| naive check-then-create | 10 concurrent calls (A→B and B→A) create more than one conversation |
| Redis pair lock | the same burst creates exactly one, every caller gets its id, and exactly one reports `created` |
| v1 blind DEL | a failing request deletes another request's lock |
| fixed release | the other request's lock survives |
| compare-and-delete | only the holder's value is deleted |

## Known limits

- **Fails open.** If Redis is down the claim is skipped, so chat keeps working but the race can return. This was a deliberate availability-over-strictness choice.
- **The loser can get the id before the winner's rows exist.** A message sent in that gap can fail a participant check.
- **Row writes aren't transactional.** `TransactWriteItems` would make the pair all-or-nothing.
- **Redis is the only guard.** A deterministic id (`conv_{min}_{max}`) or a pair item written with `attribute_not_exists` would make duplicates impossible in DynamoDB itself.
