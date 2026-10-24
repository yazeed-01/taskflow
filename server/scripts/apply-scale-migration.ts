// Upgrades an EXISTING database (one built before the scale work) in place. Idempotent: safe to re-run.
//
//   DATABASE_URL="file:./prod.db?connection_limit=1" npx tsx scripts/apply-scale-migration.ts
//
// Fresh databases don't need this: `prisma db push` creates the new columns/indexes, and the search index is
// created at server startup. This script exists because `db push` refuses to add a required column to a table
// that already has rows — and re-seeding is not an option for real data.
//
// Run it with the app stopped (it rewrites every Issue row and builds indexes; on 1M issues expect ~1 minute).
import { performance } from 'node:perf_hooks';
import { prisma } from '../src/db.js';
import { ensureSearchIndex } from '../src/search.js';

const run = (sql: string) => prisma.$executeRawUnsafe(sql);
const step = async (label: string, fn: () => Promise<unknown>) => {
  const t = performance.now();
  await fn();
  console.log(`  ${label.padEnd(52)} ${((performance.now() - t) / 1000).toFixed(1)}s`);
};

const cols = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(Issue)`);
console.log('Applying scale migration');

await prisma.$queryRawUnsafe('PRAGMA foreign_keys = OFF'); // SQLite can't add an FK to an existing column
await prisma.$queryRawUnsafe('PRAGMA cache_size = -400000');

if (!cols.some((c) => c.name === 'workspaceId')) {
  await step('add Issue.workspaceId', () => run(`ALTER TABLE Issue ADD COLUMN workspaceId TEXT NOT NULL DEFAULT ''`));
  await step('backfill Issue.workspaceId from Project', () =>
    run(`UPDATE Issue SET workspaceId = (SELECT p.workspaceId FROM Project p WHERE p.id = Issue.projectId)`),
  );
}
const orphans = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*) n FROM Issue WHERE workspaceId = ''`);
if (Number(orphans[0].n) > 0) throw new Error(`${orphans[0].n} issues have no workspace (orphaned projectId?) — aborting`);

await run(`DROP INDEX IF EXISTS Issue_projectId_status_position_idx`);
const indexes: [string, string][] = [
  ['Issue_projectId_position_id_idx', 'projectId, position, id'],
  ['Issue_projectId_status_position_id_idx', 'projectId, status, position, id'],
  ['Issue_projectId_createdAt_id_idx', 'projectId, createdAt, id'],
  ['Issue_workspaceId_createdAt_id_idx', 'workspaceId, createdAt, id'],
  ['Issue_workspaceId_assigneeId_createdAt_id_idx', 'workspaceId, assigneeId, createdAt, id'],
];
for (const [name, cols] of indexes) await step(`index ${name}`, () => run(`CREATE INDEX IF NOT EXISTS ${name} ON Issue (${cols})`));

await step('full-text (trigram) search index + triggers', () => ensureSearchIndex());
// Planner statistics: tell SQLite how selective each index is so it picks them (and in the right order).
await step('ANALYZE', () => run('ANALYZE'));
// WAL: readers no longer block the writer and vice versa (a persistent property of the database file).
await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
console.log('Done.');
await prisma.$disconnect();
