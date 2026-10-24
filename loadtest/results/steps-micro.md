### Result (micro) — server stayed up

| Metric | Value |
|---|---|
| Requests | 3304 (16.1/s average) |
| HTTP failures | 35.17% |
| GraphQL errors | 35.17% |
| Dropped iterations (load generator couldn't keep the rate) | 0 |
| Latency, all requests | median 3.36 s · p95 5.15 s · p99 6.96 s |
| Server CPU (% of its one allowed core) | avg 21% · p95 33% · peak 41% |
| Server memory | RSS peak 189 MB · committed peak 234 MB |

| Operation | median | p95 | p99 | max | budget |
|---|---|---|---|---|---|
| search_common | 3.37 s | 4.61 s | 4.81 s | 5.20 s | FAIL |
| my_issues | 3.30 s | 4.39 s | 4.67 s | 4.68 s | FAIL |
| board | 3.38 s | 5.04 s | 5.46 s | 5.92 s | FAIL |
| notifications | 3.33 s | 4.19 s | 4.46 s | 4.62 s | FAIL |
| comment | 3.95 s | 7.11 s | 10.29 s | 12.84 s | FAIL |
| search_rare | 3.26 s | 4.43 s | 4.58 s | 4.64 s | FAIL |
| create | 3.51 s | 7.51 s | 8.83 s | 9.43 s | FAIL |
| issue | 3.35 s | 4.55 s | 4.87 s | 5.15 s | FAIL |
| search_none | 3.38 s | 4.36 s | 4.84 s | 4.89 s | FAIL |
| move | 3.34 s | 7.44 s | 10.24 s | 11.16 s | FAIL |
| feed | 3.35 s | 4.27 s | 4.61 s | 4.72 s | FAIL |
| board_more | 3.25 s | 4.76 s | 5.29 s | 5.34 s | FAIL |

#### Capacity by request rate

| Offered req/s | Completed | p50 | p95 | p99 | Failed | Server CPU avg | RSS peak | Verdict |
|---|---|---|---|---|---|---|---|---|
| 5 | 208 | 10 ms | 53 ms | 68 ms | 0.0% | 9% | 158 MB | OK |
| 10 | 421 | 16 ms | 1.61 s | 2.82 s | 0.0% | 18% | 173 MB | **over budget** |
| 15 | 628 | 3.98 s | 5.53 s | 6.76 s | 15.9% | 25% | 178 MB | **over budget** |
| 20 | 827 | 3.69 s | 5.62 s | 8.23 s | 43.8% | 25% | 187 MB | **over budget** |
| 30 | 1219 | 3.38 s | 5.06 s | 5.92 s | 57.4% | 25% | 188 MB | **over budget** |

Budget: p95 < 1000 ms and < 1% failures. CPU is a percentage of the ONE core the server is allowed.
