### Result (tiny) — server stayed up

| Metric | Value |
|---|---|
| Requests | 7086 (31.1/s average) |
| HTTP failures | 5.24% |
| GraphQL errors | 5.24% |
| Dropped iterations (load generator couldn't keep the rate) | 0 |
| Latency, all requests | median 45 ms · p95 2.01 s · p99 2.57 s |
| Server CPU (% of its one allowed core) | avg 38% · p95 60% · peak 69% |
| Server memory | RSS peak 283 MB · committed peak 258 MB |

| Operation | median | p95 | p99 | max | budget |
|---|---|---|---|---|---|
| feed | 27 ms | 1.89 s | 2.07 s | 4.66 s | FAIL |
| board | 73 ms | 2.10 s | 2.46 s | 5.15 s | FAIL |
| move | 35 ms | 2.32 s | 3.52 s | 5.09 s | FAIL |
| create | 42 ms | 2.58 s | 3.94 s | 4.34 s | FAIL |
| issue | 15 ms | 1.88 s | 2.14 s | 4.94 s | FAIL |
| notifications | 24 ms | 1.81 s | 2.00 s | 2.18 s | FAIL |
| search_common | 57 ms | 1.93 s | 2.16 s | 4.65 s | FAIL |
| comment | 38 ms | 2.71 s | 4.55 s | 5.51 s | FAIL |
| board_more | 51 ms | 2.05 s | 2.57 s | 4.31 s | FAIL |
| my_issues | 25 ms | 1.85 s | 2.10 s | 4.34 s | FAIL |
| search_none | 14 ms | 1.83 s | 2.14 s | 2.17 s | FAIL |
| search_rare | 39 ms | 1.93 s | 2.37 s | 3.43 s | FAIL |

#### Capacity by request rate

| Offered req/s | Completed | p50 | p95 | p99 | Failed | Server CPU avg | RSS peak | Verdict |
|---|---|---|---|---|---|---|---|---|
| 10 | 474 | 9 ms | 48 ms | 59 ms | 0.0% | 21% | 219 MB | OK |
| 20 | 950 | 8 ms | 41 ms | 71 ms | 0.0% | 30% | 227 MB | OK |
| 30 | 1422 | 9 ms | 106 ms | 342 ms | 0.0% | 40% | 237 MB | OK |
| 40 | 1889 | 76 ms | 510 ms | 918 ms | 0.0% | 50% | 271 MB | OK |
| 50 | 2350 | 1.64 s | 2.31 s | 3.92 s | 15.8% | 51% | 278 MB | **over budget** |

Budget: p95 < 1000 ms and < 1% failures. CPU is a percentage of the ONE core the server is allowed.
