# Load testing TaskFlow on a small server

How fast is the API, on the kind of cheap host people really deploy to, with a database that has a lot of data in it?
This folder is the answer, and everything needed to reproduce it.

> **Results and findings: [RESULTS.md](RESULTS.md).** This file is the method.

## Why k6 (and not JMeter)

| | **k6** (chosen) | JMeter |
|---|---|---|
| Test definition | JavaScript, lives next to the code, reviewed in PRs | XML plan edited in a GUI |
| Load generator cost | One Go binary; thousands of VUs on little CPU | A JVM; roughly a thread per user |
| GraphQL | It's an HTTP POST: a few lines of JS | Needs hand-built samplers |
| WebSockets (subscriptions) | Built in (`k6/ws`) | Needs a plugin |
| Pass/fail | **Thresholds in the script** (`p(95)<300ms`, `errors<1%`) → CI-ready exit code | Assertions + separate reporting |
| Load models | Open (fixed arrival rate) and closed (fixed users) | Mostly closed (threads) |
| Where JMeter is better | — | GUI recording, huge protocol zoo (JDBC, LDAP, JMS…), mature HTML reports |

The load generator must not become the bottleneck, because this test runs it on the same machine as the "server".
That alone decides it: k6 is far lighter. (I also pin it to different CPU cores than the server.)

## What is simulated

### The data (`server/scripts/seed-huge.ts`) — **5.1 million rows**

| Table | Rows |
|---|---|
| Issue | **1,000,036** |
| Comment | 1,499,474 |
| Issue↔Label links | 1,500,054 |
| Activity (feed) | 496,000 |
| Notification | 600,000 |
| User / Membership / Project | 20,000 / 4,450 / 103 |

Skewed like real multi-tenant data: **one giant workspace** (600,000 issues, 2,000 members, projects of 120,000 issues
each) and **49 small ones** (~8,000 issues, 50 members). Titles are built from a 40-word vocabulary so text search
has realistic selectivity: a common word matches ~5% of issues (≈30,000 in the giant tenant), a ticket number
matches 5–55, a nonsense word matches 0. The database is ~1.1 GB.

Rows are generated inside SQLite with recursive CTEs (the full 5.1M rows take ~40 s), then checked with
`PRAGMA foreign_key_check`.

### The server

The API runs as a **separate process with hard OS limits** (see below), started exactly as in production:
`NODE_ENV=production`, `node --import tsx src/index.ts`, a heap cap, the same environment variables.

| Profile | CPU | Memory | Like… |
|---|---|---|---|
| `micro` | 0.25 vCPU | 256 MB | free-tier container |
| **`tiny`** | **0.5 vCPU** | **512 MB** | entry paid plan — *the profile we tune for* |
| `small` | 1 vCPU | 1 GB | next step up |
| `none` | unlimited | — | reference: what this machine can really do |

**How the limits are enforced** (`Limit-Process.ps1`): Docker isn't available here, so it uses a Windows **Job Object**,
the same kernel mechanism container runtimes use on Windows:
a *hard CPU cap* (the process is paused once its budget for the interval is spent), a *hard memory cap* (allocation
fails past it → the process dies, like an OOM kill), and *pinning to one core*. `Test-Limits.ps1` proves it before
any result is trusted: asked for 50% of a core, a busy-loop got **53%**; a 256 MB cap stopped an allocation loop at ~160 MB of payload.

Caveats, stated plainly: the cap limits the *process*, not the OS file cache, so the 1.1 GB database is served from
RAM more happily than it would be in a real 512 MB container with a cold disk. Results are therefore *optimistic on
I/O* and accurate on CPU and memory. Your laptop's CPU is also faster per core than a cloud vCPU, so absolute
numbers on a real host will be somewhat lower; compare *profiles and before/after*, not absolutes.

### The traffic (`k6/mixed.js`)

~85% reads / 15% writes, 70% from the giant tenant and 30% from small ones:

| Share | Operation |
|---|---|
| 20% | Open a board: first 100 cards with assignee + labels (what the web app does) |
| 5% | Scroll the board: next cursor page |
| 25% | Open one issue: detail, comments + authors |
| 15% | Text search (70% common word, 20% ticket number, 10% no match) |
| 5% | "My issues" (filter by assignee, workspace-wide) |
| 8% / 7% | Activity feed / notifications inbox |
| 8% / 3% / 4% | Move a card / create an issue / comment |

