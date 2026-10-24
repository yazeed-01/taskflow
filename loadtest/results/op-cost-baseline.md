#### Per-operation cost (baseline, 25 samples each, no load)

| Operation | wall avg (ms) | wall p95 (ms) | CPU (ms) | SQL | max req/s at 0.5 vCPU |
|---|---|---|---|---|---|
| board (page 1, giant) | 37 | 39 | 48 | 10 | 11 |
| board (page 1, small) | 9 | 9 | 12 | 10 | 40 |
| issue detail | 4 | 9 | 5 | 10 | 100 |
| search common term (giant) | 242 | 267 | 238 | 3 | 2 |
| search rare term (giant) | 234 | 251 | 233 | 4 | 2 |
| search no match (giant) | 273 | 322 | 269 | 3 | 2 |
| search common term (small) | 6 | 9 | 6 | 3 | 80 |
| my issues (giant) | 259 | 352 | 261 | 4 | 2 |
| activity feed (giant) | 4 | 6 | 4 | 4 | 133 |
| notifications | 4 | 5 | 6 | 4 | 89 |
| move issue | 10 | 15 | 7 | 8 | 67 |
| create issue | 8 | 10 | 7 | 9 | 67 |
| add comment | 13 | 18 | 8 | 9 | 62 |
