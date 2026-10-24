// Cursor pagination, filtering and DataLoader batching, against the 50-issue "bench" workspace.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { run as runOp } from './helpers.js';
import { signToken } from '../src/auth.js';
import { toGlobalId } from '../src/ids.js';
import { ensureBenchData, N } from '../scripts/benchData.js';

let adaToken: string;
let outsiderToken: string;
let pid: string;

const run = (query: string, variables: Record<string, unknown> = {}, token = adaToken) => runOp(query, variables, token);

before(async () => {
  await ensureBenchData();
  const ada = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@taskflow.dev' } });
  adaToken = signToken(ada.id);
  // linus is a member of "acme" but not of "bench", so he is the outsider here.
  const linus = await prisma.user.findUniqueOrThrow({ where: { email: 'linus@taskflow.dev' } });
  outsiderToken = signToken(linus.id);
  pid = toGlobalId('Project', (await prisma.project.findFirstOrThrow({ where: { key: 'BNCH' } })).id);
});
after(() => prisma.$disconnect());

const PAGE = `query($pid:ID!,$first:Int,$after:String,$filter:IssueFilter,$orderBy:IssueOrder){
  project(id:$pid){ issues(first:$first, after:$after, filter:$filter, orderBy:$orderBy){
    totalCount pageInfo { hasNextPage hasPreviousPage endCursor }
    edges { cursor node { id title status createdAt } } } } }`;

async function walk(vars: Record<string, unknown>, pageSize: number) {
  const ids: string[] = [];
  let after: string | null = null;
  let pages = 0;
  let total = 0;
  for (;;) {
    const r = await run(PAGE, { pid, ...vars, first: pageSize, after });
    assert.equal(r.errors, undefined, JSON.stringify(r.errors));
    const conn = r.data.project.issues;
    ids.push(...conn.edges.map((e: any) => e.node.id));
    total = conn.totalCount;
    pages++;
    if (!conn.pageInfo.hasNextPage) return { ids, pages, total };
    after = conn.pageInfo.endCursor;
    assert.ok(pages < 100, 'pagination did not terminate');
  }
}

describe('cursor pagination', () => {
  it('walks every issue exactly once, in position order', async () => {
    const { ids, pages, total } = await walk({}, 7);
    assert.equal(ids.length, N);
    assert.equal(new Set(ids).size, N, 'no duplicates');
    assert.equal(total, N);
    assert.equal(pages, Math.ceil(N / 7));
  });

  it('NEWEST order also visits each issue once (ties on createdAt broken by id)', async () => {
    const { ids } = await walk({ orderBy: 'NEWEST' }, 9);
    assert.equal(new Set(ids).size, N);
  });

  it('first page reports hasPreviousPage=false, later pages true', async () => {
    const p1 = await run(PAGE, { pid, first: 3 });
    const c1 = p1.data.project.issues;
    assert.equal(c1.pageInfo.hasPreviousPage, false);
    const p2 = await run(PAGE, { pid, first: 3, after: c1.pageInfo.endCursor });
    assert.equal(p2.data.project.issues.pageInfo.hasPreviousPage, true);
  });

  it('is stable when a row is inserted mid-pagination (offset paging would repeat or skip)', async () => {
    const p1 = await run(PAGE, { pid, first: 5 });
    const c1 = p1.data.project.issues;
    const seen = c1.edges.map((e: any) => e.node.id);
    const proj = await prisma.project.findFirstOrThrow({ where: { key: 'BNCH' } });
    const first = await prisma.issue.findFirstOrThrow({ where: { projectId: proj.id }, orderBy: { position: 'asc' } });
    const inserted = await prisma.issue.create({
      data: { projectId: proj.id, workspaceId: proj.workspaceId, number: 9000 + Math.floor(Math.random() * 900), title: 'inserted at top', position: first.position - 1, reporterId: first.reporterId },
    });
    try {
      const p2 = await run(PAGE, { pid, first: 5, after: c1.pageInfo.endCursor });
      const next = p2.data.project.issues.edges.map((e: any) => e.node.id);
      assert.ok(!next.some((id: string) => seen.includes(id)), 'no row repeated across pages');
    } finally {
      await prisma.issue.delete({ where: { id: inserted.id } });
    }
  });

  it('rejects garbage cursors, cursors from another orderBy, and oversized pages', async () => {
    assert.equal((await run(PAGE, { pid, first: 5, after: 'not-a-cursor' })).code, 'BAD_USER_INPUT');
    const p = await run(PAGE, { pid, first: 2 });
    const cursor = p.data.project.issues.pageInfo.endCursor;
    assert.equal((await run(PAGE, { pid, first: 2, after: cursor, orderBy: 'NEWEST' })).code, 'BAD_USER_INPUT');
    assert.equal((await run(PAGE, { pid, first: 101 })).code, 'BAD_USER_INPUT');
    assert.equal((await run(PAGE, { pid, first: -1 })).code, 'BAD_USER_INPUT');
  });
});

