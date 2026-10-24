#### Per-operation cost (optimized-1, 25 samples each, no load)

| Operation | wall avg (ms) | wall p95 (ms) | CPU (ms) | SQL | max req/s at 0.5 vCPU |
|---|---|---|---|---|---|
| board (page 1, giant) | 29 | 31 | 35 | 10 | 14 |
| board (page 1, small) | 6 | 7 | 13 | 10 | 38 |
| issue detail | 2 | 2 | 1 | 9 | 403 |
| search common term (giant) | 21 | 31 | 23 | 5 | 22 |
| search rare term (giant) | 3 | 4 | 1 | 5 | 391 |
| search no match (giant) | 1 | 2 | 1 | 4 | 391 |
| search common term (small) | 274 | 513 | 268 | 5 | 2 |
| my issues (giant) | 2 | 3 | 2 | 4 | 202 |
| activity feed (giant) | 2 | 3 | 4 | 4 | 113 |
| notifications | 5 | 5 | 5 | 4 | 100 |
| move issue | 5 | 7 | 6 | 7 | 89 |
| create issue | 11 | 10 | 7 | 9 | 73 |
| add comment | 5 | 6 | 1 | 8 | 391 |
