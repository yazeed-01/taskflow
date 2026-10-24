# What I learned building TaskFlow

A study guide written from the real project: a mini Linear/Jira on GraphQL (Apollo Server 4 + Apollo Client 3 +
SQLite), load-tested on a 0.5 vCPU server with 5.1 million rows. Every point links to where it lives in the code.

**How to use this file:** the first part is GraphQL knowledge (and what the Apollo Associate exam asks). The second part
is engineering decisions that worked. The third is performance knowledge. The last part is mistakes — which taught the most.

---

## Part 1 — GraphQL knowledge

### 1.1 Design the schema first, from the screen
The schema (`server/src/schema.graphql`) was written before any resolver. Ask "what does this screen need?", not "what
tables do I have?". The schema is a **contract**: the client team can build against it (or a mock) while the server is built.
*Exam:* "schema-first / client-driven" is a core idea.

### 1.2 Nullability is a promise
- `[Issue!]!` = the list exists and no item is null. `[Issue]` = anything may be null.
- Only write `!` when the field can **never** fail. If a non-null field's resolver throws, the null **bubbles up** to the nearest
  nullable parent, and can wipe out a whole object.
- A mutation's success payload is non-null (`issue: Issue!`) *because* failure is a different union member, not a null.
*Exam trap:* the four combinations of `[String]`, `[String!]`, `[String]!`, `[String!]!`.

### 1.3 Resolvers: `(parent, args, contextValue, info)`
- Every field has a resolver; the default one reads `parent[fieldName]`. You only write the ones that do real work.
- `contextValue` is built **once per request** (`server/src/context.ts`): who is calling, plus DataLoaders. That is where
  authentication lives. Authorization lives in resolvers (or the data layer).
*Exam trap:* the parameter order. `contextValue` is third, not first.

### 1.4 Mutations: input type in, payload type out
`createIssue(input: CreateIssueInput!): CreateIssueResult!` — a single `input` object and a result type means you can add
fields later without breaking any client. This is Apollo's "mutation response" pattern.

### 1.5 Errors as data (the best idea in the project)
Two kinds of failure, handled differently:

| Kind | Examples | How |
|---|---|---|
| **Expected** | bad input, not found, not allowed | A **union member**: `CreateIssuePayload \| ValidationError \| NotFoundError \| ForbiddenError` |
| **Unexpected** | database down, a bug, not signed in, rate limited | Thrown → appears in the top-level `errors` array |

Why unions win: the client must handle each case (the type system forces it), errors are typed and documented in the schema,
and partial success is possible. See `server/src/errors.ts` (a 20-line wrapper turns a thrown `GraphQLError` into a union member).
*Trade-off:* every mutation selection needs `... on UserError { message }`.

### 1.6 Global IDs and the `Node` interface
IDs are `base64url("Type:dbId")`. Result: `node(id)` can fetch anything, and an `Issue` ID is rejected where a `Project` ID is
expected. It also hides database ids. (`server/src/ids.ts`)

### 1.7 Pagination: use cursors, not offsets
- Offset (`LIMIT 20 OFFSET 40`) repeats or skips rows if data changes between pages, and gets slower the deeper you go.
- **Keyset/cursor**: the cursor remembers the last row's sort key + id; the next page is "rows after that key". Stable and index-friendly.
- Fetch `first + 1` rows: the extra row tells you `hasNextPage` without a `COUNT`.
- A cursor is only valid for the ordering it was created under (we reject mixing them).
- The Relay shape (`edges { cursor node }`, `pageInfo`) is the standard GitHub/Shopify use. (`server/src/pagination.ts`)

### 1.8 The N+1 problem and DataLoader
Loading 50 issues and resolving each assignee separately = 51 queries. **DataLoader** collects every `.load(id)` in one
event-loop tick and runs one `WHERE id IN (...)`.
- Measured: **454 SQL queries → 13** for a 50-issue board.
- Create loaders **per request**. A shared one would cache one user's data and serve it to another.
- Loaders skip permission checks — only use them for children of something already authorized.
- Results must come back in the same order as the keys.

### 1.9 Authentication vs authorization
- *Authentication* (who are you?): JWT in `Authorization: Bearer`, verified in the context function.
- *Authorization* (may you?): checked in resolvers via one function (`authorize(user, workspace, minRole)`).
- **Don't reveal existence**: a non-member gets `NOT_FOUND`/`null`, not `FORBIDDEN`, so you can't probe for private ids.
- **Field-level**: `User.email` is `null` unless it is you or someone you share a workspace with.
- Check tenant boundaries on *related* ids too (an assignee from another workspace must be refused).

### 1.10 Subscriptions
- Same schema, transport is a WebSocket (`graphql-ws`); the token goes in `connectionParams` because browsers can't set WS headers.
- **Authorize twice**: when subscribing *and* on every event, otherwise a removed member keeps receiving data.
- A long-lived socket reuses one context → **DataLoader caches go stale**. Clear them per event (bug found by a test).
- Default `PubSub` is in-memory = one server only. Scale-out needs Redis.

