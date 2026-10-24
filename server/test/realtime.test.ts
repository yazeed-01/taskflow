// End-to-end: a real HTTP + WebSocket server, a real graphql-ws client.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createClient, type Client } from 'graphql-ws';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { login, signUp } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(4).toString('hex');

let close: () => Promise<void>;
let httpUrl: string;
let wsUrl: string;
const clients: Client[] = [];
let ada: string, grace: string, linus: string;
let projectId: string, workspaceId: string, userIds: Record<string, string>;

async function gql(token: string | undefined, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: any[] };
}

function wsClient(token?: string) {
  const c = createClient({
    url: wsUrl,
    webSocketImpl: WebSocket,
    connectionParams: token ? { authorization: `Bearer ${token}` } : {},
    retryAttempts: 0,
  });
  clients.push(c);
  return c;
}

/** Start a subscription; resolves once the server has registered it (a PubSub drops events nobody listens to). */
async function listen(client: Client, query: string, variables: Record<string, unknown> = {}) {
  const events: any[] = [];
  const errors: any[] = [];
  client.subscribe(
    { query, variables },
    {
      next: (v) => (v.errors ? errors.push(...v.errors) : events.push(v.data)),
      error: (e) => errors.push(e),
      complete: () => {},
    },
  );
  await sleep(250);
  return {
    events,
    errors,
    async waitFor(n: number, ms = 3000) {
      const start = Date.now();
      while (events.length < n && Date.now() - start < ms) await sleep(20);
      return events.length >= n;
    },
  };
}

const createIssue = async (token: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await gql(
    token,
    `mutation($i: CreateIssueInput!){ createIssue(input:$i){ __typename ... on CreateIssuePayload { issue { id } } ... on UserError { message } } }`,
    { i: { projectId, title, ...extra } },
  );
  assert.equal(r.data.createIssue.__typename, 'CreateIssuePayload', JSON.stringify(r));
  return r.data.createIssue.issue.id as string;
};

const move = (token: string, id: string, status: string, position = 1) =>
  gql(token, `mutation($i: MoveIssueInput!){ moveIssue(input:$i){ __typename } }`, { i: { id, status, position } });

before(async () => {
  const app = await createApp();
  await new Promise<void>((resolve) => app.httpServer.listen(0, resolve));
  const port = (app.httpServer.address() as AddressInfo).port;
  httpUrl = `http://localhost:${port}/graphql`;
  wsUrl = `ws://localhost:${port}/graphql`;
  close = async () => {
    clients.forEach((c) => void c.dispose());
    await app.close();
    await new Promise((r) => app.httpServer.close(r));
  };

  [ada, grace, linus] = await Promise.all(['ada', 'grace', 'linus'].map((n) => login(`${n}@taskflow.dev`)));
  const w = await gql(ada, `{ workspace(slug:"acme"){ id projects { id key } members { user { id name } } } }`);
  workspaceId = w.data.workspace.id;
  projectId = w.data.workspace.projects.find((p: any) => p.key === 'ENG').id;
  userIds = Object.fromEntries(w.data.workspace.members.map((m: any) => [m.user.name.split(' ')[0].toLowerCase(), m.user.id]));
});

after(async () => {
  await close();
  await prisma.$disconnect();
});

const ISSUE_EVENTS = `subscription($p: ID!){ issueEvents(projectId: $p){ type actor { name } issue { id status position assignee { name } } } }`;

