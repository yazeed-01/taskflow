// Realistic mixed workload, driven by a ramping REQUEST RATE (an "open" model).
//
// Why arrival-rate and not "N virtual users in a loop": real users don't slow down their clicking because the
// server is struggling. A closed loop of VUs self-throttles when the server slows (coordinated omission) and
// hides exactly the overload we want to see. With a fixed arrival rate, a slow server builds a queue and latency
// shows it honestly; if k6 itself can't keep up it reports `dropped_iterations`.
//
//   k6 run -e STAGES="5:30,10:30,20:30,40:30" -e BASE_URL=http://localhost:4200 k6/mixed.js
import { check } from 'k6';
import { BASE, Q, STATUSES, actor, chance, fx, gql, pick, stagesFromEnv } from './common.js';

// STEPS="10,20,30" (+ STEP_SECS=45): hold each request rate for STEP_SECS, one after another, and report each
// step separately. This is how you find the highest rate that still meets the latency budget (the 'knee').
// Without STEPS, STAGES ramps continuously (good for 'what happens when I'm overloaded?').
const STEPS = (__ENV.STEPS || '').split(',').filter(Boolean).map(Number);
const STEP_SECS = Number(__ENV.STEP_SECS || 45);
const stepScenarios = {};
STEPS.forEach((rate, i) => {
  stepScenarios['r' + rate] = {
    executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: STEP_SECS + 's',
    startTime: i * STEP_SECS + 's', preAllocatedVUs: 100, maxVUs: 600, tags: { step: 'r' + rate },
  };
});
const stepThresholds = {};
for (const rate of STEPS) {
  stepThresholds['http_req_duration{step:r' + rate + '}'] = ['p(95)<1000'];
  stepThresholds['http_req_failed{step:r' + rate + '}'] = ['rate<0.01'];
  stepThresholds['http_reqs{step:r' + rate + '}'] = ['count>=0']; // forces the sub-metric into the summary
}

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: STEPS.length ? stepScenarios : {
    mixed: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      stages: stagesFromEnv('5:20,10:30,20:30,40:30,60:30'),
      preAllocatedVUs: 150,
      maxVUs: 800,
    },
  },
  thresholds: {
    ...stepThresholds,
    gql_errors: ['rate<0.01'],
    http_req_failed: ['rate<0.01'],
    // Latency budgets per operation (p95). Reads are what users feel; search is allowed to be slower.
    'http_req_duration{op:board}': ['p(95)<800'],
    'http_req_duration{op:board_more}': ['p(95)<800'],
    'http_req_duration{op:issue}': ['p(95)<300'],
    'http_req_duration{op:search_common}': ['p(95)<1000'],
    'http_req_duration{op:search_rare}': ['p(95)<1000'],
    'http_req_duration{op:search_none}': ['p(95)<1000'],
    'http_req_duration{op:my_issues}': ['p(95)<1000'],
    'http_req_duration{op:feed}': ['p(95)<400'],
    'http_req_duration{op:notifications}': ['p(95)<400'],
    'http_req_duration{op:move}': ['p(95)<300'],
    'http_req_duration{op:create}': ['p(95)<400'],
    'http_req_duration{op:comment}': ['p(95)<300'],
  },
};

// Traffic mix (sums to 100). ~85% reads / 15% writes, typical for a work-tracking app.
const MIX = [
  ['board', 20], ['board_more', 5], ['issue', 25], ['search', 15], ['my_issues', 5],
  ['feed', 8], ['notifications', 7], ['move', 8], ['create', 3], ['comment', 4],
];
const TOTAL = MIX.reduce((n, [, w]) => n + w, 0);
function choose() {
  let r = Math.random() * TOTAL;
  for (const [name, w] of MIX) if ((r -= w) < 0) return name;
  return MIX[0][0];
}

function searchTerm() {
  const r = Math.random();
  if (r < 0.7) return ['search_common', pick(fx.terms.common)];
  if (r < 0.9) return ['search_rare', pick(fx.terms.rare)];
  return ['search_none', pick(fx.terms.none)];
}

export default function () {
  const a = actor();
  const token = a.user.token;
  switch (choose()) {
    case 'board': {
      const r = gql('board', Q.board, { id: a.project.id }, token);
      check(r.res, { 'board has cards': () => r.ok && r.body.data.project.issues.edges.length > 0 });
      break;
    }
    case 'board_more': {
      // "scroll": page 1, then the next cursor page (page 2 = cards 101-200)
      const first = gql('board', Q.board, { id: a.project.id }, token);
      const pi = first.ok && first.body.data.project.issues.pageInfo;
      if (pi && pi.hasNextPage) gql('board_more', Q.board, { id: a.project.id, after: pi.endCursor }, token);
      break;
    }
    case 'issue':
      gql('issue', Q.issueDetail, { id: pick(a.project.issueIds) }, token);
      break;
    case 'search': {
      const [op, q] = searchTerm();
      gql(op, Q.search, { slug: a.ws.slug, filter: { search: q } }, token);
      break;
    }
    case 'my_issues':
      gql('my_issues', Q.search, { slug: a.ws.slug, filter: { assigneeId: a.user.id } }, token);
      break;
    case 'feed':
      gql('feed', Q.feed, { slug: a.ws.slug }, token);
      break;
    case 'notifications':
      gql('notifications', Q.notifications, {}, token);
      break;
    case 'move':
      gql('move', Q.move, { i: { id: pick(a.project.issueIds), status: pick(STATUSES), position: Math.random() * 1e6 } }, token);
      break;
    case 'create':
      gql('create', Q.create, { i: { projectId: a.project.id, title: `load test ${Date.now()}`, status: pick(STATUSES) } }, token);
      break;
    case 'comment':
      gql('comment', Q.comment, { i: { issueId: pick(a.project.issueIds), body: 'load test comment' } }, token);
      break;
  }
}

export function setup() {
  // Fail fast with a clear message instead of 100% errors if the server isn't up or the fixtures are stale.
  const probe = gql('setup', Q.notifications, {}, fx.giant.users[0].token);
  if (!probe.ok) throw new Error(`Server at ${BASE} rejected the probe (${probe.res.status}). Is it running with the same JWT_SECRET/DB as the fixtures?`);
}
