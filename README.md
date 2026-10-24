# TaskFlow — a mini Linear/Jira on GraphQL

A team project-management app: **workspaces → projects → issues → comments → users → labels**, with roles,
a drag-and-drop kanban board, live updates, an activity feed, notifications, and search with cursor pagination.

Stack: **Apollo Server 4** · **Apollo Client 3** · TypeScript · Prisma + SQLite · `graphql-ws` subscriptions ·
DataLoader · GraphQL Code Generator · React + Vite.

| Phase | Goal | Status |
|-------|------|--------|
| 1 | Schema + DB + basic queries/mutations | Done |
| 2 | Auth (JWT) + roles/permissions | Done |
| 3 | DataLoader + cursor pagination (query counts before/after) | Done |
| 4 | React client: codegen, fragments, optimistic updates, kanban | Done |
| 5 | Subscriptions (live board, comments, feed, notifications) | Done |
| 6 | Complexity limits, union errors, tests, CI, deploy | Done |

## Run it

Two terminals (Node 20.6+):

```bash
# 1. API on :4000
cd server
npm install
cp .env.example .env          # then set JWT_SECRET
npm run db:push && npm run db:seed
npm run dev
```

```bash
# 2. Web app on :5173 (proxies /graphql, including WebSockets, to :4000)
cd client
npm install
npm run dev
```

Open http://localhost:5173 and sign in with a seeded user (password `password123`, dev only):

| User | Role in "Acme Inc" |
|------|------|
| `ada@taskflow.dev` | owner |
| `grace@taskflow.dev` | admin |
| `linus@taskflow.dev` | member |

Open the app in two browsers as two users to watch moves, comments and notifications arrive live.

### Scripts

| Where | Command | What it does |
|-------|---------|--------------|
| server | `npm test` | Builds a **throwaway** SQLite DB, seeds it, runs 61 integration tests. Never touches `dev.db`. |
| server | `npm run typecheck` | `tsc --noEmit` |
| server | `npm run bench` | Counts SQL queries for a 50-issue board (see below) |
| server | `npm run db:reset` | Wipe and re-seed the dev DB |
| client | `npm run codegen` | Generate typed documents from `server/src/schema.graphql` (runs automatically before `dev`/`build`) |
| client | `npm test` | Unit tests (drag position math) |
| client | `npm run build` | Typecheck + production bundle |

### Production / Docker

```bash
export JWT_SECRET=$(openssl rand -hex 32)
docker compose up --build        # http://localhost:4000 — API + web app, one origin
```

> The Dockerfile and compose file were written but **not run** (no Docker on the dev machine). The same production
> behaviour was checked by hand with `NODE_ENV=production CLIENT_DIR=../client/dist`: the server served the app and
> deep links, rejected introspection, returned no stack traces, rejected a non-JSON content type (CSRF guard), and
> handled persisted-query misses.

## How it's built

```
taskflow/
├── server/
│   ├── src/schema.graphql     the contract — written first, from what screens need
│   ├── src/resolvers.ts       queries, mutations, field resolvers
│   ├── src/subscriptions.ts   real-time resolvers (double-checked auth)
│   ├── src/loaders.ts         per-request DataLoaders
│   ├── src/pagination.ts      keyset cursors for issues
│   ├── src/feed.ts            activity + notifications (record, fan out, publish)
│   ├── src/authz.ts           role checks; src/auth.ts JWT/bcrypt
│   ├── src/security.ts        depth + complexity limits
│   ├── src/errors.ts          expected errors -> union results
│   ├── src/app.ts             express + Apollo + graphql-ws on one port
│   └── test/                  integration tests (real operations, real WebSocket client)
├── client/
│   └── src/
│       ├── apollo.ts          links, persisted queries, cache policies
│       ├── components/        IssueCard (colocated fragment), IssueModal, NotificationBell
│       ├── pages/             Board, Search, Activity, Members, Login
│       └── lib/               cache helpers, position math
└── .github/workflows/ci.yml   server tests, client build, breaking-schema-change check
```

### Schema design (Phase 1)
- **Schema-first**: models what the UI needs, not DB tables.
- **Global IDs** (`Node` interface): `base64url("Type:dbId")`. `node(id)` can fetch anything, and a Project ID can't be used where an Issue ID is expected.
- **Input + payload types** on every mutation, so fields can be added later without breaking clients.
- **Kanban ordering**: `position` is a float; a drop between two cards takes their midpoint, so a move updates one row.
- **Issue identifiers** (`ENG-12`) come from an atomic per-project counter in a transaction.
- **Nullability**: a mutation's success payload is non-null (`issue: Issue!`), because failure is expressed as a different union member instead of a null.