describe('subscriptions: live board', () => {
  it('a teammate moving an issue is pushed to a subscribed client', async () => {
    const id = await createIssue(ada, `live ${rnd()}`);
    const sub = await listen(wsClient(ada), ISSUE_EVENTS, { p: projectId });
    await move(linus, id, 'IN_PROGRESS', 77);
    assert.ok(await sub.waitFor(1), 'no event received');
    assert.deepEqual(
      { type: sub.events[0].issueEvents.type, status: sub.events[0].issueEvents.issue.status, actor: sub.events[0].issueEvents.actor.name },
      { type: 'MOVED', status: 'IN_PROGRESS', actor: 'Linus Torvalds' },
    );
    assert.equal(sub.events[0].issueEvents.issue.position, 77);
  });

  it('creating an issue publishes CREATED', async () => {
    const sub = await listen(wsClient(ada), ISSUE_EVENTS, { p: projectId });
    const id = await createIssue(grace, `created ${rnd()}`);
    assert.ok(await sub.waitFor(1));
    assert.equal(sub.events[0].issueEvents.type, 'CREATED');
    assert.equal(sub.events[0].issueEvents.issue.id, id);
  });

  it('every event is resolved from fresh data (DataLoader caches do not go stale on a long-lived socket)', async () => {
    const id = await createIssue(ada, `fresh ${rnd()}`, { assigneeId: userIds.grace });
    const sub = await listen(wsClient(ada), ISSUE_EVENTS, { p: projectId });
    await move(ada, id, 'TODO');
    await sub.waitFor(1);
    await gql(ada, `mutation($i: UpdateIssueInput!){ updateIssue(input:$i){ __typename } }`, { i: { id, assigneeId: userIds.linus } });
    await sub.waitFor(2);
    await move(ada, id, 'DONE');
    await sub.waitFor(3);
    const names = sub.events.map((e) => e.issueEvents.issue.assignee.name);
    assert.deepEqual(names, ['Grace Hopper', 'Linus Torvalds', 'Linus Torvalds']);
  });

  it('events for other projects are not delivered', async () => {
    const other = await gql(grace, `mutation($i: CreateProjectInput!){ createProject(input:$i){ __typename ... on CreateProjectPayload { project { id } } } }`, {
      i: { workspaceId, name: 'Other', key: randomBytes(2).toString('hex').replace(/[0-9]/g, 'q').toUpperCase() },
    });
    const otherId = other.data.createProject.project.id;
    const sub = await listen(wsClient(ada), ISSUE_EVENTS, { p: otherId });
    await createIssue(ada, `elsewhere ${rnd()}`); // goes to the ENG project
    await sleep(300);
    assert.equal(sub.events.length, 0);
  });
});

describe('subscriptions: access control', () => {
  it('anonymous clients are rejected', async () => {
    const sub = await listen(wsClient(), ISSUE_EVENTS, { p: projectId });
    await sub.waitFor(1, 500);
    assert.equal(sub.errors[0]?.extensions?.code, 'UNAUTHENTICATED');
  });

  it('non-members cannot subscribe and learn nothing (NOT_FOUND)', async () => {
    const outsider = await signUp('Olive Outsider', `outsider-${rnd()}@example.com`);
    const sub = await listen(wsClient(outsider.token), ISSUE_EVENTS, { p: projectId });
    await sub.waitFor(1, 500);
    assert.equal(sub.errors[0]?.extensions?.code, 'NOT_FOUND');
    await createIssue(ada, `secret ${rnd()}`);
    await sleep(300);
    assert.equal(sub.events.length, 0);
  });

  it('a member removed mid-stream stops receiving events', async () => {
    const email = `leaver-${rnd()}@example.com`;
    const leaver = await signUp('Lee Leaver', email);
    await gql(grace, `mutation($i: AddMemberInput!){ addMember(input:$i){ __typename } }`, { i: { workspaceId, email } });
    const sub = await listen(wsClient(leaver.token), ISSUE_EVENTS, { p: projectId });
    await createIssue(ada, `before removal ${rnd()}`);
    assert.ok(await sub.waitFor(1), 'member should receive events while a member');

    await gql(grace, `mutation($i: RemoveMemberInput!){ removeMember(input:$i){ __typename } }`, { i: { workspaceId, userId: leaver.id } });
    await createIssue(ada, `after removal ${rnd()}`);
    await sleep(400);
    assert.equal(sub.events.length, 1, 'removed member must not receive further events');
  });
});

