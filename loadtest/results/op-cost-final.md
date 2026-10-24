#### Per-operation cost (final, 40 samples each, no load)

| Operation | wall avg (ms) | wall p95 (ms) | CPU (ms) | SQL | max req/s at 0.5 vCPU |
|---|---|---|---|---|---|
| board (page 1, giant) | 29 | 32 | 34 | 10 | 15 |
| board (page 1, small) | 6 | 7 | 5 | 10 | 91 |
| issue detail | 1 | 2 | 2 | 9 | 256 |
| search common term (giant) | 15 | 24 | 15 | 5 | 34 |
| search rare term (giant) | 3 | 4 | 3 | 5 | 161 |
| search no match (giant) | 1 | 2 | 2 | 4 | 317 |
| search common term (small) | 8 | 9 | 8 | 5 | 61 |
| my issues (giant) | 2 | 2 | 2 | 4 | 253 |
| activity feed (giant) | 2 | 2 | 3 | 4 | 182 |
| notifications | 3 | 4 | 4 | 4 | 128 |
| move issue | 4 | 5 | 4 | 11 | 127 |
| create issue | 4 | 6 | 6 | 11 | 85 |
| add comment | 4 | 4 | 3 | 8 | 183 |
