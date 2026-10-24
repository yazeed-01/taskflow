// Rebuilds the full-text index from the Issue table. Run after a VACUUM, or if search results look stale.
//   DATABASE_URL=... npx tsx scripts/rebuild-search.ts
import { performance } from 'node:perf_hooks';
import { prisma } from '../src/db.js';
import { ensureSearchIndex, rebuildSearchIndex } from '../src/search.js';

const t = performance.now();
await ensureSearchIndex(); // also upgrades an index built with an older definition
await rebuildSearchIndex();
await prisma.$executeRawUnsafe('ANALYZE');
console.log(`search index rebuilt in ${((performance.now() - t) / 1000).toFixed(1)}s`);
await prisma.$disconnect();
