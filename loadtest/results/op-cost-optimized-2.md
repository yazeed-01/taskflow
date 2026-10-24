#### Per-operation cost (optimized-2, 25 samples each, no load)

| Operation | wall avg (ms) | wall p95 (ms) | CPU (ms) | SQL | max req/s at 0.5 vCPU |
|---|---|---|---|---|---|
| board (page 1, giant) | 28 | 30 | 38 | 10 | 13 |
| board (page 1, small) | 6 | 7 | 13 | 10 | 38 |
| issue detail | 2 | 2 | 2 | 9 | 266 |
| search common term (giant) | 11 | 24 | 11 | 5 | 44 |
| search rare term (giant) | 2 | 3 | 3 | 5 | 160 |
| search no match (giant) | 1 | 2 | 1 | 4 | 833 |
| search common term (small) | 8 | 9 | 8 | 5 | 62 |
| my issues (giant) | 2 | 3 | 1 | 4 | 403 |
| activity feed (giant) | 2 | 2 | 3 | 4 | 198 |
| notifications | 3 | 3 | 4 | 4 | 133 |
| move issue | 4 | 6 | 3 | 6 | 160 |
| create issue | 13 | 5 | 6 | 9 | 80 |
| add comment | 4 | 6 | 5 | 8 | 100 |