describe('activity feed and notifications', () => {
  it('assigning an issue notifies the assignee live — but never the actor', async () => {
    const id = await createIssue(ada, `assign ${rnd()}`);
    const before = await gql(linus, `{ notifications(first:1){ unreadCount } }`);
    const linusSub = await listen(wsClient(linus), `subscription{ notificationReceived { id read activity { summary actor { name } issue { id } } } }`);
    const adaSub = await listen(wsClient(ada), `subscription{ notificationReceived { id } }`);

    await gql(ada, `mutation($i: UpdateIssueInput!){ updateIssue(input:$i){ __typename } }`, { i: { id, assigneeId: userIds.linus } });
    assert.ok(await linusSub.waitFor(1), 'assignee should be notified');
    const n = linusSub.events[0].notificationReceived;
    assert.match(n.activity.summary, /Ada Lovelace assigned ENG-\d+ to Linus Torvalds/);
    assert.equal(n.read, false);
    assert.equal(n.activity.issue.id, id);

    await sleep(200);
    assert.equal(adaSub.events.length, 0, 'actors are not notified about their own actions');
    const after = await gql(linus, `{ notifications(first:1){ unreadCount } }`);
    assert.equal(after.data.notifications.unreadCount, before.data.notifications.unreadCount + 1);
  });

  it("a comment notifies the issue's assignee and reporter, and the live comment stream gets it", async () => {
    const id = await createIssue(ada, `talk ${rnd()}`, { assigneeId: userIds.linus });
    const commentSub = await listen(wsClient(grace), `subscription($i: ID!){ commentAdded(issueId:$i){ body author { name } } }`, { i: id });
    const linusUnread = async () => (await gql(linus, `{ notifications(first:1){ unreadCount } }`)).data.notifications.unreadCount;
    const adaUnread = async () => (await gql(ada, `{ notifications(first:1){ unreadCount } }`)).data.notifications.unreadCount;
    const [l0, a0] = [await linusUnread(), await adaUnread()];

    await gql(grace, `mutation($i: AddCommentInput!){ addComment(input:$i){ __typename } }`, { i: { issueId: id, body: 'Looks good' } });
    assert.ok(await commentSub.waitFor(1));
    assert.deepEqual(commentSub.events[0].commentAdded, { body: 'Looks good', author: { name: 'Grace Hopper' } });
    assert.equal(await linusUnread(), l0 + 1, 'assignee notified');
    assert.equal(await adaUnread(), a0 + 1, 'reporter notified');
  });

  it('markNotificationsRead only affects the caller, and the inbox paginates', async () => {
    const list = await gql(linus, `{ notifications(first:2){ unreadCount pageInfo { hasNextPage endCursor } edges { node { id read } } } }`);
    const first = list.data.notifications.edges[0].node;
    // ada cannot mark linus's notification as read
    await gql(ada, `mutation($i: MarkNotificationsReadInput!){ markNotificationsRead(input:$i){ unreadCount } }`, { i: { ids: [first.id] } });
    const still = await gql(linus, `{ notifications(first:50, unreadOnly:true){ edges { node { id } } } }`);
    assert.ok(still.data.notifications.edges.some((e: any) => e.node.id === first.id), "someone else's request must not mark it read");

    const marked = await gql(linus, `mutation($i: MarkNotificationsReadInput!){ markNotificationsRead(input:$i){ unreadCount } }`, { i: { ids: null } });
    assert.equal(marked.data.markNotificationsRead.unreadCount, 0);

    if (list.data.notifications.pageInfo.hasNextPage) {
      const next = await gql(linus, `query($a:String){ notifications(first:2, after:$a){ edges { node { id } } } }`, { a: list.data.notifications.pageInfo.endCursor });
      const ids = new Set(list.data.notifications.edges.map((e: any) => e.node.id));
      assert.ok(next.data.notifications.edges.every((e: any) => !ids.has(e.node.id)), 'pages do not overlap');
    }
  });

  it('the workspace activity feed is newest-first and paginates; activityAdded streams new entries', async () => {
    const sub = await listen(wsClient(linus), `subscription($w: ID!){ activityAdded(workspaceId:$w){ summary type } }`, { w: workspaceId });
    const title = `feed ${rnd()}`;
    await createIssue(grace, title);
    assert.ok(await sub.waitFor(1));
    assert.match(sub.events[0].activityAdded.summary, new RegExp(`Grace Hopper created ENG-\\d+ "${title}"`));

    const page1 = await gql(linus, `{ workspace(slug:"acme"){ activity(first:3){ pageInfo { hasNextPage endCursor } edges { node { id summary createdAt } } } } }`);
    const a = page1.data.workspace.activity;
    assert.equal(a.edges.length, 3);
    assert.match(a.edges[0].node.summary, new RegExp(title));
    const times = a.edges.map((e: any) => Date.parse(e.node.createdAt));
    assert.deepEqual(times, [...times].sort((x, y) => y - x), 'newest first');
    const page2 = await gql(linus, `query($a:String){ workspace(slug:"acme"){ activity(first:3, after:$a){ edges { node { id } } } } }`, { a: a.pageInfo.endCursor });
    const seen = new Set(a.edges.map((e: any) => e.node.id));
    assert.ok(page2.data.workspace.activity.edges.every((e: any) => !seen.has(e.node.id)));
  });

  it("outsiders can't read a workspace's activity", async () => {
    const outsider = await signUp('Nosy Nora', `nora-${rnd()}@example.com`);
    const r = await gql(outsider.token, `{ workspace(slug:"acme"){ activity(first:1){ edges { node { summary } } } } }`);
    assert.equal(r.data.workspace, null);
  });
});