describe('filtering and search', () => {
  it('filters by status, matching the DB', async () => {
    const expected = await prisma.issue.count({ where: { project: { key: 'BNCH' }, status: 'DONE' } });
    const { total, ids } = await walk({ filter: { status: 'DONE' } }, 5);
    assert.equal(total, expected);
    assert.equal(ids.length, expected);
  });

  it('search is a case-insensitive substring match on title', async () => {
    const expected = await prisma.issue.count({ where: { project: { key: 'BNCH' }, title: { contains: 'login bug' } } });
    assert.ok(expected > 0);
    const r = await run(PAGE, { pid, first: 100, filter: { search: 'LOGIN BUG' } });
    assert.equal(r.data.project.issues.totalCount, expected);
  });

  it('filters combine (AND)', async () => {
    const r = await run(PAGE, { pid, first: 100, filter: { status: 'DONE', search: 'login bug' } });
    const nodes = r.data.project.issues.edges.map((e: any) => e.node);
    assert.ok(nodes.every((n: any) => n.status === 'DONE' && /login bug/i.test(n.title)));
  });

  it('assigneeId and unassigned together is a validation error', async () => {
    const r = await run(PAGE, { pid, filter: { assigneeId: 'x', unassigned: true } });
    assert.equal(r.code, 'BAD_USER_INPUT');
  });

  it('workspace-wide search works across projects', async () => {
    const r = await run(
      `{ workspace(slug:"bench"){ issues(first:5, filter:{search:"bench issue 1"}){ totalCount edges { node { identifier } } } } }`,
    );
    assert.equal(r.errors, undefined);
    assert.ok(r.data.workspace.issues.totalCount >= 10); // 1, 10-19
  });

  it('non-members cannot see the project at all', async () => {
    const r = await run(PAGE, { pid }, outsiderToken);
    assert.equal(r.data.project, null);
  });
});

describe('DataLoader batching', () => {
  const Q = (first: number) => `{ project(id:"${pid}") { issues(first:${first}) { edges { node {
    id identifier project { key } reporter { name email } assignee { name email }
    labels { name } comments { body author { name } } } } } } }`;

  it('SQL query count does not grow with the number of issues', async () => {
    const small = await run(Q(5));
    const large = await run(Q(50));
    assert.equal(small.errors, undefined);
    assert.equal(large.errors, undefined);
    assert.equal(large.data.project.issues.edges.length, 50);
    // Not exactly equal: DataLoader batches per event-loop tick, so user lookups may coalesce into 1 query or split into 2.
    // The point is that 10x the issues costs ~the same, not 10x more (the N+1 baseline was ~9 queries per issue).
    assert.ok(Math.abs(large.queries - small.queries) <= 2, `5 issues: ${small.queries} queries, 50 issues: ${large.queries}`);
    assert.ok(large.queries <= 15, `expected a small constant number of queries, got ${large.queries}`);
  });

  it('totalCount only costs a query when selected', async () => {
    const without = await run(`{ project(id:"${pid}"){ issues(first:5){ edges { cursor } } } }`);
    const withCount = await run(`{ project(id:"${pid}"){ issues(first:5){ totalCount edges { cursor } } } }`);
    assert.equal(withCount.queries, without.queries + 1);
  });
});
