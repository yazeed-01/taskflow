### Result (tiny) — server stayed up

| Metric | Value |
|---|---|
| Requests | 150 (5.0/s average) |
| HTTP failures | 0.00% |
| GraphQL errors | 0.00% |
| Dropped iterations (load generator couldn't keep the rate) | 0 |
| Latency, all requests | median 68 ms · p95 87 ms · p99 185 ms |
| Server CPU (% of its one allowed core) | avg 31% · p95 36% · peak 37% |
| Server memory | RSS peak 113 MB · committed peak 88 MB |

| Operation | median | p95 | p99 | max | budget |
|---|---|---|---|---|---|
| login | 68 ms | 87 ms | 185 ms | 441 ms | PASS |
