// Tests run against a throwaway SQLite file, never the dev database: build it fresh, then seed it.
// The bench data is created here, once — test files run in parallel and must not race to create it.
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const f of ['test.db', 'test.db-journal']) {
  rmSync(new URL(`../prisma/${f}`, import.meta.url), { force: true });
}
const run = (cmd) => {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, DATABASE_URL: 'file:./test.db' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npx prisma db push --skip-generate');
run('npx tsx --env-file=.env.test prisma/seed.ts');
run('npx tsx --env-file=.env.test scripts/seed-bench.ts');
