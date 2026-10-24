// Integration tests: real operations through Apollo Server against the seeded dev DB.
// Run `npm run db:reset` first for a known state, then `npm test`.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/db.js';
import { login, mutate, run, signUp } from './helpers.js';

const letters = () => randomBytes(3).toString('hex').replace(/[0-9]/g, 'x').slice(0, 4).toUpperCase();
const rnd = () => randomBytes(4).toString('hex');

let ada: string, grace: string, linus: string, outsider: string;
let ws: { id: string; projectId: string; userIds: Record<string, string> };

before(async () => {
  [ada, grace, linus] = await Promise.all(['ada', 'grace', 'linus'].map((n) => login(`${n}@taskflow.dev`)));
  outsider = (await signUp('Olive Outsider', `outsider-${rnd()}@example.com`)).token;

  const w = await run(`{ workspace(slug:"acme"){ id projects{ id } members{ role user{ id name } } } }`, {}, ada);
  const ids: Record<string, string> = {};
  for (const m of w.data.workspace.members) ids[m.user.name.split(' ')[0].toLowerCase()] = m.user.id;
  ws = { id: w.data.workspace.id, projectId: w.data.workspace.projects[0].id, userIds: ids };
});

after(() => prisma.$disconnect());

describe('authentication', () => {
  it('anonymous: me is null, protected queries are UNAUTHENTICATED', async () => {
    assert.equal((await run(`{ me { id } }`)).data.me, null);
    assert.equal((await run(`{ workspaces { id } }`)).code, 'UNAUTHENTICATED');
  });

  it('login fails identically for wrong password and unknown email', async () => {
    const q = `mutation($i: LoginInput!){ login(input:$i){ token } }`;
    const a = await run(q, { i: { email: 'ada@taskflow.dev', password: 'nope-nope' } });
    const b = await run(q, { i: { email: `ghost-${rnd()}@taskflow.dev`, password: 'nope-nope' } });
    assert.equal(a.code, 'UNAUTHENTICATED');
    assert.equal(a.errors[0].message, b.errors[0].message);
  });

  it('a tampered token is treated as anonymous', async () => {
    const r = await run(`{ me { id } }`, {}, ada.slice(0, -3) + 'abc');
    assert.equal(r.data.me, null);
  });

  it('signUp rejects short passwords', async () => {
    const r = await run(`mutation($i: SignUpInput!){ signUp(input:$i){ token } }`, {
      i: { name: 'X', email: 'x@example.com', password: 'short' },
    });
    assert.equal(r.code, 'BAD_USER_INPUT');
  });

  it('login is rate limited after repeated failures (even with the right password afterwards)', async () => {
    const email = `brute-${rnd()}@example.com`;
    await signUp('Brute Target', email, 'correct-horse');
    const q = `mutation($i: LoginInput!){ login(input:$i){ token } }`;
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) codes.push((await run(q, { i: { email, password: 'wrong-guess' } })).code);
    assert.deepEqual(codes.slice(0, 5), Array(5).fill('UNAUTHENTICATED'));
    assert.equal(codes[5], 'RATE_LIMITED');
    assert.equal((await run(q, { i: { email, password: 'correct-horse' } })).code, 'RATE_LIMITED');
  });
});

