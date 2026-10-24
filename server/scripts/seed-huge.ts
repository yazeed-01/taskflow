// Builds a production-sized dataset for load testing (about 5 million rows).
//
//   DATABASE_URL="file:./load.db?connection_limit=1" npx tsx scripts/seed-huge.ts
//   SCALE=0.01 ... for a quick smoke run (1% of the data)
//
// Rows are generated *inside SQLite* with recursive CTEs: pushing a million rows through an ORM
// takes ages, generating them where they live takes seconds. `connection_limit=1` matters: PRAGMAs
// and the helper table are per-connection.
//
// Shape (SCALE=1) — deliberately skewed, like real multi-tenant data:
//   1 giant workspace "megacorp": 2,000 members, 5 projects x 120,000 issues = 600,000 issues
//   49 small workspaces "team-NN": 50 members, 2 projects x ~4,080 issues   = ~400,000 issues
//   ~1.5 comments and ~1.5 labels per issue, 300k + ~200k activity rows, 600k notifications.
import { performance } from 'node:perf_hooks';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';
import { ensureSearchIndex } from '../src/search.js';

const SCALE = Number(process.env.SCALE ?? 1);
const scaled = (n: number) => Math.max(1, Math.round(n * SCALE));

const USERS = scaled(20_000);
const GIANT = { members: Math.min(scaled(2_000), USERS), projects: 5, issuesPerProject: scaled(120_000), activity: scaled(300_000) };
const SMALL = { count: 49, members: 50, projects: 2, issuesPerProject: scaled(4_082), activity: scaled(4_000) };
const NOTIF_USERS = Math.min(scaled(2_000), GIANT.members);
const NOTIFS_PER_USER = 300;
const LABELS = ['bug', 'feature', 'chore', 'docs', 'perf', 'ux', 'infra', 'security'];
const WORDS = [
  'login', 'checkout', 'search', 'upload', 'dashboard', 'billing', 'invoice', 'export', 'import', 'email',
  'webhook', 'cache', 'timeout', 'crash', 'layout', 'mobile', 'dark mode', 'permissions', 'audit', 'report',
  'sync', 'offline', 'push', 'avatar', 'profile', 'settings', 'onboarding', 'pricing', 'API', 'rate limit',
  'migration', 'latency', 'memory leak', 'pagination', 'filter', 'sorting', 'tooltip', 'modal', 'form', 'table',
];

const NOW = Date.now();
const DAY = 86_400_000;
const sql = (q: string, ...p: unknown[]) => prisma.$executeRawUnsafe(q, ...p);
const timed = async (label: string, fn: () => Promise<unknown>) => {
  const t = performance.now();
  await fn();
  console.log(`  ${label.padEnd(34)} ${((performance.now() - t) / 1000).toFixed(1)}s`);
};
const cte = (n: number) => `WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < ${n})`;

interface WorkspacePlan { idx: number; slug: string; name: string; base: number; members: number; admins: number; projects: number; issuesPerProject: number; activity: number }
const plans: WorkspacePlan[] = [
  { idx: 0, slug: 'megacorp', name: 'MegaCorp', base: 1, members: GIANT.members, admins: 20, projects: GIANT.projects, issuesPerProject: GIANT.issuesPerProject, activity: GIANT.activity },
  ...Array.from({ length: SMALL.count }, (_, i) => ({
    idx: i + 1,
    slug: `team-${String(i + 1).padStart(2, '0')}`,
    name: `Team ${i + 1}`,
    base: GIANT.members + i * 300 + 1, // 50 members each, drawn from users after the giant workspace's block
    members: Math.min(SMALL.members, Math.max(1, USERS - (GIANT.members + i * 300))),
    admins: 4,
    projects: SMALL.projects,
    issuesPerProject: SMALL.issuesPerProject,
    activity: SMALL.activity,
  })),
].filter((p) => p.base <= USERS);

const userId = (expr: string) => `printf('usr_%06d', ${expr})`;

