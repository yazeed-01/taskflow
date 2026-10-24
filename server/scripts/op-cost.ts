// Measures what each operation COSTS, one request at a time, with no load and no limits:
// wall time, process CPU time (includes Prisma's in-process native engine), and SQL statements.
// CPU per request is the number that decides capacity: at 0.5 vCPU you get 500 CPU-ms per second,
// so max sustainable rate ~= 500 / cpuMs.
//
//   DATABASE_URL=file:...load.db JWT_SECRET=... npx tsx scripts/op-cost.ts [label]
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from '../src/server.js';
import { buildContextFromHeader } from '../src/context.js';
import { queryStats } from '../src/db.js';

const fx = JSON.parse(readFileSync(new URL('../../loadtest/data/fixtures.json', import.meta.url), 'utf8'));
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const CARD = `id identifier title status priority position assignee { id name } labels { id name color }`;
const server = createServer();

const Q = {
  board: `query($id: ID!, $after: String) { project(id: $id) { id name key issues(first: 100, after: $after) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { ${CARD} } } } } }`,
  issue: `query($id: ID!) { issue(id: $id) { ${CARD} description createdAt reporter { id name } comments { id body createdAt author { id name } } project { id key } } }`,
  search: `query($slug: String!, $filter: IssueFilter) { workspace(slug: $slug) { id issues(first: 20, filter: $filter, orderBy: NEWEST) { totalCount pageInfo { hasNextPage endCursor } edges { cursor node { id identifier title status priority project { id name } } } } } }`,
  feed: `query($slug: String!) { workspace(slug: $slug) { id activity(first: 20) { pageInfo { hasNextPage endCursor } edges { cursor node { id summary type createdAt actor { id name } issue { id } } } } } }`,
  notifications: `{ notifications(first: 20) { unreadCount pageInfo { hasNextPage endCursor } edges { cursor node { id read createdAt activity { id summary issue { id } } } } } }`,
  move: `mutation($i: MoveIssueInput!) { moveIssue(input: $i) { __typename } }`,
  create: `mutation($i: CreateIssueInput!) { createIssue(input: $i) { __typename } }`,
  comment: `mutation($i: AddCommentInput!) { addComment(input: $i) { __typename } }`,
};

type Case = { name: string; tenant: 'giant' | 'small'; make: (a: any) => { query: string; variables: object } };
const cases: Case[] = [
  { name: 'board (page 1, giant)', tenant: 'giant', make: (a) => ({ query: Q.board, variables: { id: a.project.id } }) },
  { name: 'board (page 1, small)', tenant: 'small', make: (a) => ({ query: Q.board, variables: { id: a.project.id } }) },
  { name: 'issue detail', tenant: 'giant', make: (a) => ({ query: Q.issue, variables: { id: pick(a.project.issueIds) } }) },
  { name: 'search common term (giant)', tenant: 'giant', make: (a) => ({ query: Q.search, variables: { slug: a.slug, filter: { search: pick(fx.terms.common) } } }) },
  { name: 'search rare term (giant)', tenant: 'giant', make: (a) => ({ query: Q.search, variables: { slug: a.slug, filter: { search: pick(fx.terms.rare) } } }) },
  { name: 'search no match (giant)', tenant: 'giant', make: (a) => ({ query: Q.search, variables: { slug: a.slug, filter: { search: pick(fx.terms.none) } } }) },
  { name: 'search common term (small)', tenant: 'small', make: (a) => ({ query: Q.search, variables: { slug: a.slug, filter: { search: pick(fx.terms.common) } } }) },
  { name: 'my issues (giant)', tenant: 'giant', make: (a) => ({ query: Q.search, variables: { slug: a.slug, filter: { assigneeId: a.user.id } } }) },
  { name: 'activity feed (giant)', tenant: 'giant', make: (a) => ({ query: Q.feed, variables: { slug: a.slug } }) },
  { name: 'notifications', tenant: 'giant', make: () => ({ query: Q.notifications, variables: {} }) },
  { name: 'move issue', tenant: 'giant', make: (a) => ({ query: Q.move, variables: { i: { id: pick(a.project.issueIds), status: 'DONE', position: Math.random() * 1e6 } } }) },
  { name: 'create issue', tenant: 'giant', make: (a) => ({ query: Q.create, variables: { i: { projectId: a.project.id, title: 'cost probe' } } }) },
  { name: 'add comment', tenant: 'giant', make: (a) => ({ query: Q.comment, variables: { i: { issueId: pick(a.project.issueIds), body: 'cost probe' } } }) },
];

function actor(tenant: 'giant' | 'small') {
  const ws = tenant === 'giant' ? fx.giant : pick<any>(fx.small);
  return { slug: ws.slug, user: pick<any>(ws.users), project: pick<any>(ws.projects) };
}

async function once(c: Case) {
  const a = actor(c.tenant);
  const { query, variables } = c.make(a);
  const ctx = await buildContextFromHeader(`Bearer ${a.user.token}`); // auth lookup excluded from the measurement
  queryStats.count = 0;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const body = (res.body as any).singleResult;
  if (body.errors) throw new Error(`${c.name}: ${JSON.stringify(body.errors[0])}`);
  return { wall, cpu: (cpu.user + cpu.system) / 1000, sql: queryStats.count };
}

const N = Number(process.env.N ?? 25);
const rows: string[] = [];
const label = process.argv[2] ?? 'run';
for (const c of cases) {
  for (let i = 0; i < 3; i++) await once(c); // warm up (JIT, page cache)
  const s: { wall: number; cpu: number; sql: number }[] = [];
  for (let i = 0; i < N; i++) s.push(await once(c));
  const avg = (k: 'wall' | 'cpu' | 'sql') => s.reduce((t, x) => t + x[k], 0) / s.length;
  const p95 = (k: 'wall' | 'cpu') => [...s].sort((a, b) => a[k] - b[k])[Math.floor(s.length * 0.95)][k];
  const cpuMs = avg('cpu');
  rows.push(`| ${c.name} | ${avg('wall').toFixed(0)} | ${p95('wall').toFixed(0)} | ${cpuMs.toFixed(0)} | ${avg('sql').toFixed(0)} | ${(500 / Math.max(cpuMs, 0.1)).toFixed(0)} |`);
  console.log(rows.at(-1));
}
const md = [`#### Per-operation cost (${label}, ${N} samples each, no load)`, '', '| Operation | wall avg (ms) | wall p95 (ms) | CPU (ms) | SQL | max req/s at 0.5 vCPU |', '|---|---|---|---|---|---|', ...rows].join('\n');
writeFileSync(new URL(`../../loadtest/results/op-cost-${label}.md`, import.meta.url), md + '\n');
process.exit(0);
