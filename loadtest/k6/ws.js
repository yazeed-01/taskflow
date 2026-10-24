// Real-time fan-out: SUBS clients each hold a graphql-ws subscription to the SAME busy project while a writer
// moves issues at WRITE_RPS. Every move must be pushed to every subscriber, so the server does
// SUBS x WRITE_RPS deliveries per second, each with its own permission re-check and field resolution.
//
// Latency trick: the writer sets the issue's `position` to Date.now(); subscribers compute now - position.
// That is true end-to-end latency (HTTP write -> DB -> pub/sub -> per-socket execution -> network).
//
//   k6 run -e SUBS=200 -e WRITE_RPS=5 -e HOLD=60 k6/ws.js
import ws from 'k6/ws';
import { Counter, Trend } from 'k6/metrics';
import { sleep } from 'k6';
import { BASE, Q, fx, gql, pick } from './common.js';

const SUBS = Number(__ENV.SUBS || 100);
const WRITE_RPS = Number(__ENV.WRITE_RPS || 5);
const HOLD = Number(__ENV.HOLD || 60); // seconds subscribers stay connected
const project = fx.giant.projects[0];

const delivery = new Trend('ws_event_latency_ms', true);
const received = new Counter('ws_events_received');
const connected = new Counter('ws_connected');
const wsErrors = new Counter('ws_errors');

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    subscribers: { executor: 'per-vu-iterations', vus: SUBS, iterations: 1, maxDuration: `${HOLD + 60}s`, exec: 'subscriber' },
    writer: {
      executor: 'constant-arrival-rate', rate: WRITE_RPS, timeUnit: '1s', duration: `${HOLD - 15}s`,
      startTime: '10s', // let the sockets connect first
      preAllocatedVUs: 20, maxVUs: 100, exec: 'writer',
    },
  },
  thresholds: {
    ws_event_latency_ms: ['p(95)<1000'],
    ws_errors: ['count==0'],
    gql_errors: ['rate<0.01'],
  },
};

export function subscriber() {
  const user = fx.giant.users[(__VU - 1) % fx.giant.users.length];
  const url = BASE.replace(/^http/, 'ws') + '/graphql';
  sleep(Math.random() * 5); // stagger the connections like real clients arriving
  const res = ws.connect(url, { headers: { 'Sec-WebSocket-Protocol': 'graphql-transport-ws' } }, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ type: 'connection_init', payload: { authorization: `Bearer ${user.token}` } })));
    socket.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'connection_ack') {
        connected.add(1);
        socket.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: { query: `subscription($p: ID!) { issueEvents(projectId: $p) { type issue { id status position assignee { id name } labels { id name color } } } }`, variables: { p: project.id } },
        }));
      } else if (m.type === 'next') {
        if (m.payload.errors) return void wsErrors.add(1);
        received.add(1);
        delivery.add(Date.now() - m.payload.data.issueEvents.issue.position);
      } else if (m.type === 'error') {
        wsErrors.add(1);
      }
    });
    socket.on('error', () => wsErrors.add(1));
    socket.setTimeout(() => socket.close(), HOLD * 1000);
  });
  if (!res || res.status !== 101) wsErrors.add(1);
}

export function writer() {
  const user = pick(fx.giant.users);
  // position = "now": see the latency trick above. Any status keeps the issue inside the same project.
  gql('ws_write', Q.move, { i: { id: pick(project.issueIds), status: 'IN_PROGRESS', position: Date.now() } }, user.token);
}
