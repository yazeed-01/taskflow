import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { createServer } from '../src/server.js';
import { buildContext } from '../src/context.js';
import { ensureBenchData } from '../scripts/benchData.js';
import { toGlobalId } from '../src/ids.js';
import { login, run } from './helpers.js';

let ada: string;
let pid: string;
before(async () => {
  await ensureBenchData();
  pid = toGlobalId('Project', (await prisma.project.findFirstOrThrow({ where: { key: 'BNCH' } })).id);
  ada = await login('ada@taskflow.dev');
});
after(() => prisma.$disconnect());

describe('query depth limit', () => {
  it('rejects a query that recurses through Comment.issue', async () => {
    // issue -> comments -> issue -> comments -> ... is legal GraphQL and unbounded without a depth limit
    const nest = (n: number): string => (n === 0 ? 'id' : `comments { issue { ${nest(n - 1)} } }`);
    const r = await run(`{ workspace(slug:"acme"){ projects { issues(first:1){ edges { node { ${nest(4)} } } } } } }`, {}, ada);
    assert.match(r.errors[0].message, /too deep/); // Apollo reports validation failures as GRAPHQL_VALIDATION_FAILED
    assert.equal(r.data, undefined);
  });

  it('allows realistic depth, including through fragments', async () => {
    const r = await run(
      `fragment C on Comment { body author { name } }
       fragment I on Issue { id title assignee { name } comments { ...C } }
       { workspace(slug:"acme"){ projects { issues(first:2){ edges { node { ...I } } } } } }`,
      {},
      ada,
    );
    assert.equal(r.errors, undefined);
  });

  it('counts depth inside fragments (cannot be hidden by splitting the query up)', async () => {
    const r = await run(
      `fragment A on Issue { comments { issue { ...B } } }
       fragment B on Issue { comments { issue { ...C } } }
       fragment C on Issue { comments { issue { comments { issue { id } } } } }
       { workspace(slug:"acme"){ projects { issues(first:1){ edges { node { ...A } } } } } }`,
      {},
      ada,
    );
    assert.match(r.errors[0].message, /too deep/); // Apollo reports validation failures as GRAPHQL_VALIDATION_FAILED
  });
});

describe('query complexity limit', () => {
  const board = (extra: string) => `{ project(id:"${pid}") { issues(first:100){ edges { node {
    id identifier title status position priority assignee { id name } labels { id name color } ${extra} } } } } }`;

  it('allows a realistic kanban board of 100 cards', async () => {
    const r = await run(board(''), {}, ada);
    assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  });

  it('rejects the same page size when it also fans out into nested lists', async () => {
    const r = await run(board('comments { issue { comments { body author { name } } } }'), {}, ada);
    assert.equal(r.code, 'QUERY_TOO_COMPLEX');
  });

  it('cost scales with the requested page size', async () => {
    const hostile = `{ project(id:"${pid}") { issues(first:$n){ edges { node { comments { issue { comments { body author { name } } } } } } } } }`;
    const small = await run(hostile.replace('$n', '2'), {}, ada);
    assert.equal(small.errors, undefined, 'a tiny page of the same shape is fine');
    assert.equal((await run(hostile.replace('$n', '100'), {}, ada)).code, 'QUERY_TOO_COMPLEX');
  });

  it('uses variable values, not just literals', async () => {
    const q = `query($n: Int){ project(id:"${pid}") { issues(first:$n){ edges { node { comments { issue { comments { body author { name } } } } } } } } }`;
    assert.equal((await run(q, { n: 100 }, ada)).code, 'QUERY_TOO_COMPLEX');
    assert.equal((await run(q, { n: 2 }, ada)).errors, undefined);
  });
});

describe('production hardening', () => {
  const introspection = `{ __schema { types { name } } }`;

  it('introspection is on in development', async () => {
    const r = await createServer({ production: false }).executeOperation({ query: introspection }, { contextValue: await buildContext({ headers: {} } as any) });
    assert.equal((r.body as any).singleResult.errors, undefined);
  });

  it('introspection is off in production', async () => {
    const r = await createServer({ production: true }).executeOperation({ query: introspection }, { contextValue: await buildContext({ headers: {} } as any) });
    const errors = (r.body as any).singleResult.errors;
    assert.ok(errors?.length, 'expected an error');
    assert.match(errors[0].message, /introspection/i);
  });

  it('production errors carry no stack traces', async () => {
    const r = await createServer({ production: true }).executeOperation({ query: `{ workspaces { id } }` }, { contextValue: await buildContext({ headers: {} } as any) });
    const err = (r.body as any).singleResult.errors[0];
    assert.equal(err.extensions.code, 'UNAUTHENTICATED');
    assert.equal(err.extensions.stacktrace, undefined);
  });
});
