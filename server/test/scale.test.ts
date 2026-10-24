// The scale work must not change what users see: faster, same answers.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { prisma } from '../src/db.js';
import { toGlobalId } from '../src/ids.js';
import { ensureSearchIndex, searchIssueIds, SEARCH_CAP } from '../src/search.js';
import { admissionControl } from '../src/overload.js';
import { login, run } from './helpers.js';

let ada: string;
let workspaceId: string;
let projectId: string;
const rnd = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  await ensureSearchIndex();
  ada = await login('ada@taskflow.dev');
  const ws = await prisma.workspace.findFirstOrThrow({ where: { slug: 'acme' } });
  const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: ws.id, key: 'ENG' } });
  workspaceId = ws.id;
  projectId = project.id;
});
after(() => prisma.$disconnect());

async function addIssue(title: string) {
  const issue = await prisma.issue.create({
    data: { projectId, workspaceId, number: 100_000 + Math.floor(Math.random() * 900_000), title, reporterId: (await prisma.user.findFirstOrThrow()).id },
  });
  return issue;
}

const SEARCH = `query($slug: String!, $f: IssueFilter) { workspace(slug: $slug) { issues(first: 50, filter: $f) { totalCount edges { node { title } } } } }`;
const titles = async (search: string) => {
  const r = await run(SEARCH, { slug: 'acme', f: { search } }, ada);
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  return { titles: r.data.workspace.issues.edges.map((e: any) => e.node.title) as string[], total: r.data.workspace.issues.totalCount as number };
};

describe('full-text search index', () => {
  it('finds a substring anywhere in a title, ignoring case', async () => {
    const tag = rnd();
    await addIssue(`Checkout PaymentFlow ${tag} crashes`);
    for (const q of [`paymentflow ${tag}`, `PAYMENTFLOW`, `ymentFlow ${tag} cra`]) {
      const r = await titles(q);
      assert.ok(r.titles.some((t) => t.includes(tag)), `query "${q}" should match`);
    }
  });

  it('stays in sync: a renamed issue is found under the new title, not the old', async () => {
    const tag = rnd();
    const issue = await addIssue(`before-${tag}`);
    assert.equal((await titles(`before-${tag}`)).titles.length, 1);
    await prisma.issue.update({ where: { id: issue.id }, data: { title: `after-${tag}` } });
    assert.equal((await titles(`before-${tag}`)).titles.length, 0, 'old title must no longer match');
    assert.equal((await titles(`after-${tag}`)).titles.length, 1, 'new title must match');
  });

  it('stays in sync on delete', async () => {
    const tag = rnd();
    const issue = await addIssue(`doomed-${tag}`);
    assert.equal((await titles(`doomed-${tag}`)).titles.length, 1);
    await prisma.issue.delete({ where: { id: issue.id } });
    assert.equal((await titles(`doomed-${tag}`)).titles.length, 0);
  });

  it('is tenant-isolated: a term in another workspace never matches', async () => {
    const other = await prisma.workspace.create({ data: { name: 'Other', slug: `other-${rnd()}` } });
    const proj = await prisma.project.create({ data: { workspaceId: other.id, name: 'P', key: 'OTH' } });
    const tag = rnd();
    await prisma.issue.create({
      data: { projectId: proj.id, workspaceId: other.id, number: 1, title: `secret-${tag}`, reporterId: (await prisma.user.findFirstOrThrow()).id },
    });
    assert.equal((await titles(`secret-${tag}`)).titles.length, 0, "acme's search must not see the other workspace");
    const probe = await searchIssueIds(other.id, `secret-${tag}`);
    assert.equal(probe.kind === 'ids' && probe.ids.length, 1);
  });

  it('handles quotes, FTS operators and very short terms without erroring', async () => {
    for (const q of ['say "hello"', 'a AND b', 'NEAR(x y)', '*', 'ab', 'x', "it's", '(', '"']) {
      const r = await run(SEARCH, { slug: 'acme', f: { search: q } }, ada);
      assert.equal(r.errors, undefined, `search ${JSON.stringify(q)} errored: ${JSON.stringify(r.errors)}`);
    }
  });

  it('short terms (below the trigram minimum) still work, via the LIKE fallback', async () => {
    const tag = rnd().slice(0, 2);
    await addIssue(`zz${tag}-short-term-check`);
    assert.ok((await titles(`zz${tag}`)).titles.length >= 1);
  });

  it('a term matching more than the cap reports "common" and a capped total', async () => {
    const tag = `bulk${rnd()}`;
    const proj = projectId;
    const user = await prisma.user.findFirstOrThrow();
    const base = 2_000_000 + Math.floor(Math.random() * 1_000_000);
    const n = SEARCH_CAP + 50;
    await prisma.issue.createMany({
      data: Array.from({ length: n }, (_, i) => ({ projectId: proj, workspaceId, number: base + i, title: `${tag} item ${i}`, reporterId: user.id })),
    });
    const probe = await searchIssueIds(workspaceId, tag);
    assert.equal(probe.kind, 'common');
    const r = await titles(tag);
    assert.equal(r.titles.length, 50, 'still returns a full first page');
    assert.equal(r.total, SEARCH_CAP, 'total is capped, not an expensive exact count');
    await prisma.issue.deleteMany({ where: { title: { startsWith: tag } } });
  });
});

