import type { ApolloCache, StoreObject } from '@apollo/client';
import type { Modifier } from '@apollo/client/cache';

// Objects arriving from mutations and subscriptions are normalized into the cache automatically
// (Issue:abc is updated in place everywhere it appears). What the cache CANNOT know is list
// membership — "this new issue belongs in that project's board" — so we tell it explicitly.
// Every helper is idempotent: the same entity can arrive via the mutation result AND a subscription
// event, and must only appear once.

type Connection = { edges?: { node: unknown }[]; totalCount?: number } | undefined;

function insertEdge(
  cache: ApolloCache<unknown>,
  parentId: string | undefined,
  field: string,
  entity: StoreObject & { __typename: string; id: string },
  edgeType: string,
  position: 'start' | 'end',
  extras: Record<string, (value: number) => number> = {},
) {
  if (!parentId) return;

  const modifier: Modifier<any> = (existing: Connection, { readField, toReference }) => {
    if (!existing?.edges) return existing; // list not loaded yet: nothing to patch, it will fetch fresh
    if (existing.edges.some((e) => readField('id', e.node as never) === entity.id)) return existing;
    const ref = toReference(entity);
    if (!ref) return existing;
    const edge = { __typename: edgeType, cursor: `local:${entity.id}`, node: ref };
    const patched: Record<string, unknown> = { ...existing };
    for (const [key, fn] of Object.entries(extras)) {
      const current = (existing as Record<string, unknown>)[key];
      if (typeof current === 'number') patched[key] = fn(current);
    }
    patched.edges = position === 'start' ? [edge, ...existing.edges] : [...existing.edges, edge];
    return patched;
  };

  cache.modify({ id: parentId, fields: { [field]: modifier } });
}

/** A newly created issue belongs at the bottom of its project's (unfiltered) board list. */
export function addIssueToProject(cache: ApolloCache<unknown>, projectId: string, issueId: string) {
  insertEdge(
    cache,
    cache.identify({ __typename: 'Project', id: projectId }),
    'issues',
    { __typename: 'Issue', id: issueId },
    'IssueEdge',
    'end',
    { totalCount: (n) => n + 1 },
  );
}

export function addActivityToFeed(cache: ApolloCache<unknown>, workspaceId: string, activityId: string) {
  insertEdge(
    cache,
    cache.identify({ __typename: 'Workspace', id: workspaceId }),
    'activity',
    { __typename: 'Activity', id: activityId },
    'ActivityEdge',
    'start',
  );
}

export function addNotificationToInbox(cache: ApolloCache<unknown>, notificationId: string) {
  insertEdge(
    cache,
    'ROOT_QUERY',
    'notifications',
    { __typename: 'Notification', id: notificationId },
    'NotificationEdge',
    'start',
    { unreadCount: (n) => n + 1 },
  );
}

export function addCommentToIssue(cache: ApolloCache<unknown>, issueId: string, commentId: string) {
  const id = cache.identify({ __typename: 'Issue', id: issueId });
  if (!id) return;

  const modifier: Modifier<any> = (existing: readonly unknown[] = [], { readField, toReference }) => {
    if (existing.some((c) => readField('id', c as never) === commentId)) return existing;
    const ref = toReference({ __typename: 'Comment', id: commentId });
    return ref ? [...existing, ref] : existing;
  };

  cache.modify({ id, fields: { comments: modifier } });
}
