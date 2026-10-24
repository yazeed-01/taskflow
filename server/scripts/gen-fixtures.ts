// Writes loadtest/data/fixtures.json: who the virtual users are and what they request.
//   DATABASE_URL=... JWT_SECRET=... npx tsx scripts/gen-fixtures.ts
// Tokens are signed here with the same secret the server uses, so the hot path under test is the
// GraphQL work itself rather than bcrypt (login has its own, separate scenario).
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/db.js';
import { signToken } from '../src/auth.js';
import { toGlobalId } from '../src/ids.js';

const rnd = (n: number) => 1 + Math.floor(Math.random() * n);
const sample = <T>(arr: T[], n: number) => Array.from({ length: n }, () => arr[Math.floor(Math.random() * arr.length)]);

const workspaces = await prisma.workspace.findMany({ orderBy: { id: 'asc' } });
const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), terms: {} };

async function describe(wsId: string, userCount: number, issuesPerProjectSample: number) {
  const members = await prisma.membership.findMany({ where: { workspaceId: wsId }, select: { userId: true, role: true } });
  const projects = await prisma.project.findMany({ where: { workspaceId: wsId }, orderBy: { id: 'asc' } });
  const users = sample(members, userCount).map((m) => ({ id: toGlobalId('User', m.userId), role: m.role, token: signToken(m.userId) }));
  return {
    workspaceId: toGlobalId('Workspace', wsId),
    users,
    projects: projects.map((p) => ({
      id: toGlobalId('Project', p.id),
      issueCount: p.issueCounter,
      // deterministic ids from the seeder: 'prj_<ws>_<p>_<n>'
      issueIds: Array.from({ length: issuesPerProjectSample }, () => toGlobalId('Issue', `${p.id}_${rnd(p.issueCounter)}`)),
    })),
  };
}

const giantWs = workspaces.find((w) => w.slug === 'megacorp')!;
out.giant = { slug: giantWs.slug, ...(await describe(giantWs.id, 400, 1500)) };
out.small = [];
for (const w of workspaces.filter((x) => x.slug.startsWith('team-'))) {
  (out.small as unknown[]).push({ slug: w.slug, ...(await describe(w.id, 4, 100)) });
}

// Search terms by selectivity. The title generator picks 2 of 40 words per issue, so a single word matches ~5%
// of titles (common); a "#number" matches almost nothing (rare); a word that is in no title matches nothing.
out.terms = {
  common: ['login', 'checkout', 'search', 'dashboard', 'billing', 'export', 'cache', 'mobile'],
  rare: ['#4242', '#77777', '#119999', '#31337'],
  none: ['zzyzx', 'qwertyuiop'],
};

mkdirSync(new URL('../../loadtest/data/', import.meta.url), { recursive: true });
const file = new URL('../../loadtest/data/fixtures.json', import.meta.url);
writeFileSync(file, JSON.stringify(out));
console.log(`fixtures written: ${(out.small as unknown[]).length} small workspaces, giant has ${(out.giant as { projects: unknown[] }).projects.length} projects`);
await prisma.$disconnect();
