// Turns a k6 --summary-export JSON + the monitor CSV into a markdown table.
//   node summarize.mjs <k6.json> <monitor.csv> <profile> <ok|CRASHED>
import { readFileSync } from 'node:fs';

const [, , jsonPath, csvPath, profile = '?', state = 'ok', stepsArg = ''] = process.argv; // stepsArg: "10,20,30:45" = rates : seconds each
const k6 = JSON.parse(readFileSync(jsonPath, 'utf8'));
const m = k6.metrics;

const v = (metric, key) => metric?.values?.[key] ?? metric?.[key];
const ms = (x) => (x === undefined ? '-' : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`);

// --- per-operation latency ---
const ops = Object.keys(m)
  .map((k) => /^http_req_duration\{op:(.+)\}$/.exec(k))
  .filter(Boolean)
  .map((r) => ({ op: r[1], metric: m[r[0]] }))
  .filter((o) => o.op !== 'setup' && !(v(o.metric, 'max') === 0));

const rows = ops.map(({ op, metric }) => {
  const thr = metric.thresholds ? Object.values(metric.thresholds)[0] : undefined;
  const status = thr === undefined ? '' : thr === false || thr?.ok === false ? 'PASS' : thr?.ok === true || thr === true ? 'FAIL' : '';
  return `| ${op} | ${ms(v(metric, 'med'))} | ${ms(v(metric, 'p(95)'))} | ${ms(v(metric, 'p(99)'))} | ${ms(v(metric, 'max'))} | ${status} |`;
});

const reqs = m.http_reqs;
const failed = m.http_req_failed;
const dropped = m.dropped_iterations;
const gqlErr = m.gql_errors;
const overall = m.http_req_duration;

// --- server resource usage ---
const lines = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
const col = (i) => lines.map((r) => r[i]).filter((x) => Number.isFinite(x));
const peak = (a) => (a.length ? Math.max(...a) : 0);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0;
const cpu = col(1), rss = col(2), priv = col(3);

const out = [];
out.push(`### Result (${profile}) — server ${state === 'ok' ? 'stayed up' : '**CRASHED (out of memory)**'}`);
out.push('');
out.push(`| Metric | Value |`, `|---|---|`);
out.push(`| Requests | ${v(reqs, 'count')} (${(v(reqs, 'rate') ?? 0).toFixed(1)}/s average) |`);
out.push(`| HTTP failures | ${((v(failed, 'rate') ?? v(failed, 'value') ?? 0) * 100).toFixed(2)}% |`);
out.push(`| GraphQL errors | ${((v(gqlErr, 'rate') ?? v(gqlErr, 'value') ?? 0) * 100).toFixed(2)}% |`);
out.push(`| Dropped iterations (load generator couldn't keep the rate) | ${v(dropped, 'count') ?? 0} |`);
out.push(`| Latency, all requests | median ${ms(v(overall, 'med'))} · p95 ${ms(v(overall, 'p(95)'))} · p99 ${ms(v(overall, 'p(99)'))} |`);
out.push(`| Server CPU (% of its one allowed core) | avg ${avg(cpu).toFixed(0)}% · p95 ${p95(cpu)}% · peak ${peak(cpu)}% |`);
out.push(`| Server memory | RSS peak ${peak(rss)} MB · committed peak ${peak(priv)} MB |`);
for (const k of ['ws_event_latency_ms', 'ws_events_received', 'ws_connected', 'ws_errors']) {
  if (m[k]) out.push(`| ${k} | ${k.endsWith('latency_ms') ? `median ${ms(v(m[k], 'med'))} · p95 ${ms(v(m[k], 'p(95)'))} · p99 ${ms(v(m[k], 'p(99)'))} · max ${ms(v(m[k], 'max'))}` : (v(m[k], 'count') ?? v(m[k], 'value'))} |`);
}
if (rows.length) {
  out.push('', `| Operation | median | p95 | p99 | max | budget |`, `|---|---|---|---|---|---|`, ...rows);
}
// --- capacity steps: one row per held request rate ---
if (stepsArg) {
  const [rates, secs] = stepsArg.split(':');
  const S = Number(secs);
  const budget = 1000; // ms, p95
  out.push(
    '',
    '#### Capacity by request rate',
    '',
    '| Offered req/s | Completed | p50 | p95 | p99 | Failed | Server CPU avg | RSS peak | Verdict |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  rates.split(',').forEach((r, i) => {
    const lat = m[`http_req_duration{step:r${r}}`];
    const cnt = m[`http_reqs{step:r${r}}`];
    const fail = m[`http_req_failed{step:r${r}}`];
    const win = lines.filter((row) => row[0] >= i * S + 3 && row[0] < (i + 1) * S); // skip the first seconds of each step
    const failPct = (v(fail, 'rate') ?? v(fail, 'value') ?? 0) * 100;
    const p95v = v(lat, 'p(95)');
    const ok = p95v !== undefined && p95v < budget && failPct < 1;
    out.push(
      `| ${r} | ${v(cnt, 'count') ?? '-'} | ${ms(v(lat, 'med'))} | ${ms(p95v)} | ${ms(v(lat, 'p(99)'))} | ${failPct.toFixed(1)}% | ${avg(win.map((x) => x[1])).toFixed(0)}% | ${peak(win.map((x) => x[2]))} MB | ${ok ? 'OK' : '**over budget**'} |`,
    );
  });
  out.push('', `Budget: p95 < ${budget} ms and < 1% failures. CPU is a percentage of the ONE core the server is allowed.`);
}
console.log(out.join('\n'));