describe('authorization', () => {
  const createProject = (input: Record<string, unknown>, token: string) =>
    mutate('createProject', 'CreateProjectInput', 'CreateProjectPayload', 'project { key }', input, token);

  it('MEMBER cannot create projects (ForbiddenError); ADMIN can', async () => {
    const input = { workspaceId: ws.id, name: 'Test', key: letters() };
    assert.equal((await createProject(input, linus)).type, 'ForbiddenError');
    assert.equal((await createProject(input, grace)).type, 'CreateProjectPayload');
  });

  it('non-members get null / NotFoundError — existence is not revealed', async () => {
    assert.equal((await run(`query($id:ID!){ project(id:$id){ name } }`, { id: ws.projectId }, outsider)).data.project, null);
    const r = await mutate('createIssue', 'CreateIssueInput', 'CreateIssuePayload', 'issue { id }', {
      projectId: ws.projectId,
      title: 'sneaky',
    }, outsider);
    assert.equal(r.type, 'NotFoundError');
    const n = await run(`query($id:ID!){ node(id:$id){ id } }`, { id: ws.projectId }, outsider);
    assert.equal(n.data.node, null);
  });

  it('User.email is field-level protected', async () => {
    const q = `query($id:ID!){ node(id:$id){ ... on User { email } } }`;
    assert.equal((await run(q, { id: ws.userIds.ada }, linus)).data.node.email, 'ada@taskflow.dev');
    assert.equal((await run(q, { id: ws.userIds.ada }, outsider)).data.node, null);
    assert.ok((await run(`{ me { email } }`, {}, outsider)).data.me.email);
  });

  it('assignee must belong to the workspace (ValidationError with the field name)', async () => {
    const me = await run(`{ me { id } }`, {}, outsider);
    const r = await mutate('createIssue', 'CreateIssueInput', 'CreateIssuePayload', 'issue { id }', {
      projectId: ws.projectId,
      title: 'x',
      assigneeId: me.data.me.id,
    }, ada);
    assert.equal(r.type, 'ValidationError');
    assert.equal(r.result.field, 'assigneeId');
  });

  it('empty title is a ValidationError, not an exception', async () => {
    const r = await mutate('createIssue', 'CreateIssueInput', 'CreateIssuePayload', 'issue { id }', {
      projectId: ws.projectId,
      title: '   ',
    }, ada);
    assert.equal(r.errors, undefined);
    assert.equal(r.type, 'ValidationError');
    assert.equal(r.result.field, 'title');
  });

  it('a malformed ID is a ValidationError on the mutation', async () => {
    const r = await mutate('moveIssue', 'MoveIssueInput', 'MoveIssuePayload', 'issue { id }', {
      id: ws.projectId, // right shape, wrong type
      status: 'DONE',
      position: 1,
    }, ada);
    assert.equal(r.type, 'ValidationError');
  });

  it('only OWNERs can grant OWNER; the last owner cannot be demoted or leave', async () => {
    const setRole = (userId: string, role: string, token: string) =>
      mutate('updateMemberRole', 'UpdateMemberRoleInput', 'UpdateMemberRolePayload', 'member { role }', { workspaceId: ws.id, userId, role }, token);
    assert.equal((await setRole(ws.userIds.linus, 'OWNER', grace)).type, 'ForbiddenError');
    assert.equal((await setRole(ws.userIds.ada, 'ADMIN', ada)).type, 'ValidationError');

    const leave = await mutate('removeMember', 'RemoveMemberInput', 'RemoveMemberPayload', 'removedUserId', {
      workspaceId: ws.id,
      userId: ws.userIds.ada,
    }, ada);
    assert.equal(leave.type, 'ValidationError');
  });

  it('removing a member unassigns their issues', async () => {
    const email = `temp-${rnd()}@example.com`;
    const tina = await signUp('Temp Tina', email);
    const added = await mutate('addMember', 'AddMemberInput', 'AddMemberPayload', 'member { role }', { workspaceId: ws.id, email }, grace);
    assert.equal(added.type, 'AddMemberPayload');
    const created = await mutate('createIssue', 'CreateIssueInput', 'CreateIssuePayload', 'issue { id }', {
      projectId: ws.projectId,
      title: 'for tina',
      assigneeId: tina.id,
    }, linus);
    const issueId = created.result.issue.id;
    const rm = await mutate('removeMember', 'RemoveMemberInput', 'RemoveMemberPayload', 'removedUserId', { workspaceId: ws.id, userId: tina.id }, grace);
    assert.equal(rm.type, 'RemoveMemberPayload');
    const after = await run(`query($id:ID!){ issue(id:$id){ assignee { id } } }`, { id: issueId }, linus);
    assert.equal(after.data.issue.assignee, null);
  });
});