### Auth and permissions (Phase 2)
- `signUp` / `login` return a 7-day HS256 JWT. The context verifies it per request; a bad token means anonymous.
- Every workspace-scoped action goes through `authorize(userId, workspaceId, minRole)`:
  non-member → `NotFoundError`/`null` (existence is not revealed); too-low role → `ForbiddenError`.
- MEMBER edits issues/comments; ADMIN also creates projects/labels and manages members; only OWNER grants OWNER; a workspace always keeps an owner.
- **Field-level**: `User.email` is `null` unless it's you or someone you share a workspace with.
- **Cross-tenant guards**: assignees and labels must belong to the issue's workspace. Removing a member unassigns their issues.

### Performance (Phase 3)
Board of a 50-issue project (project, reporter, assignee + email, labels, comments + authors):

| | SQL queries | Median time |
|---|---|---|
| Before: a query per issue per relation (Phase 2 code) | **454** | 87.8 ms |
| After: DataLoader + connection (final code) | **13** | 6.6 ms |

The "before" figure was measured on the Phase 2 code using a Prisma query-event counter, going through
`workspace → projects → issues`. The final benchmark starts at `project(id)`, which adds a permission lookup;
that is why 13 isn't the 12 recorded at the end of Phase 3. The query count grows ~9 per issue before and stays flat after
(a test asserts 5 and 50 issues cost about the same). Reproduce "after" with `npm run bench`.

- **DataLoader** batches every `.load(id)` in one event-loop tick into one `WHERE id IN (...)`. Loaders are created **per request**, so the cache cannot leak between users. They skip permission checks, so they are only used for children of an object the caller was already authorized to see.
- **Cursor (keyset) pagination**: the cursor holds the last row's sort key + id. Stable when rows are inserted between pages (a test inserts mid-walk), and the DB seeks instead of scanning an `OFFSET`. Forward-only, max 100 per page, `hasNextPage` from fetching `first + 1` rows, `totalCount` computed only if selected.
- Filters: status, priority, assignee, unassigned, label, case-insensitive title search; orderings `POSITION` and `NEWEST`.

### Client (Phase 4)
- **Typed from the schema**: GraphQL Code Generator checks every operation against `schema.graphql` and emits typed documents. A renamed field fails `npm run build`, not production.
- **Colocated fragments**: `IssueCard` declares `fragment IssueCard on Issue`. Parents spread it and pass the masked result down; only the card can read those fields.
- **Normalized cache**: `Issue:<id>` is stored once, so a mutation, a subscription event and the board all see the same object. Cache helpers in `lib/cache.ts` handle what normalization can't know (list membership) and are idempotent, since the same entity can arrive twice.
- **Optimistic updates with automatic rollback**: moves, edits and comments apply instantly; if the server or network refuses, Apollo discards the optimistic layer and a toast explains. Verified in a browser by stopping the API mid-drag: the card moved, then snapped back with an error toast.
- **Pagination in the cache**: `relayStylePagination` with `keyArgs` so each filter/order is its own list and "Load more" appends the next cursor page.
- **Persisted queries** (APQ): after the first request the client sends a SHA-256 hash instead of the query text.

### Real-time (Phase 5)
- `graphql-ws` on the same port and path as HTTP. Browsers can't set headers on a WebSocket, so the JWT travels in `connectionParams`.
- Subscriptions: `issueEvents(projectId)`, `commentAdded(issueId)`, `activityAdded(workspaceId)`, `notificationReceived`.
- **Authorization is checked twice**: at subscribe time (non-members get `NOT_FOUND`) and **again for every event**, so a member removed mid-stream stops receiving (tested).
- **Gotcha, tested**: a socket reuses one context, so DataLoader caches would serve stale data on the second event. Each event clears the loaders first.
- Activity feed (newest-first, cursor paginated) and notifications (assignment, comment, move; never to the actor; `markNotificationsRead` is scoped to the caller).