describe('capped totalCount', () => {
  it('is exact below the cap', async () => {
    const r = await run(`{ project(id: "${toGlobalId('Project', projectId)}") { issues(first: 1) { totalCount } } }`, {}, ada);
    const expected = await prisma.issue.count({ where: { projectId } });
    assert.equal(r.data.project.issues.totalCount, Math.min(expected, 10_000));
  });
});

describe('workspaceId denormalization', () => {
  it('createIssue stores the project’s workspace on the issue', async () => {
    const r = await run(
      `mutation($i: CreateIssueInput!) { createIssue(input: $i) { __typename ... on CreateIssuePayload { issue { id } } } }`,
      { i: { projectId: toGlobalId('Project', projectId), title: `denorm-${rnd()}` } },
      ada,
    );
    assert.equal(r.data.createIssue.__typename, 'CreateIssuePayload');
    const row = await prisma.issue.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    assert.equal(row.workspaceId, workspaceId);
  });

  it('every issue in the database agrees with its project (no drift)', async () => {
    const bad = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) n FROM Issue i JOIN Project p ON p.id = i.projectId WHERE i.workspaceId <> p.workspaceId`,
    );
    assert.equal(Number(bad[0].n), 0);
  });
});

describe('admission control (overload protection)', () => {
  async function withServer(opts: Parameters<typeof admissionControl>[0], handlerMs: number, fn: (url: string, ctl: ReturnType<typeof admissionControl>) => Promise<void>) {
    const ctl = admissionControl(opts);
    const app = express();
    app.use(ctl);
    app.get('/', (_req, res) => void setTimeout(() => res.json({ ok: true }), handlerMs));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      await fn(`http://localhost:${(server.address() as AddressInfo).port}/`, ctl);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }

  it('runs N at once, queues a few, and sheds the rest with 503 + Retry-After', async () => {
    await withServer({ maxConcurrent: 2, maxQueue: 2, maxWaitMs: 2000 }, 150, async (url, ctl) => {
      const res = await Promise.all(Array.from({ length: 8 }, () => fetch(url)));
      const codes = res.map((r) => r.status).sort();
      assert.deepEqual(codes, [200, 200, 200, 200, 503, 503, 503, 503], 'only 2 running + 2 queued are admitted');
      const shed = res.find((r) => r.status === 503)!;
      assert.equal(shed.headers.get('retry-after'), '1');
      assert.equal((await shed.json()).errors[0].extensions.code, 'SERVER_BUSY');
      assert.equal(ctl.stats().rejected, 4);
    });
  });

  it('gives queued requests up after maxWaitMs instead of holding them forever', async () => {
    await withServer({ maxConcurrent: 1, maxQueue: 5, maxWaitMs: 100 }, 400, async (url) => {
      const res = await Promise.all([fetch(url), fetch(url)]);
      assert.deepEqual(res.map((r) => r.status).sort(), [200, 503]);
    });
  });

  it('frees slots when requests finish, so it recovers fully after a burst', async () => {
    await withServer({ maxConcurrent: 1, maxQueue: 0, maxWaitMs: 100 }, 30, async (url, ctl) => {
      await Promise.all(Array.from({ length: 5 }, () => fetch(url)));
      assert.equal(ctl.stats().inFlight, 0);
      assert.equal((await fetch(url)).status, 200);
    });
  });
});
