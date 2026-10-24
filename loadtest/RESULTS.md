# Load-test results

Method, tools and how to reproduce: **[README.md](README.md)**. Raw output for every run is in `results/`.

**Setup in one line:** TaskFlow API (Node + SQLite) on a process capped to **0.5 vCPU / 512 MB** — the size of an
entry-level cloud plan — over **5.1 million rows** (1,000,036 issues, 1.5 M comments, 1.5 M label links, 496 k activity
rows, 600 k notifications), driven by [k6](https://k6.io) with a realistic read/write mix.

---

## 1. Summary

| | Before optimization | After optimization |
|---|---|---|
| Sustainable load, 0.5 vCPU / 512 MB | **~10 req/s** *(estimated, see §3)* | **40 req/s** at p95 510 ms, 0% errors *(measured)* |
| Same, at a tight 300 ms p95 | — | 30 req/s (p95 106 ms) |
| 1 vCPU / 1 GB | not run | **60 req/s** at p95 346 ms *(measured)* |
| 0.25 vCPU / 256 MB | not run | ~5–8 req/s |
| Under 80 req/s overload on 0.5 vCPU | **process killed (out of memory)**, 74% of requests timed out at 30 s | stays up (291 MB peak), sheds excess with an instant `503` |
| Text search in the 600,000-issue workspace | 240–270 ms of CPU each | 1–15 ms |
| Open a 100-card board (120,000-issue project) | 48 ms CPU | 34 ms CPU |
| Live board, 200 subscribers × 5 moves/s | event delivery **11 s median / 18 s p95**; 23% of events never delivered in the test window | **21 ms median / 27 ms p95**, 100% delivered |
| Live board, 1,000 subscribers | not possible | 45 ms median / 70 ms p95, 226,000 events, 279 MB |
| Login (bcrypt) | — | 68 ms median at 5/s; ceiling ≈ 8 logins/s on 0.5 vCPU |

**Is it "fast"?** For this hardware and data size, yes: a typical request (open an issue, a feed, a comment, a move) costs
**1–6 ms of CPU**, so a half-core serves hundreds of those per second. The expensive operations are the ones that touch
a lot of data — a 100-card board (34 ms) and a common-word search (15 ms) — and those now determine capacity.
A rule of thumb: if an active user causes a request every 5–10 seconds, 40 req/s is roughly **200–400 people using the app
at the same moment** on a $5–10/month container. That is an assumption, not a measurement.

---

## 2. What each fix was, and why (all found by measuring)

| # | Finding | Evidence | Fix | Effect |
|---|---|---|---|---|
| 1 | The board sorted every issue in the project on each load | `EXPLAIN QUERY PLAN`: `USE TEMP B-TREE FOR ORDER BY` over 120,000 rows | Composite indexes that match each `ORDER BY` (`projectId, position, id` and friends) | Board 48 → 34 ms CPU; the rest is serialising 100 cards |
| 2 | Workspace-wide lists and "my issues" sorted up to 600,000 rows | 261 ms CPU per request | `workspaceId` copied onto `Issue` + indexes `(workspaceId, createdAt, id)` and `(workspaceId, assigneeId, createdAt, id)` | 261 → **2 ms** |
| 3 | `totalCount` scanned the whole result set | 238 ms of a 240 ms search was the count | Count capped at 10,000 (1,000 for text searches); documented in the schema | Removed the dominant cost |
| 4 | Substring search (`LIKE '%x%'`) reads every row of the tenant | 233–269 ms for rare/absent words | **SQLite FTS5 trigram index**, kept in sync by triggers; a bounded probe decides whether to fetch exact matches or fall back to the newest-first scan | Rare word 233 → **3 ms**; no match 269 → **1 ms** |
| 5 | …but a global index made *small* tenants slower (6 → 274 ms), walking every tenant's matches | Found only after the data was made realistic | Make the workspace an **indexed token** in the FTS table so SQLite intersects two short lists | 41 → 1 ms (small tenant), unchanged for the giant one |
| 6 | After an index rebuild search got 40× slower | 3 ms → 139 ms | FTS5 `optimize` merges the fragmented segments; built into the rebuild step | Back to 3 ms |
| 7 | Overload killed the process | RSS 112 → 512 MB, then `exit -1073740791`; 65 Prisma socket timeouts | **Admission control**: ≤16 running, ≤64 queued ≤3 s, the rest get an instant `503 Retry-After`; WAL mode as a precaution (effect not isolated) | Memory bounded (291 MB peak), server survives |
| 8 | Each live event cost ~3 SQL queries per subscriber | 537 of 1,000 deliveries/s achieved; 11 s lag | Load the related data **once per event** and share it; cache the membership re-check (invalidated on removal) | 11 s → 21 ms; CPU 42% → 12% |

Existing databases are upgraded in place by `scripts/apply-scale-migration.ts` (it ran on 1M issues in ~10 s and was
verified); fresh databases get everything from `prisma db push` plus the search index created at startup.

---

## 3. Capacity by request rate (final code)

Each rate is held for 45 s; "OK" = p95 < 1 s and < 1% failures. CPU is a percentage of the one core the server may use.

### 0.5 vCPU / 512 MB — the tuning target

| Offered req/s | Completed | p50 | p95 | p99 | Failed | Server CPU | RSS peak | Verdict |
|---|---|---|---|---|---|---|---|---|
| 10 | 474 | 9 ms | 48 ms | 59 ms | 0.0% | 21% | 219 MB | OK |
| 20 | 950 | 8 ms | 41 ms | 71 ms | 0.0% | 30% | 227 MB | OK |
| 30 | 1,422 | 9 ms | 106 ms | 342 ms | 0.0% | 40% | 237 MB | OK |
| 40 | 1,889 | 76 ms | 510 ms | 918 ms | 0.0% | 50% | 271 MB | OK (at the limit) |
| 50 | 2,350 | 1.64 s | 2.31 s | 3.92 s | 15.8% | 51% | 278 MB | over budget |

The knee is where CPU reaches its cap (50% of a core ≈ the 0.5 vCPU limit). Past it, latency jumps from tens of
milliseconds to seconds because requests queue; admission control then turns the overflow into fast, retryable `503`s
instead of memory growth. **The signature of "CPU-bound, not memory- or I/O-bound": RSS stays flat while CPU sits at the cap.**

### 1 vCPU / 1 GB

| Offered | p50 | p95 | Failed | CPU | Verdict |
|---|---|---|---|---|---|
| 20 | 10 ms | 49 ms | 0% | 32% | OK |
| 40 | 14 ms | 126 ms | 0% | 59% | OK |
| 60 | 51 ms | 346 ms | 0% | 81% | OK |
| 80 | 927 ms | 1.27 s | 7.5% | 94% | over budget |
| 100 | 1.01 s | 1.33 s | 28.9% | 93% | over budget |

### 0.25 vCPU / 256 MB

| Offered | p50 | p95 | Failed | CPU | Verdict |
|---|---|---|---|---|---|
| 5 | 10 ms | 53 ms | 0% | 9% | OK |
| 10 | 16 ms | 1.61 s | 0% | 18% | over budget |
| 15 | 3.98 s | 5.53 s | 15.9% | 25% | over budget |

CPU is at its 25% cap from ~10 req/s. Capacity scales almost linearly with CPU: ~5–8 → 40 → 60+ req/s for 0.25 → 0.5 → 1 vCPU.
(The small and micro runs were measured one code revision earlier; the later changes only touch live-event and write
paths, ~15% of this mix.)

### How the "before" capacity was estimated

The pre-optimization code can't be re-run any more, so its capacity is **computed**, not measured: the measured CPU cost of
each operation (§4, "before") weighted by the traffic mix gives ≈ 48 ms per request → 500 ms of CPU per second ÷ 48 ms
≈ **10 req/s**. The same calculation on the final costs (≈ 12 ms) gives ≈ 41 req/s, and the measured knee is 40 — so the
method is trustworthy. What *was* measured directly before the fixes is the ramp that crashed the server (§5).

---

## 4. Cost per operation (one request at a time, no load)

CPU time of the whole process (includes Prisma's native engine). "Max req/s" = 500 ÷ CPU-ms, i.e. that operation alone at 0.5 vCPU.

| Operation | Before (CPU ms) | After (CPU ms) | Max req/s after |
|---|---|---|---|
| Board, giant project (100 cards) | 48 | 34 | 15 |
| Board, small project | 12 | 5 | 91 |
| Issue detail (+ comments, labels) | 5 | 2 | 256 |
| Search, common word — giant tenant | 238 | 15 | 34 |
| Search, ticket number — giant tenant | 233 | 3 | 161 |
| Search, no match — giant tenant | 269 | 2 | 317 |
| Search, common word — small tenant | 6 | 8 | 61 |
| "My issues" — giant tenant | 261 | 2 | 253 |
| Activity feed | 4 | 3 | 182 |
| Notifications inbox | 6 | 4 | 128 |
| Move a card | 7 | 4 | 127 |
| Create issue | 7 | 6 | 85 |
| Add comment | 8 | 3 | 183 |

Honest reading: only the big-tenant operations changed a lot; everything else was already cheap. Small-tenant common-word search
is 2 ms *slower* than the pure `LIKE` scan was (8 vs 6 ms) — the price of going through the index for tenants too small to need it.

---

## 5. The run that crashed the server (baseline)

Ramp 5 → 80 req/s over 3m40 on 0.5 vCPU / 512 MB, original code.

- Server CPU pinned at its cap from ~10 req/s; every request type slowed together.
- Memory grew linearly 112 → 502 MB (requests piling up in the queue), then the process was killed at ~197 s.
- k6 saw **74% failures**, median latency 30 s (its timeout), 3,110 requests never even started.
- The log shows 65 Prisma `P1008 Socket timeout` errors. Most likely these are requests starved of a database connection while the queue was 30 s deep; the default rollback-journal mode (readers and the writer block each other) may have contributed. WAL mode was switched on as a precaution — **I did not isolate its effect**, so don't credit it with a specific gain.

The same ramp after the fixes: server stayed up, peak 291 MB, 25% of requests refused quickly by admission control at the
60–80 req/s stages (which are above its capacity by design).

---

## 6. Real-time fan-out (WebSocket subscriptions)

A subscriber count × write rate test: every subscriber is on the *same* busy project, so each move must be delivered to all of them.
Latency is true end-to-end (HTTP write → DB → pub/sub → per-socket execution → network), measured by stamping the write time into the issue.

| Subscribers | Moves/s | Deliveries/s needed | Delivered | Median | p95 | p99 | CPU | RSS |
|---|---|---|---|---|---|---|---|---|
| 200 *(before fix)* | 5 | 1,000 | 537/s (77%) | **11.4 s** | **18.2 s** | 18.7 s | 42% | 266 MB |
| 200 | 5 | 1,000 | 1,000/s (100%) | **21 ms** | **27 ms** | 46 ms | 12% | 210 MB |
| 1,000 | 5 | 5,000 | ~3,800/s over the hold window (226,000 events, 100%) | 45 ms | 70 ms | 187 ms | 31% | 279 MB |

## 7. Login

`bcrypt` (cost 10) is deliberately slow: ~60 ms of CPU per login → median 68 ms / p95 87 ms at 5 logins/s using 31% of the core;
**ceiling ≈ 8 logins/s** on 0.5 vCPU. A login storm (everyone signing in at 9:00) can briefly crowd out other traffic;
the per-email lockout and the per-IP limit are the existing mitigations.

---

## 8. Mistakes made while testing (and why they matter)

Load tests are easy to get subtly wrong; these are the ones I hit.

1. **The seeded data was unrealistic.** An uncorrelated SQL subquery is evaluated *once*, so every issue in a project got the same two
   title words. "Common" search terms matched nothing in the giant tenant. I found it because a probe returned 0 rows where
   I expected thousands, fixed the seeder, rebuilt the data and re-measured. **Consequence:** the *before* search numbers were taken
   on that flawed data. They still measure what the old code paid — it counted every row regardless of matches — but with realistic
   titles the old code would have been somewhat *worse* (it would also have sorted the ~30,000 matches). The "before" is, if anything, flattering.
2. **A copied WAL-mode SQLite file corrupted my test database** (`database disk image is malformed`) because a stale `-wal` file was applied to a fresh copy. Only the copy was damaged; `PRAGMA quick_check` on the source passed.
3. **My first "fix" regressed small tenants** (6 → 274 ms). It only showed up because the data had become realistic. Always re-measure *every* operation after a change, not only the one you fixed.
4. **FTS index fragmentation** made a 3 ms query take 139 ms after a rebuild — invisible without a re-measure.

## 9. Limits of these results — read before quoting a number

- **One machine, one run per cell.** Numbers have noise (run-to-run on the knee: p95 at 40 req/s was 2.35 s in one run and 510 ms in another, both "at the limit"). Treat the knee as **±10 req/s**, and re-run before relying on a specific figure.
- **A laptop core is faster than a cloud vCPU.** Expect real hosts to land lower. Compare profiles and before/after, not absolutes.
- **The I/O story is optimistic.** The caps limit the *process*; the OS file cache is not limited, so the 1.1 GB database is served from RAM. A 512 MB container with a cold disk would pay for page-cache misses, mainly on first touches of rarely used data.
- **Client and server share the machine** (pinned to different cores) and the network is loopback, so no real latency or bandwidth.
- **Synthetic traffic.** 70/30 giant/small, a 40-word vocabulary, uniformly random issue ids (so little cache locality). Real traffic is burstier and more clustered — usually *kinder* to caches, harsher in spikes.
- **No long soak test.** Runs are minutes, not hours; slow leaks and checkpoint/WAL growth are not covered.
- **Single instance.** Pub/sub, login lockout and the membership cache are in-process. These numbers say nothing about running several instances.
- **The "before" capacity (10 req/s) is an estimate** (§3).

## 10. What would be next

1. Re-run on the real target (the same container size, cold disk) and compare with §3.
2. Boards are the largest remaining cost (34 ms): trim the card payload, or load 50 cards first and the rest lazily.
3. Add a soak run (30–60 min at 70% of the knee) watching memory and WAL size.
4. Beyond ~1 vCPU or several instances: PostgreSQL + Redis pub/sub; SQLite is the single-writer limit, not this code.
5. Put the step test in CI as a smoke check (`thresholds` already encode the budgets) with a smaller dataset.