### Hardening (Phase 6)
| Concern | What's done |
|---|---|
| Expected errors | Mutations return **unions** (`CreateIssuePayload \| ValidationError \| NotFoundError \| ForbiddenError`); the client handles them as data. Unexpected errors and `UNAUTHENTICATED`/`RATE_LIMITED` stay in `errors`. |
| Query depth | Validation rule, default max 12, counts through fragments. |
| Query complexity | Cost estimate using variable values: `first × child cost`, lists assumed 10. Default max 10 000. A 100-card board costs ~4 000; a nested fan-out of the same size is rejected. |
| Introspection / stack traces | Off in production; internal errors are masked and logged. |
| Rate limiting | Per-IP limit on the endpoint; per-email lockout after 5 failed logins. |
| CSRF | Apollo's CSRF prevention (JSON content type required). |
| Secrets | Server refuses to start without `JWT_SECRET`; passwords are bcrypt-hashed. |
| Tests | 61 server integration tests (real operations, real WebSocket client) + 5 client unit tests. |
| CI | GitHub Actions: server typecheck + tests, client codegen + typecheck + tests + build, and `graphql-inspector` fails a PR that **breaks the schema** (removed/renamed field, tightened nullability…). |

## Known limitations (deliberate scope cuts)

- **Single instance only**: the pub/sub, login lockout and APQ cache are in memory. To scale out: Redis (e.g. `graphql-redis-subscriptions`) and Postgres instead of SQLite.
- **No migrations**: the schema is applied with `prisma db push`. Use `prisma migrate` before a real production deploy.
- **Persisted queries are APQ (an optimization), not a safelist.** Rejecting unknown queries needs a build-time manifest of approved operations; not done.
- **Float positions** run out of precision after ~50 drops into the exact same slot; `hasRoom()` can detect it but nothing rebalances the column yet.
- `Issue.comments` is batched but **not paginated**.
- JWTs aren't revocable before they expire (7 days). No password reset, email verification, or refresh tokens.
- Per-event membership checks cost one query per event per subscriber.
- Own moves echo back through the subscription; a rapid second drag could briefly flicker.
- Drag-and-drop was verified in a real browser via keyboard dragging (a synthetic mouse drag isn't recognised by the library); the UI is desktop-first.
- Docker files are untested (see above).

## Associate-exam map

| Exam topic | Where to look |
|---|---|
| SDL, nullability, enums, input types, descriptions | `server/src/schema.graphql` |
| Resolver signature `(parent, args, contextValue, info)`, default resolvers | `server/src/resolvers.ts` |
| `contextValue` for auth / DI | `server/src/context.ts` |
| `GraphQLError` + codes (`UNAUTHENTICATED`, `BAD_USER_INPUT`) | `resolvers.ts`, `errors.ts` |
| Mutation response pattern, input types | every `*Input` / `*Payload` in the schema |
| `ApolloClient`, `InMemoryCache`, `ApolloProvider`, `useQuery`/`useMutation` | `client/src/apollo.ts`, `pages/` |
| Cache normalization, `cache.modify`, optimistic response | `client/src/lib/cache.ts`, `pages/BoardPage.tsx` |

Beyond the Associate syllabus (kept deliberately small): DataLoader, subscriptions, query-cost limits, and union-based errors.
Federation/supergraphs (`@key`) belong to the Professional certification and are not used here.

## Load testing at scale (5.1 million rows, on a 0.5 vCPU / 512 MB server)

The API was load-tested with **k6** against a database of **1M issues, 1.5M comments and 5.1M rows in total**, on a process
hard-capped to the size of an entry-level cloud plan. Full method: [loadtest/README.md](loadtest/README.md);
full results, findings and caveats: **[loadtest/RESULTS.md](loadtest/RESULTS.md)**.

| | Before tuning | After |
|---|---|---|
| Sustainable load on 0.5 vCPU / 512 MB | ~10 req/s *(estimated)* | **40 req/s** (p95 510 ms, 0% errors) |
| On 1 vCPU / 1 GB | — | 60 req/s |
| Search in a 600,000-issue workspace | 240–270 ms CPU | 1–15 ms |
| When overloaded | process killed (out of memory) | stays up, sheds excess with a fast `503` |
| 200 live subscribers, 5 moves/s | event delay 11 s (median) | 21 ms |
| 1,000 live subscribers | — | 45 ms median, 279 MB |

What changed to get there: indexes that match each `ORDER BY`, a denormalized `workspaceId`, capped `totalCount`,
an FTS5 trigram index for text search, admission control (bounded queue + `503`), and per-event (not per-subscriber)
loading for live updates. These numbers come from one laptop, so use them to compare, not as promises — see RESULTS.md §9.

```powershell
cd loadtest
.\Test-Limits.ps1                                   # prove the CPU/memory caps work
.\Run-LoadTest.ps1 -Profile tiny -Script mixed -Env @{ STEPS = '10,20,30,40,50'; STEP_SECS = 45 } -Label my-run
```
