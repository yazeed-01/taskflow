// Login is the one deliberately CPU-expensive request (bcrypt, cost 10). On a fraction of a core a small
// burst of logins can starve everything else, so measure it on its own.
//   k6 run -e RPS=5 -e DURATION=30 k6/login.js
import { gql, pick } from './common.js';

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    login: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 5),
      timeUnit: '1s',
      duration: `${__ENV.DURATION || 30}s`,
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  thresholds: { 'http_req_duration{op:login}': ['p(95)<1000'], gql_errors: ['rate<0.01'] },
};

const LOGIN = `mutation($i: LoginInput!) { login(input: $i) { token user { id name } } }`;

export default function () {
  const n = 1 + Math.floor(Math.random() * 2000); // the giant tenant's members: user000001..user002000
  gql('login', LOGIN, { i: { email: `user${String(n).padStart(6, '0')}@load.test`, password: 'password123' } }, '');
}
