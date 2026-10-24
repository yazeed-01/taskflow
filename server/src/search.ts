import { prisma } from './db.js';

// Substring title search at scale: SQLite FTS5 with the `trigram` tokenizer.
//
// `title LIKE '%login%'` can't use an index, so it reads every row of the tenant (600,000 for the biggest
// workspace) — ~250 ms of CPU per search, which is half a second of a 0.5 vCPU server. A trigram index maps
// every 3-character slice of every title to the rows that contain it, so a substring match becomes a few
// index lookups.
//
// The index is a *derived* structure kept in sync by triggers. It lives outside Prisma's schema (Prisma can't
// model virtual tables), so it's created here, idempotently, at startup.
//
// CAVEAT: rows are linked by SQLite `rowid`. `VACUUM` may renumber rowids of tables without an INTEGER
// primary key, so after a VACUUM run `npm run search:rebuild`.

export const SEARCH_CAP = 1000; // a search that matches more than this is "common": see searchIssueIds
export const MIN_TERM = 3; // trigram needs at least 3 characters; shorter terms fall back to LIKE

const TABLE = 'IssueSearch';

// The workspace is an *indexed* token ('|ws_7|'), not a post-filter column. A query for "login" in a small tenant
// then intersects two short lists instead of walking every tenant's matches and discarding most of them
// (measured: 41 ms -> 1 ms for a small tenant, unchanged for the giant one).
const CREATE_TABLE = `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(title, ws, tokenize = 'trigram')`;

const TRIGGERS: Record<string, string> = {
  issue_search_ai: `CREATE TRIGGER IF NOT EXISTS issue_search_ai AFTER INSERT ON Issue BEGIN
    INSERT INTO ${TABLE} (rowid, title, ws) VALUES (new.rowid, new.title, '|' || new.workspaceId || '|');
  END`,
  issue_search_ad: `CREATE TRIGGER IF NOT EXISTS issue_search_ad AFTER DELETE ON Issue BEGIN
    DELETE FROM ${TABLE} WHERE rowid = old.rowid;
  END`,
  issue_search_au: `CREATE TRIGGER IF NOT EXISTS issue_search_au AFTER UPDATE OF title, workspaceId ON Issue BEGIN
    DELETE FROM ${TABLE} WHERE rowid = old.rowid;
    INSERT INTO ${TABLE} (rowid, title, ws) VALUES (new.rowid, new.title, '|' || new.workspaceId || '|');
  END`,
};

let ready: Promise<void> | undefined;

export function ensureSearchIndex(): Promise<void> {
  return (ready ??= (async () => {
    const found = await prisma.$queryRawUnsafe<{ sql: string }[]>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${TABLE}'`,
    );
    // An index built by an older version of this file (workspaceId as an unindexed column) is dropped and rebuilt.
    const stale = found.length > 0 && !/\bws\b/.test(found[0].sql);
    if (stale) {
      for (const name of Object.keys(TRIGGERS)) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name}`);
      await prisma.$executeRawUnsafe(`DROP TABLE ${TABLE}`);
    }
    const isNew = found.length === 0 || stale;
    await prisma.$executeRawUnsafe(CREATE_TABLE);
    for (const sql of Object.values(TRIGGERS)) await prisma.$executeRawUnsafe(sql);
    // A brand-new index over existing data needs a one-time backfill. For big databases do it offline
    // (scripts/apply-scale-migration.ts); this path is for fresh/small databases and tests.
    if (isNew) await rebuildSearchIndex();
  })());
}

export async function rebuildSearchIndex() {
  await prisma.$executeRawUnsafe(`DELETE FROM ${TABLE}`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TABLE} (rowid, title, ws) SELECT rowid, title, '|' || workspaceId || '|' FROM Issue`,
  );
  await optimizeSearchIndex();
}

/**
 * FTS5 writes small segments and merges them lazily. After a bulk delete+insert the index is fragmented and
 * every query pays for walking many segments (measured: 3 ms -> 139 ms). 'optimize' merges them into one.
 * Worth running after any bulk change; normal one-row-at-a-time writes keep themselves tidy.
 */
export const optimizeSearchIndex = () => prisma.$executeRawUnsafe(`INSERT INTO ${TABLE} (${TABLE}) VALUES ('optimize')`);

/** FTS5 phrase syntax: wrap in double quotes, double any quote inside. */
const phrase = (term: string) => `"${term.replace(/"/g, '""')}"`;

export type SearchProbe =
  | { kind: 'ids'; ids: string[] } // selective term: here is the complete match set (<= SEARCH_CAP)
  | { kind: 'common' } // matches more than SEARCH_CAP issues in this workspace
  | { kind: 'unavailable' }; // term too short for trigrams

/**
 * Asks the index "which issues in this workspace contain `term`?", but never reads more than SEARCH_CAP+1 hits.
 *  - Few matches (typical for a specific word, a ticket number, a typo): we get the full id list and the caller
 *    fetches exactly those rows. Cost is proportional to the matches, not to the tenant size.
 *  - Many matches: the term is common, so scanning issues newest-first and stopping at the first page is already
 *    cheap (matches are dense). The caller does that and reports a capped total.
 */
export async function searchIssueIds(workspaceId: string, term: string): Promise<SearchProbe> {
  if ([...term].length < MIN_TERM) return { kind: 'unavailable' };
  await ensureSearchIndex();
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT i.id FROM ${TABLE} s JOIN Issue i ON i.rowid = s.rowid WHERE ${TABLE} MATCH ? LIMIT ${SEARCH_CAP + 1}`,
    `{title}: ${phrase(term)} AND {ws}: ${phrase(`|${workspaceId}|`)}`,
  );
  return rows.length > SEARCH_CAP ? { kind: 'common' } : { kind: 'ids', ids: rows.map((r) => r.id) };
}
