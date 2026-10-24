import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Rate } from 'k6/metrics';

export const BASE = __ENV.BASE_URL || 'http://localhost:4200';

// Parsed once and shared read-only by every VU (a plain top-level parse would copy 600 KB per VU).
export const fx = new SharedArray('fixtures', () => [JSON.parse(open('../data/fixtures.json'))])[0];

// Share of responses that were HTTP-ok but carried a GraphQL error (or an error union member on a mutation).
export const gqlErrors = new Rate('gql_errors');

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const chance = (p) => Math.random() < p;

/** Who is acting: 70% of traffic is the giant tenant (600k issues), 30% a small one — like real skew. */
export function actor() {
  const giant = chance(0.7);
  const ws = giant ? fx.giant : pick(fx.small);
  return { ws, user: pick(ws.users), project: pick(ws.projects), giant };
}

/**
 * POST one operation. `op` becomes a tag, so k6 reports latency per operation, not just overall.
 * A mutation "fails" when its result union is an error type, not only when HTTP fails.
 */
export function gql(op, query, variables, token) {
  const res = http.post(`${BASE}/graphql`, JSON.stringify({ query, variables }), {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    tags: { op },
    timeout: '30s',
  });
  let body = null;
  let ok = res.status === 200;
  if (ok) {
    try {
      body = res.json();
      ok = !body.errors;
      if (ok && body.data) {
        for (const v of Object.values(body.data)) {
          if (v && typeof v === 'object' && /Error$/.test(v.__typename || '')) ok = false;
        }
      }
    } catch (_) {
      ok = false;
    }
  }
  gqlErrors.add(!ok, { op });
  return { res, body, ok };
}

export const CARD = `id identifier title status priority position assignee { id name } labels { id name color }`;

export const Q = {
  board: `query($id: ID!, $after: String) { project(id: $id) { id name key issues(first: 100, after: $after) {
    totalCount pageInfo { hasNextPage endCursor } edges { cursor node { ${CARD} } } } } }`,

  issueDetail: `query($id: ID!) { issue(id: $id) { ${CARD} description createdAt reporter { id name }
    comments { id body createdAt author { id name } } project { id key } } }`,

  search: `query($slug: String!, $filter: IssueFilter) { workspace(slug: $slug) { id
    issues(first: 20, filter: $filter, orderBy: NEWEST) { totalCount pageInfo { hasNextPage endCursor }
      edges { cursor node { id identifier title status priority project { id name } } } } } }`,

  feed: `query($slug: String!) { workspace(slug: $slug) { id activity(first: 20) { pageInfo { hasNextPage endCursor }
    edges { cursor node { id summary type createdAt actor { id name } issue { id } } } } } }`,

  notifications: `{ notifications(first: 20) { unreadCount pageInfo { hasNextPage endCursor }
    edges { cursor node { id read createdAt activity { id summary issue { id } } } } } }`,

  move: `mutation($i: MoveIssueInput!) { moveIssue(input: $i) { __typename ... on MoveIssuePayload { issue { id status position } } ... on UserError { message } } }`,
  create: `mutation($i: CreateIssueInput!) { createIssue(input: $i) { __typename ... on CreateIssuePayload { issue { ${CARD} } } ... on UserError { message } } }`,
  comment: `mutation($i: AddCommentInput!) { addComment(input: $i) { __typename ... on AddCommentPayload { comment { id body } } ... on UserError { message } } }`,
};

export const STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE'];

/** Parse "rate:seconds,rate:seconds" into k6 ramping-arrival-rate stages. */
export function stagesFromEnv(def) {
  return (__ENV.STAGES || def).split(',').map((s) => {
    const [rate, secs] = s.split(':').map(Number);
    return { target: rate, duration: `${secs}s` };
  });
}
