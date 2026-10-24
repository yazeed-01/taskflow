### Result (tiny) — server stayed up

| Metric | Value |
|---|---|
| Requests | 7052 (31.1/s average) |
| HTTP failures | 8.42% |
| GraphQL errors | 8.42% |
| Dropped iterations (load generator couldn't keep the rate) | 0 |
| Latency, all requests | median 321 ms · p95 2.31 s · p99 2.68 s |
| Server CPU (% of its one allowed core) | avg 39% · p95 59% · peak 64% |
| Server memory | RSS peak 274 MB · committed peak 248 MB |

| Operation | median | p95 | p99 | max | budget |
|---|---|---|---|---|---|
| search_none | 482 ms | 2.18 s | 2.36 s | 2.52 s | FAIL |
| create | 225 ms | 2.82 s | 3.27 s | 3.97 s | FAIL |
| feed | 258 ms | 2.10 s | 2.26 s | 2.37 s | FAIL |
| search_rare | 612 ms | 2.13 s | 2.30 s | 2.55 s | FAIL |
| board | 578 ms | 2.38 s | 2.62 s | 3.02 s | FAIL |
| board_more | 654 ms | 2.37 s | 2.49 s | 2.81 s | FAIL |
| my_issues | 188 ms | 2.14 s | 2.25 s | 2.47 s | FAIL |
| notifications | 217 ms | 2.13 s | 2.29 s | 2.49 s | FAIL |
| issue | 407 ms | 2.18 s | 2.32 s | 2.58 s | FAIL |
| search_common | 227 ms | 2.22 s | 2.49 s | 2.56 s | FAIL |
| move | 215 ms | 2.68 s | 3.25 s | 4.00 s | FAIL |
| comment | 178 ms | 2.73 s | 3.22 s | 4.12 s | FAIL |

#### Capacity by request rate

| Offered req/s | Completed | p50 | p95 | p99 | Failed | Server CPU avg | RSS peak | Verdict |
|---|---|---|---|---|---|---|---|---|
| 10 | 473 | 10 ms | 47 ms | 61 ms | 0.0% | 18% | 219 MB | OK |
| 20 | 943 | 11 ms | 49 ms | 93 ms | 0.0% | 35% | 225 MB | OK |
| 30 | 1411 | 12 ms | 101 ms | 302 ms | 0.0% | 43% | 235 MB | OK |
| 40 | 1889 | 1.29 s | 2.35 s | 2.70 s | 4.1% | 51% | 267 MB | **over budget** |
| 50 | 2335 | 1.78 s | 2.46 s | 2.87 s | 22.1% | 51% | 274 MB | **over budget** |

Budget: p95 < 1000 ms and < 1% failures. CPU is a percentage of the ONE core the server is allowed.