### 1.11 Apollo Client
- **Normalized cache**: every object with `__typename` + `id` is stored once as `Issue:abc`. Update it in one place (a mutation
  result, a subscription event) and every screen showing it updates.
- The cache can't know **list membership** ("this new issue belongs on this board") — you tell it with `cache.modify`. Make
  those helpers **idempotent** (the same item can arrive from the mutation *and* the subscription) — `client/src/lib/cache.ts`.
- **Optimistic updates** (`optimisticResponse`): the UI changes instantly; if the request fails, Apollo throws the optimistic
  layer away and the UI snaps back — **no rollback code**. (Verified in a real browser by killing the API mid-drag.)
- **Fragments colocated with components**: `IssueCard` declares `fragment IssueCard on Issue`; parents spread it. Change the
  card, and every query that renders it follows.
- `relayStylePagination(keyArgs)` tells the cache how to merge pages; different filters become different cached lists.
- **Codegen**: GraphQL Code Generator checks every query against the schema at build time and gives typed hooks. A renamed server
  field fails the *build*, not production.

### 1.12 What belongs to which certification
The Associate exam covers: SDL, resolvers, `contextValue`, `RESTDataSource`, `GraphQLError` codes, queries/variables/fragments,
mutations, Apollo Client hooks, cache basics, Studio. This project went **beyond** it (DataLoader, subscriptions, complexity
limits, union errors, FTS). Federation (`@key`, supergraphs) is Professional-level and was deliberately not used.

---

## Part 2 — Good decisions (and why they paid off)

| Decision | Why it was right |
|---|---|
| **Schema before code** | The client and the tests could be written against a stable contract. |
| **Integration tests that run real operations** (not mocks) | Caught real bugs: stale loader caches on sockets, the empty `identifier` string from a shell-mangled edit, the removed-member leak. 61 tests. |
| **Tests on a throwaway database** | My tests had polluted `dev.db` with junk; a fresh seeded `test.db` per run made them repeatable and safe. |
| **Measure first, then optimize** | A per-operation CPU table showed 2 operations were 90% of the cost. Without it I would have "optimized" the wrong things. |
| **Open-model load test** (fixed arrival rate) | A "N users in a loop" test slows itself when the server slows and hides overload. Fixed arrival rates show the real queue. |
| **Hard resource caps in the test** (CPU + RAM) | An unrestricted laptop would have said "it's fast" and told us nothing about a cheap server. |
| **Admission control** (bounded queue → `503`) | Overload became a *fast, retryable* answer instead of memory growth and a crash. |
| **Denormalize deliberately** (`Issue.workspaceId`) | One index range instead of a join + sort for tenant-wide lists. Kept correct by writing it at creation and a test that checks it never drifts. |
| **Cap what's expensive** (`totalCount`, search probe) | Counting 600,000 rows to print "600,000" was most of a search's cost. Document the cap in the schema. |
| **Write the honest limits down** | RESULTS.md says what is measured, what is estimated, and what could be wrong. A number without its caveats is a liability. |
| **Ask before destructive actions** | Resetting a database, downloading a binary: asked each time. |

---

## Part 3 — New approaches and technical knowledge

### 3.1 SQLite can do a lot more than people think
- It served 1M issues / 5.1M rows from a half-core. The limit was CPU, not the database engine.
- **WAL mode** lets readers and the writer run concurrently.
- **`EXPLAIN QUERY PLAN`** is the most useful 10 seconds in performance work. `USE TEMP B-TREE FOR ORDER BY` = a sort on every
  request = a missing index. `SCAN` = reading every row; `SEARCH ... USING INDEX` = good.
- **An index must match the `ORDER BY`**, not just the `WHERE`. `(projectId, position, id)` serves a board; `(projectId, status, position)` does not.
- **FTS5 + `trigram` tokenizer** gives case-insensitive *substring* search from an index. Rare word: 233 ms → 3 ms.
- Two FTS details that cost me hours: put the tenant in the *indexed* text (`|ws_7|`) so small tenants don't walk everyone's matches
  (41 → 1 ms), and run FTS5 `optimize` after bulk changes (a fragmented index was 40× slower).
- **Generate test data inside the database** with recursive CTEs: 5.1M rows in ~40 s versus hours through an ORM.
- `PRAGMA quick_check`, `foreign_key_check` and `ANALYZE` are worth knowing.

### 3.2 Capacity thinking
- **CPU-milliseconds per request is the number that decides capacity.** At 0.5 vCPU you have 500 CPU-ms per second;
  `max req/s ≈ 500 / cpuMs`. This predicted the measured limit (41 predicted vs 40 measured).
