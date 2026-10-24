// Prints SQLite's query plan for the hot-path queries (same SQL shape Prisma generates).
//   DATABASE_URL=file:... npx tsx scripts/explain.ts
// Look for "SCAN" (reads every row) vs "SEARCH ... USING INDEX", and "USE TEMP B-TREE FOR ORDER BY" (a sort).
import { prisma } from '../src/db.js';

const P = 'prj_0_0'; // a 120,000-issue project
const WS = 'ws_0'; // the giant workspace
const plans: Record<string, string> = {
  'board: first page (project, by position)':
    `SELECT * FROM Issue WHERE projectId = '${P}' ORDER BY position ASC, id ASC LIMIT 101`,
  'board: next page (cursor)':
    `SELECT * FROM Issue WHERE projectId = '${P}' AND (position > 5000 OR (position = 5000 AND id > 'x')) ORDER BY position ASC, id ASC LIMIT 101`,
  'board: count for totalCount':
    `SELECT count(*) FROM Issue WHERE projectId = '${P}'`,
  'search: project, newest':
    `SELECT * FROM Issue WHERE projectId = '${P}' ORDER BY createdAt DESC, id DESC LIMIT 21`,
  'workspace issues: newest (all projects)':
    `SELECT * FROM Issue WHERE projectId IN (SELECT id FROM Project WHERE workspaceId = '${WS}') ORDER BY createdAt DESC, id DESC LIMIT 21`,
  'workspace issues: title contains':
    `SELECT * FROM Issue WHERE projectId IN (SELECT id FROM Project WHERE workspaceId = '${WS}') AND title LIKE '%login%' ORDER BY createdAt DESC, id DESC LIMIT 21`,
  'workspace issues: count with title contains':
    `SELECT count(*) FROM Issue WHERE projectId IN (SELECT id FROM Project WHERE workspaceId = '${WS}') AND title LIKE '%login%'`,
  'workspace issues: assignee = me':
    `SELECT * FROM Issue WHERE projectId IN (SELECT id FROM Project WHERE workspaceId = '${WS}') AND assigneeId = 'usr_000042' ORDER BY createdAt DESC, id DESC LIMIT 21`,
  'issue detail: comments':
    `SELECT * FROM Comment WHERE issueId IN ('${P}_5') ORDER BY createdAt ASC`,
  'issue detail: labels (join table)':
    `SELECT * FROM _IssueToLabel WHERE A IN ('${P}_5')`,
  'activity feed':
    `SELECT * FROM Activity WHERE workspaceId = '${WS}' ORDER BY createdAt DESC, id DESC LIMIT 21`,
  'notifications inbox':
    `SELECT * FROM Notification WHERE userId = 'usr_000042' ORDER BY createdAt DESC, id DESC LIMIT 21`,
  'notifications unread count':
    `SELECT count(*) FROM Notification WHERE userId = 'usr_000042' AND readAt IS NULL`,
  'permission check (membership)':
    `SELECT * FROM Membership WHERE workspaceId = '${WS}' AND userId = 'usr_000042'`,
};

for (const [name, q] of Object.entries(plans)) {
  const rows = await prisma.$queryRawUnsafe<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${q}`);
  console.log(`\n${name}`);
  for (const r of rows) console.log(`   ${r.detail}`);
}
await prisma.$disconnect();
