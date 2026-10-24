import DataLoader from 'dataloader';
import type { Activity, Comment, Issue, Label, Project, User, Workspace } from '@prisma/client';
import { prisma } from './db.js';

// One set of loaders PER REQUEST (built in buildContext). Within a request a loader collects every
// .load(key) made during one tick of the event loop and turns them into a single batched query,
// and caches results by key. A per-request instance means the cache can never leak between users.
//
// SECURITY: loaders do not check permissions. Only use them for children of an object the caller
// was already authorized to see (e.g. Issue.assignee after Query.issue passed canRead).

const MAX_BATCH = 500; // stay under SQLite's bound-parameter limit

function byId<T extends { id: string }>(rows: T[], ids: readonly string[]): (T | null)[] {
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id) ?? null); // DataLoader requires results in the same order as keys
}

function group<T>(keys: readonly string[], rows: T[], keyOf: (row: T) => string): T[][] {
  const map = new Map<string, T[]>(keys.map((k) => [k, []]));
  for (const row of rows) map.get(keyOf(row))?.push(row);
  return keys.map((k) => map.get(k)!);
}

export function createLoaders(viewer: User | null) {
  const user = new DataLoader<string, User | null>(
    async (ids) => byId(await prisma.user.findMany({ where: { id: { in: [...ids] } } }), ids),
    { maxBatchSize: MAX_BATCH },
  );
  if (viewer) user.prime(viewer.id, viewer);

  let viewerWorkspaces: Promise<string[]> | undefined;
  const viewerWorkspaceIds = () =>
    (viewerWorkspaces ??= viewer
      ? prisma.membership.findMany({ where: { userId: viewer.id }, select: { workspaceId: true } }).then((m) => m.map((x) => x.workspaceId))
      : Promise.resolve([]));

  return {
    user,

    project: new DataLoader<string, Project | null>(
      async (ids) => byId(await prisma.project.findMany({ where: { id: { in: [...ids] } } }), ids),
      { maxBatchSize: MAX_BATCH },
    ),

    workspace: new DataLoader<string, Workspace | null>(
      async (ids) => byId(await prisma.workspace.findMany({ where: { id: { in: [...ids] } } }), ids),
      { maxBatchSize: MAX_BATCH },
    ),

    issue: new DataLoader<string, Issue | null>(
      async (ids) => byId(await prisma.issue.findMany({ where: { id: { in: [...ids] } } }), ids),
      { maxBatchSize: MAX_BATCH },
    ),

    activity: new DataLoader<string, Activity | null>(
      async (ids) => byId(await prisma.activity.findMany({ where: { id: { in: [...ids] } } }), ids),
      { maxBatchSize: MAX_BATCH },
    ),

    labelsByIssue: new DataLoader<string, Label[]>(
      async (issueIds) => {
        const rows = await prisma.issue.findMany({
          where: { id: { in: [...issueIds] } },
          select: { id: true, labels: true },
        });
        const map = new Map(rows.map((r) => [r.id, r.labels]));
        return issueIds.map((id) => map.get(id) ?? []);
      },
      { maxBatchSize: MAX_BATCH },
    ),

    commentsByIssue: new DataLoader<string, Comment[]>(
      async (issueIds) => {
        const rows = await prisma.comment.findMany({
          where: { issueId: { in: [...issueIds] } },
          orderBy: { createdAt: 'asc' },
        });
        return group(issueIds, rows, (c) => c.issueId);
      },
      { maxBatchSize: MAX_BATCH },
    ),

    /** Does this user share at least one workspace with the viewer? (drives field-level auth on User.email) */
    sharesWorkspaceWithViewer: new DataLoader<string, boolean>(
      async (userIds) => {
        if (!viewer) return userIds.map(() => false);
        const mine = await viewerWorkspaceIds();
        const rows = await prisma.membership.findMany({
          where: { userId: { in: [...userIds] }, workspaceId: { in: mine } },
          select: { userId: true },
        });
        const shared = new Set(rows.map((r) => r.userId));
        return userIds.map((id) => id === viewer.id || shared.has(id));
      },
      { maxBatchSize: MAX_BATCH },
    ),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;

/**
 * Subscriptions reuse one context for the whole life of a socket, so a per-request cache would serve
 * stale data on later events. The subscription resolvers call this before resolving each event.
 */
export function clearLoaders(loaders: Loaders) {
  for (const l of Object.values(loaders)) l.clearAll();
}