- Look for the **knee**: latency is flat, then explodes when CPU hits its cap. Memory staying flat while CPU is capped = CPU-bound.
- **Averages lie; look at p95/p99** and at errors under load.
- Capacity scaled almost linearly with CPU: 0.25 → 0.5 → 1 vCPU ≈ 5–8 → 40 → 60+ req/s.

### 3.3 Surviving overload
A server's job isn't only to be fast; it's to **fail well**. Bounded concurrency + bounded queue + a wait limit + `503 Retry-After`
keeps memory flat and keeps admitted requests fast. Put it *before* body parsing.

### 3.4 Real-time at scale
1,000 subscribers × 5 moves/s = 5,000 deliveries per second. The first version spent ~3 SQL queries *per delivery* and fell 11 s behind.
The fix is a general principle: **do shared work once, per-recipient work as little as possible** — load the event's related data once and
share it, and cache the "still a member?" check (with explicit invalidation on removal so the security guarantee holds).

### 3.5 Tooling worth remembering
- **k6** (JS tests, thresholds as pass/fail, WebSockets built in) over JMeter for this kind of work.
- **Windows Job Objects** give container-style CPU/memory limits without Docker.
- **graphql-inspector** in CI fails a pull request that breaks the schema (removed field, tightened nullability).
- **Prisma** raw SQL (`$queryRawUnsafe`) for the things an ORM can't model (virtual tables, triggers) — created idempotently at startup.
- **graphql-query-complexity** + a depth rule: protect against expensive queries *before* they run.

### 3.6 Security checklist that came out of it
Introspection off in production · no stack traces · internal errors masked · per-IP rate limit + per-email login lockout ·
CSRF prevention (JSON content type required) · bcrypt · JWT secret required at startup · tokens never in URLs ·
query depth and cost limits · authorization re-checked per subscription event · tenant ids validated on every related id.

---

## Part 4 — Mistakes that taught the most

1. **The test data was wrong, and the results looked fine.** An uncorrelated SQL subquery is evaluated once, so every issue in a
   project got the same title words. Search "worked" and was meaningless. *Lesson:* sanity-check your data (count the distinct
   values) before trusting any benchmark.
2. **A fix made things worse for small tenants** (6 → 274 ms). It only showed because the data had become realistic.
   *Lesson:* re-measure **every** operation after **every** change.
3. **A WAL-mode SQLite file copied without its `-wal`** came up "malformed". *Lesson:* a database is more than one file.
4. **Shell quoting silently broke code** (`return ;` where a template string had been). TypeScript accepted it; the *test* caught it.
   *Lesson:* edit code with an editor tool, not string replacement in a shell — and keep tests that exercise real output.
5. **Claiming a cause I hadn't isolated** (WAL "fixed" the timeouts). I corrected the write-up. *Lesson:* say "most likely" when you didn't test it.
6. **Estimated numbers must be labelled.** The "before" capacity was computed from measured costs, not re-run. The docs say so.
7. **Optimizing one metric hid another**: capping `totalCount` changed what a field means, so it is documented in the schema description.

---

## Part 5 — One-page cheat sheet

```
Schema        write first · ! only if it can never fail · input + payload/union per mutation · global IDs
Errors        expected -> union members · unexpected -> throw · hide existence from non-members
N+1           DataLoader, created per request, results in key order
Paging        cursor (keyset) + fetch first+1 · cursor tied to its ordering · cap the count
Auth          authenticate in context · authorize in resolvers · re-check on every subscription event
Client        normalized cache · optimistic response = free rollback · colocated fragments · codegen
Perf          measure CPU-ms/request · EXPLAIN the query · index must match ORDER BY · cap expensive counts
Search        FTS5 trigram, tenant as an indexed token, optimize after bulk changes
Overload      bounded queue + 503 Retry-After, memory stays flat
Load test     open model · hard CPU/RAM caps · find the knee · look at p95/p99 · write the caveats down
```

### Questions to be able to answer
- Why is `[Issue!]!` different from `[Issue]`? What happens if a non-null field throws?
- Why return `NOT_FOUND` instead of `FORBIDDEN` for a non-member?
- Why must DataLoader be created per request? What goes wrong with a shared one?
- Why is offset pagination unsafe when data changes? What does a cursor remember?
- What does `optimisticResponse` do on failure, and who writes the rollback?
- Why did the board need an index on `(projectId, position, id)` and not just `projectId`?
- Why check authorization per subscription *event*, not just on subscribe?
- Why does a half-core server return `503` on purpose?

### Where to look
Schema `server/src/schema.graphql` · resolvers `server/src/resolvers.ts` · loaders `server/src/loaders.ts` ·
pagination `server/src/pagination.ts` · search `server/src/search.ts` · overload `server/src/overload.ts` ·
subscriptions `server/src/subscriptions.ts` · client cache `client/src/lib/cache.ts` ·
load-test method `loadtest/README.md` · results `loadtest/RESULTS.md`.
