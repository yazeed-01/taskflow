import { GraphQLError } from 'graphql';
import type { Activity, ActivityType, Issue, Label, Notification, Project, User } from '@prisma/client';
import type { Loaders } from './loaders.js';
import { prisma } from './db.js';
import { pubsub, TOPIC } from './events.js';


// ---------- keyset pagination on (createdAt DESC, id DESC) shared by activity + notifications ----------

const MAX_PAGE = 100;
const bad = (message: string, field: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', field } });

export function checkFirst(first: number | null | undefined): number {
  const n = first ?? 20;
  if (!Number.isInteger(n) || n < 0 || n > MAX_PAGE) throw bad(`first must be between 0 and ${MAX_PAGE}`, 'first');
  return n;
}

const encodeCursor = (row: { createdAt: Date; id: string }) =>
  Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), i: row.id })).toString('base64url');

function cursorWhere(cursor: string | null | undefined) {
  if (!cursor) return {};
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t: string; i: string };
    const d = new Date(c.t);
    if (typeof c.i === 'string' && !isNaN(d.getTime())) {
      return { OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: c.i } }] };
    }
  } catch {
    /* fall through */
  }
  throw bad('Invalid cursor', 'after');
}

function toConnection<T extends { createdAt: Date; id: string }>(rows: T[], first: number, hasCursor: boolean) {
  const edges = rows.slice(0, first).map((node) => ({ cursor: encodeCursor(node), node }));
  return {
    edges,
    pageInfo: {
      hasNextPage: rows.length > first,
      hasPreviousPage: hasCursor,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

type PageArgs = { first?: number | null; after?: string | null };

/** Caller must already have authorized access to `workspaceId`. */
export async function activityConnection(workspaceId: string, args: PageArgs) {
  const first = checkFirst(args.first);
  const rows = await prisma.activity.findMany({
    where: { workspaceId, ...cursorWhere(args.after) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: first + 1,
  });
  return toConnection(rows, first, !!args.after);
}

export async function notificationConnection(userId: string, args: PageArgs & { unreadOnly?: boolean | null }) {
  const first = checkFirst(args.first);
  const rows = await prisma.notification.findMany({
    where: { userId, ...(args.unreadOnly && { readAt: null }), ...cursorWhere(args.after) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: first + 1,
  });
  return { ...toConnection(rows, first, !!args.after), userId };
}

export const unreadCount = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });

// ---------- recording + publishing ----------

export const STATUS_LABEL = {
  BACKLOG: 'Backlog',
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  DONE: 'Done',
} as const;

/**
 * Appends to the activity feed, fans out notifications, and pushes both over subscriptions.
 * Failures are logged, not thrown: the mutation that triggered this already succeeded, and a
 * broken feed must not make the client think the user's change was lost.
 */
export async function recordActivity(a: {
  workspaceId: string;
  actor: User;
  type: ActivityType;
  issueId?: string;
  summary: string;
  notify?: (string | null | undefined)[];
}): Promise<Activity | null> {
  try {
    const activity = await prisma.activity.create({
      data: { workspaceId: a.workspaceId, actorId: a.actor.id, type: a.type, issueId: a.issueId, summary: a.summary },
    });
    void pubsub.publish(TOPIC.activity, { activityAdded: activity, workspaceId: a.workspaceId });

    const recipients = new Set((a.notify ?? []).filter((id): id is string => !!id && id !== a.actor.id));
    for (const userId of recipients) {
      const notification: Notification = await prisma.notification.create({
        data: { userId, activityId: activity.id },
      });
      void pubsub.publish(TOPIC.notification, { notificationReceived: notification, userId });
    }
    return activity;
  } catch (e) {
    console.error('recordActivity failed', e);
    return null;
  }
}

/** Everything an issue event's selection set usually asks for, loaded ONCE per event (not once per subscriber). */
export interface Prefetched {
  project: Project | null;
  assignee: User | null;
  reporter: User | null;
  labels: Label[];
}

export const prefetchedOf = (issue: object): Prefetched | undefined => (issue as { __pre?: Prefetched }).__pre;

/**
 * Publishes an issue event to subscribers.
 *
 * With 200 subscribers on a busy project, one move means 200 deliveries. If each delivery re-queried the assignee,
 * the labels and the project, that is ~600 SQL queries for one drag-and-drop (measured: end-to-end latency grew to
 * 11 s on a 0.5 vCPU server). So the related data is loaded here, once, and attached to the issue object that all
 * subscribers share; the field resolvers use it when present and fall back to DataLoaders otherwise.
 */
export async function publishIssueEvent(
  type: 'CREATED' | 'UPDATED' | 'MOVED',
  issue: Issue,
  actor: User,
  workspaceId: string,
  loaders: Loaders,
) {
  try {
    const [project, assignee, reporter, labels] = await Promise.all([
      loaders.project.load(issue.projectId),
      issue.assigneeId ? loaders.user.load(issue.assigneeId) : null,
      loaders.user.load(issue.reporterId),
      loaders.labelsByIssue.load(issue.id),
    ]);
    // non-enumerable: invisible to JSON/spread, only our resolvers look for it
    Object.defineProperty(issue, '__pre', { value: { project, assignee, reporter, labels } satisfies Prefetched });
  } catch (e) {
    console.error('publishIssueEvent prefetch failed (subscribers will load lazily)', e);
  }
  void pubsub.publish(TOPIC.issue, { issueEvents: { type, issue, actor }, projectId: issue.projectId, workspaceId });
}

