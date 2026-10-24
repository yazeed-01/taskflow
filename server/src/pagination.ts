import { GraphQLError } from 'graphql';
import type { Issue, IssuePriority, IssueStatus, Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { dbId } from './ids.js';
import { SEARCH_CAP, searchIssueIds } from './search.js';

// Keyset ("cursor") pagination: instead of OFFSET n (which re-scans n rows and skips/duplicates rows
// when data changes between pages), the cursor remembers the sort key of the last row seen and the
// next page asks for "rows after that key". Stable and index-friendly.

export type IssueOrder = 'POSITION' | 'NEWEST';

export interface IssueFilter {
  status?: IssueStatus | null;
  priority?: IssuePriority | null;
  assigneeId?: string | null;
  unassigned?: boolean | null;
  labelId?: string | null;
  search?: string | null;
}

export interface IssueConnectionArgs {
  first?: number | null;
  after?: string | null;
  filter?: IssueFilter | null;
  orderBy?: IssueOrder | null;
}

export const COUNT_CAP = 10_000;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

const bad = (message: string, field: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', field } });

interface Cursor {
  o: IssueOrder;
  v: number | string; // POSITION: the float position. NEWEST: createdAt as ISO string.
  i: string; // id tie-breaker so the order is total even when sort keys collide
}

const encode = (order: IssueOrder, issue: Issue): string => {
  const c: Cursor = { o: order, v: order === 'POSITION' ? issue.position : issue.createdAt.toISOString(), i: issue.id };
  return Buffer.from(JSON.stringify(c)).toString('base64url');
};

function decode(cursor: string, order: IssueOrder): Cursor {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    const valid =
      c.o === order &&
      typeof c.i === 'string' &&
      (order === 'POSITION' ? typeof c.v === 'number' && Number.isFinite(c.v) : typeof c.v === 'string' && !isNaN(Date.parse(c.v)));
    if (valid) return c;
  } catch {
    /* fall through */
  }
  throw bad('Invalid cursor (or cursor was issued for a different orderBy)', 'after');
}

function filterToWhere(f: IssueFilter | null | undefined): Prisma.IssueWhereInput {
  if (!f) return {};
  const where: Prisma.IssueWhereInput = {};
  if (f.status) where.status = f.status;
  if (f.priority) where.priority = f.priority;
  if (f.unassigned && f.assigneeId) throw bad('Use either assigneeId or unassigned, not both', 'filter');
  if (f.assigneeId) where.assigneeId = dbId(f.assigneeId, 'User');
  if (f.unassigned) where.assigneeId = null;
  if (f.labelId) where.labels = { some: { id: dbId(f.labelId, 'Label') } };
  return where; // text search is handled separately in paginateIssues (it needs the search index)
}

function cursorToWhere(c: Cursor | null): Prisma.IssueWhereInput {
  if (!c) return {};
  if (c.o === 'POSITION') {
    const p = c.v as number;
    return { OR: [{ position: { gt: p } }, { position: p, id: { gt: c.i } }] };
  }
  const d = new Date(c.v as string);
  return { OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: c.i } }] };
}

export interface IssueConnection {
  edges: { cursor: string; node: Issue }[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  /** Kept so `totalCount` can be computed lazily — only if the client asks for it. */
  where: Prisma.IssueWhereInput;
  /** totalCount never counts past this: counting 600,000 rows to print "600,000" is not worth a request. */
  countCap: number;
}

/** `scope` is the authorization boundary (a project or a workspace); the caller has already authorized it. */
export async function paginateIssues(
  scope: Prisma.IssueWhereInput,
  args: IssueConnectionArgs,
  workspaceId: string,
): Promise<IssueConnection> {
  const first = args.first ?? DEFAULT_PAGE;
  if (!Number.isInteger(first) || first < 0 || first > MAX_PAGE) throw bad(`first must be between 0 and ${MAX_PAGE}`, 'first');
  const order: IssueOrder = args.orderBy ?? 'POSITION';
  const cursor = args.after ? decode(args.after, order) : null;

  let filterWhere = filterToWhere(args.filter);
  let countCap = COUNT_CAP;
  const term = args.filter?.search?.trim();
  if (term) {
    if (term.length > 100) throw bad('Search text is too long (max 100)', 'filter');
    const probe = await searchIssueIds(workspaceId, term);
    if (probe.kind === 'ids') {
      filterWhere = { AND: [filterWhere, { id: { in: probe.ids } }] }; // selective: fetch exactly the matches
    } else {
      filterWhere = { AND: [filterWhere, { title: { contains: term } }] }; // common/short: dense matches, newest-first scan stops early
      if (probe.kind === 'common') countCap = SEARCH_CAP;
    }
  }

  const where: Prisma.IssueWhereInput = { AND: [scope, filterWhere] };
  const rows = await prisma.issue.findMany({
    where: { AND: [where, cursorToWhere(cursor)] },
    orderBy: order === 'POSITION' ? [{ position: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
    take: first + 1, // fetch one extra row: its existence is hasNextPage, no COUNT needed
  });

  const page = rows.slice(0, first);
  const edges = page.map((node) => ({ cursor: encode(order, node), node }));
  return {
    edges,
    where,
    countCap,
    pageInfo: {
      hasNextPage: rows.length > first,
      hasPreviousPage: !!cursor, // forward-only pagination: if we were given a cursor, there is a previous page
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

export const countIssues = (where: Prisma.IssueWhereInput, cap: number) => prisma.issue.count({ where, take: cap });
