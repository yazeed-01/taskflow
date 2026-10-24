### Result (small) — server stayed up

| Metric | Value |
|---|---|
| Requests | 12527 (62.2/s average) |
| HTTP failures | 11.56% |
| GraphQL errors | 11.56% |
| Dropped iterations (load generator couldn't keep the rate) | 0 |
| Latency, all requests | median 219 ms · p95 1.26 s · p99 1.43 s |
| Server CPU (% of its one allowed core) | avg 71% · p95 98% · peak 101% |
| Server memory | RSS peak 288 MB · committed peak 263 MB |

| Operation | median | p95 | p99 | max | budget |
|---|---|---|---|---|---|
| notifications | 174 ms | 1.13 s | 1.21 s | 1.28 s | FAIL |
| board_more | 154 ms | 1.26 s | 1.32 s | 1.54 s | FAIL |
| issue | 168 ms | 1.17 s | 1.26 s | 1.35 s | FAIL |
| board | 309 ms | 1.30 s | 1.38 s | 1.53 s | FAIL |
| create | 327 ms | 1.50 s | 1.77 s | 3.00 s | FAIL |
| feed | 119 ms | 1.15 s | 1.23 s | 1.35 s | FAIL |
| my_issues | 179 ms | 1.13 s | 1.21 s | 1.27 s | FAIL |
| search_common | 180 ms | 1.20 s | 1.27 s | 1.48 s | FAIL |
| search_rare | 144 ms | 1.18 s | 1.26 s | 1.31 s | FAIL |
| move | 423 ms | 1.45 s | 1.64 s | 2.72 s | FAIL |
| comment | 384 ms | 1.46 s | 1.74 s | 1.87 s | FAIL |
| search_none | 128 ms | 1.16 s | 1.27 s | 1.28 s | FAIL |

#### Capacity by request rate

| Offered req/s | Completed | p50 | p95 | p99 | Failed | Server CPU avg | RSS peak | Verdict |
|---|---|---|---|---|---|---|---|---|
| 20 | 848 | 10 ms | 49 ms | 80 ms | 0.0% | 32% | 225 MB | OK |
| 40 | 1689 | 14 ms | 126 ms | 220 ms | 0.0% | 59% | 245 MB | OK |
| 60 | 2515 | 51 ms | 346 ms | 520 ms | 0.0% | 81% | 269 MB | OK |
| 80 | 3327 | 927 ms | 1.27 s | 1.50 s | 7.5% | 94% | 281 MB | **over budget** |
| 100 | 4147 | 1.01 s | 1.33 s | 1.50 s | 28.9% | 93% | 286 MB | **over budget** |

Budget: p95 < 1000 ms and < 1% failures. CPU is a percentage of the ONE core the server is allowed.