async function main() {
  console.log(`Seeding SCALE=${SCALE}: ${plans.length} workspaces, ${USERS} users`);
  const t0 = performance.now();
  await prisma.$queryRawUnsafe('PRAGMA synchronous = OFF');
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = MEMORY');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = OFF'); // verified with foreign_key_check at the end
  await prisma.$queryRawUnsafe('PRAGMA cache_size = -400000'); // 400 MB page cache, for this connection only

  await sql('DROP TABLE IF EXISTS _words');
  await sql('CREATE TABLE _words (i INTEGER PRIMARY KEY, w TEXT NOT NULL)');
  for (const [i, w] of WORDS.entries()) await sql('INSERT INTO _words VALUES (?, ?)', i, w);
  const W = WORDS.length;
  // The subquery MUST reference the current row (`corr`). An uncorrelated subquery is evaluated once per statement,
  // which gave every issue in a project the same two words and made every text search selectivity unrealistic.
  const wordOf = (corr: string) => `(SELECT w FROM _words WHERE i = (abs(random()) + ${corr}) % ${W})`;

  console.log('users, workspaces, members');
  const hash = await bcrypt.hash('password123', 10); // one real bcrypt hash shared by everyone: login still costs real CPU
  await timed(`${USERS} users`, () =>
    sql(
      `${cte(USERS)} INSERT INTO User (id, email, name, passwordHash, createdAt)
       SELECT ${userId('n')}, printf('user%06d@load.test', n), 'User ' || n, ?, ${NOW} - (n % 365) * ${DAY} FROM s`,
      hash,
    ),
  );
  for (const p of plans) {
    await sql('INSERT INTO Workspace (id, name, slug, createdAt) VALUES (?, ?, ?, ?)', `ws_${p.idx}`, p.name, p.slug, NOW - 400 * DAY);
    await sql(
      `${cte(p.members)} INSERT INTO Membership (workspaceId, userId, role, joinedAt)
       SELECT 'ws_${p.idx}', ${userId(`${p.base} + n - 1`)},
              CASE WHEN n = 1 THEN 'OWNER' WHEN n <= ${p.admins + 1} THEN 'ADMIN' ELSE 'MEMBER' END, ${NOW} - 300 * ${DAY} FROM s`,
    );
    for (const [i, name] of LABELS.entries()) {
      await sql('INSERT INTO Label (id, workspaceId, name, color) VALUES (?, ?, ?, ?)', `lbl_${p.idx}_${i}`, `ws_${p.idx}`, name, `#${((i + 1) * 2654435).toString(16).slice(0, 6).padStart(6, '0')}`);
    }
  }

  console.log('projects, issues, comments, labels');
  let issues = 0;
  for (const p of plans) {
    for (let j = 0; j < p.projects; j++) {
      const pid = `prj_${p.idx}_${j}`;
      const N = p.issuesPerProject;
      await sql(
        'INSERT INTO Project (id, workspaceId, name, key, description, issueCounter, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        pid, `ws_${p.idx}`, `${p.name} Project ${j + 1}`, `P${String.fromCharCode(65 + j)}X`, 'Generated load-test project', N, NOW - 380 * DAY,
      );
      const member = userId(`${p.base} + abs(random()) % ${p.members}`);
      const label = p.idx === 0 && j === 0 ? 'giant project' : `${pid}`;
      await timed(`issues ${label} (${N})`, () =>
        sql(
          `${cte(N)}, c(n, t) AS (SELECT n, ${NOW} - (${N} - n) * 30000 - abs(random()) % 30000 FROM s)
           INSERT INTO Issue (id, projectId, workspaceId, number, title, description, status, priority, position, reporterId, assigneeId, createdAt, updatedAt)
           SELECT '${pid}_' || n, '${pid}', 'ws_${p.idx}', n,
                  'Fix ' || ${wordOf('n')} || ' ' || ${wordOf('n * 7')} || ' #' || n,
                  CASE WHEN abs(random()) % 10 < 3 THEN 'Steps to reproduce: open the ' || ${wordOf('n * 3')} || ' page, then retry.' END,
                  CASE WHEN abs(random()) % 100 < 30 THEN 'BACKLOG' WHEN abs(random()) % 100 < 36 THEN 'TODO' WHEN abs(random()) % 100 < 22 THEN 'IN_PROGRESS' ELSE 'DONE' END,
                  CASE abs(random()) % 5 WHEN 0 THEN 'NONE' WHEN 1 THEN 'LOW' WHEN 2 THEN 'MEDIUM' WHEN 3 THEN 'HIGH' ELSE 'URGENT' END,
                  n * 1024.0,
                  ${member},
                  CASE WHEN abs(random()) % 100 < 80 THEN ${member} END,
                  t, t
           FROM c`,
        ),
      );
      issues += N;
      await sql(
        `INSERT INTO Comment (id, issueId, authorId, body, createdAt)
         SELECT 'cmt_' || i.id || '_' || k.k, i.id, i.reporterId, 'Comment ' || k.k || ': looks like a ' || ${wordOf('i.number + k.k')} || ' regression.', i.createdAt + k.k * 60000
         FROM Issue i JOIN (SELECT 1 AS k UNION ALL SELECT 2 UNION ALL SELECT 3) k
         WHERE i.projectId = ? AND abs(random()) % 100 < CASE k.k WHEN 1 THEN 80 WHEN 2 THEN 45 ELSE 25 END`,
        pid,
      );
      await sql(
        `INSERT INTO _IssueToLabel (A, B)
         SELECT id, 'lbl_${p.idx}_' || (number % 8) FROM Issue WHERE projectId = ?
         UNION ALL
         SELECT id, 'lbl_${p.idx}_' || ((number + 3) % 8) FROM Issue WHERE projectId = ? AND number % 2 = 0`,
        pid,
        pid,
      );
    }
  }

  console.log('activity feed');
  let activities = 0;
  for (const p of plans) {
    const issueRef = `'prj_${p.idx}_' || (abs(random()) % ${p.projects}) || '_' || (1 + abs(random()) % ${p.issuesPerProject})`;
    const run = p.idx === 0 ? timed : async (_: string, fn: () => Promise<unknown>) => void (await fn());
    await run(`activity ws_${p.idx} (${p.activity})`, () =>
      sql(
        `${cte(p.activity)} INSERT INTO Activity (id, workspaceId, actorId, type, issueId, summary, createdAt)
         SELECT 'act_${p.idx}_' || n, 'ws_${p.idx}', ${userId(`${p.base} + abs(random()) % ${p.members}`)},
                CASE abs(random()) % 4 WHEN 0 THEN 'ISSUE_CREATED' WHEN 1 THEN 'ISSUE_UPDATED' WHEN 2 THEN 'ISSUE_MOVED' ELSE 'COMMENT_ADDED' END,
                ${issueRef},
                'Someone changed ' || ${wordOf('n')} || ' work item #' || n,
                ${NOW} - (${p.activity} - n) * 20000
         FROM s`,
      ),
    );
    activities += p.activity;
  }

  console.log('notifications');
  const giantActs = plans[0].activity;
  await timed(`${NOTIF_USERS * NOTIFS_PER_USER} notifications`, () =>
    sql(
      `${cte(NOTIFS_PER_USER)}, u(n) AS (SELECT n FROM (WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n < ${NOTIF_USERS}) SELECT n FROM x))
       INSERT INTO Notification (id, userId, activityId, readAt, createdAt)
       SELECT 'ntf_' || u.n || '_' || s.n, ${userId('u.n')}, 'act_0_' || (1 + abs(random()) % ${giantActs}),
              CASE WHEN abs(random()) % 100 < 70 THEN ${NOW} END, ${NOW} - s.n * 600000 - u.n
       FROM s JOIN (${cte(NOTIF_USERS).replace('s(n)', 'u(n)').replace('FROM s', 'FROM u')} SELECT n FROM u) u`,
    ),
  );

  console.log('integrity + settle');
  const fk = (await prisma.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check')) as unknown[];
  console.log(`  foreign_key_check violations: ${fk.length}`);
  if (fk.length) console.log(fk.slice(0, 5));
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = DELETE'); // back to Prisma's default for an honest baseline
  await prisma.$queryRawUnsafe('PRAGMA synchronous = FULL');
  await sql('DROP TABLE _words');
  await prisma.$queryRawUnsafe('VACUUM'); // before the search index exists: VACUUM may renumber rowids it links to
  console.log('search index + planner statistics');
  await timed('full-text index (trigram)', () => ensureSearchIndex());
  await timed('ANALYZE', () => sql('ANALYZE'));
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');

  const count = async (t: string) => Number(((await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*) c FROM "${t}"`))[0]).c);
  console.log('\nRow counts:');
  let total = 0;
  for (const t of ['User', 'Workspace', 'Membership', 'Project', 'Issue', 'Comment', '_IssueToLabel', 'Label', 'Activity', 'Notification']) {
    const c = await count(t);
    total += c;
    console.log(`  ${t.padEnd(16)} ${c.toLocaleString()}`);
  }
  console.log(`  ${'TOTAL'.padEnd(16)} ${total.toLocaleString()}`);
  console.log(`\nDone in ${((performance.now() - t0) / 1000).toFixed(0)}s (issues planned: ${issues.toLocaleString()}, activity: ${activities.toLocaleString()})`);
  await prisma.$disconnect();
}

await main();