**Open workload model.** Requests arrive at a *fixed rate* that ramps up (5 → 10 → 20 → 40 → 60 → 80 req/s, 40 s each),
regardless of how the server is doing. A closed loop of "N users who wait for each reply" slows itself down when the
server slows, which hides overload (coordinated omission). Real users don't wait politely; an arrival rate shows the
queue building and the latency it causes. If k6 itself can't keep up it reports `dropped_iterations`.

Each virtual user has a pre-signed JWT so the hot path is the GraphQL work, not bcrypt. Login is tested separately
(`k6/login.js`) because bcrypt is deliberately CPU-expensive.

## Run it

```powershell
# one-time setup
cd server
npm install
$env:DATABASE_URL = "file:$env:LOCALAPPDATA/taskflow-loadtest/load.base.db?connection_limit=1"
npx prisma db push --skip-generate
npm run loadtest:seed                                   # ~40 s, ~1.1 GB (kept outside OneDrive)
npx tsx --env-file=.env.load scripts/gen-fixtures.ts    # users' tokens + ids for k6
# k6 binary: https://github.com/grafana/k6/releases  → loadtest\tools\k6\...\k6.exe

# prove the limiter works
cd ..\loadtest
.\Test-Limits.ps1

# what does each operation cost, one at a time?
cd ..\server; npx tsx --env-file=.env.load scripts\op-cost.ts my-label

# the capacity ramp (restores the pristine DB first, starts the capped server, samples CPU/RSS every second)
cd ..\loadtest
.\Run-LoadTest.ps1 -Profile tiny  -Script mixed -Stages "5:20,10:40,20:40,40:40,60:40,80:40" -Label my-run
.\Run-LoadTest.ps1 -Profile small -Script mixed -Stages "20:30,60:30,100:30"                  -Label small
.\Run-LoadTest.ps1 -Profile tiny  -Script ws    -Env @{ SUBS = 200; WRITE_RPS = 5; HOLD = 60 } -Label fanout
.\Run-LoadTest.ps1 -Profile tiny  -Script login -Env @{ RPS = 5; DURATION = 30 }              -Label login
```

Output lands in `results/<label>.*`: `.md` (summary table), `.k6.json` / `.k6.txt` (k6), `.monitor.csv`
(server CPU %, RSS and committed MB per second), `.server.log`.

## Tools in this folder

| File | Purpose |
|---|---|
| `Limit-Process.ps1` | Start a process under hard CPU/memory caps (Job Object) |
| `Test-Limits.ps1` | Verify the caps actually work |
| `Run-LoadTest.ps1` | Orchestrate one run: restore DB → start capped server → k6 → sample resources → report |
| `k6/mixed.js` | Realistic mixed workload, ramping request rate, per-operation thresholds |
| `k6/ws.js` | Subscription fan-out: N sockets on one project while a writer moves cards; measures end-to-end delivery latency |
| `k6/login.js` | Cost of login (bcrypt) under a CPU cap |
| `summarize.mjs` | k6 JSON + monitor CSV → markdown |
| `../server/scripts/op-cost.ts` | CPU-ms, wall-ms and SQL count per operation, no load |
| `../server/scripts/explain.ts` | SQLite query plans for the hot queries |

## Gotchas learned the hard way

- **Never copy a WAL-mode SQLite file without its `-wal` and `-shm`** (or delete stale ones when restoring): a stale
  WAL applied to a different main file gives `database disk image is malformed`. `Run-LoadTest.ps1` handles this.
- **An uncorrelated subquery is evaluated once.** The first seeder gave every issue in a project the *same title words*
  because `(SELECT w FROM words WHERE i = random() % 40)` doesn't reference the row. Results looked plausible and were wrong.
- **Fixtures pin the JWT secret.** The server under test must use the same `JWT_SECRET` as `gen-fixtures.ts` (`.env.load`).
- The per-IP rate limit and login lockout are raised for tests (every virtual user shares `127.0.0.1`); keep them on in production.
