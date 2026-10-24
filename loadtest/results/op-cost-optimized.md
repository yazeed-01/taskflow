#### Per-operation cost (optimized, 25 samples each, no load)

| Operation | wall avg (ms) | wall p95 (ms) | CPU (ms) | SQL | max req/s at 0.5 vCPU |
|---|---|---|---|---|---|
| board (page 1, giant) | 29 | 32 | 36 | 10 | 14 |
| board (page 1, small) | 6 | 7 | 9 | 10 | 57 |
| issue detail | 2 | 2 | 1 | 9 | 781 |
| search common term (giant) | 145 | 268 | 145 | 4 | 3 |
| search rare term (giant) | 3 | 4 | 3 | 5 | 160 |
| search no match (giant) | 2 | 2 | 1 | 4 | 781 |
| search common term (small) | 23 | 47 | 22 | 4 | 22 |
| my issues (giant) | 3 | 5 | 4 | 4 | 115 |
| activity feed (giant) | 2 | 3 | 5 | 4 | 100 |
| notifications | 3 | 4 | 3 | 4 | 160 |
| move issue | 5 | 6 | 5 | 7 | 100 |
| create issue | 15 | 51 | 11 | 9 | 44 |
| add comment | 5 | 7 | 2 | 8 | 272 |
