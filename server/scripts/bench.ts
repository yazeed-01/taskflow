// Measures how many SQL queries one GraphQL operation costs.
//   npm run bench -- connection   (current schema: Relay connection + DataLoader)
//   `list` mode only works on the pre-Phase-3 schema (plain array); its baseline is recorded in the README.
// Creates a "bench" workspace with 50 issues on first run (dev DB only).
import { performance } from 'node:perf_hooks';
import { createServer } from '../src/server.js';
import { buildContext } from '../src/context.js';
import { prisma, queryStats } from '../src/db.js';
import { signToken } from '../src/auth.js';
import { toGlobalId } from '../src/ids.js';

import { ensureBenchData, N } from './benchData.js';

const FIELDS = `
  id identifier title status
  project { key }
  reporter { name email }
  assignee { name email }
  labels { name }
  comments { body author { name } }`;

const QUERIES = {
  // pre-Phase-3 schema only (plain array). Kept for reference; see README for the recorded baseline.
  list: `{ workspace(slug: "bench") { projects { issues { ${FIELDS} } } } }`,
  // A board loads one project, so it starts at project(id) — which also keeps it under the complexity limit.
  connection: (pid: string) => `{ project(id: "${pid}") { issues(first: ${N}) { totalCount edges { node { ${FIELDS} } } } } }`,
} as const;

await ensureBenchData();
const mode = (process.argv[2] ?? 'connection') as keyof typeof QUERIES;
const benchProject = await prisma.project.findFirstOrThrow({ where: { key: 'BNCH' } });
const query = mode === 'connection' ? QUERIES.connection(toGlobalId('Project', benchProject.id)) : QUERIES.list;
const ada = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@taskflow.dev' } });
const server = createServer();

async function once() {
  const req = { headers: { authorization: `Bearer ${signToken(ada.id)}` } } as any;
  const contextValue = await buildContext(req); // auth lookups happen here, outside the measured window
  queryStats.count = 0;
  const t0 = performance.now();
  const res = await server.executeOperation({ query }, { contextValue });
  const ms = performance.now() - t0;
  const body = (res.body as any).singleResult;
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return { queries: queryStats.count, ms };
}

await once(); // warm up (connection pool, JIT)
const runs = [];
for (let i = 0; i < 5; i++) runs.push(await once());
const median = runs.map((r) => r.ms).sort((a, b) => a - b)[2];
console.log(`mode=${mode} issues=${N} sqlQueries=${runs[0].queries} medianMs=${median.toFixed(1)}`);
await prisma.$disconnect();
