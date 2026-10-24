import { withFilter } from 'graphql-subscriptions';
import { GraphQLError } from 'graphql';
import { requireUser, type Context } from './context.js';
import { dbId } from './ids.js';
import { authorize, workspaceIdOf } from './authz.js';
import { isMemberCached } from './membershipCache.js';
import { pubsub, TOPIC } from './events.js';
import { clearLoaders } from './loaders.js';

// Authorization happens twice, on purpose:
//  1. at subscribe time (a non-member can't open the stream — and learns nothing: NOT_FOUND), and
//  2. per event (a member who is removed mid-stream stops receiving, instead of keeping the socket's
//     original permissions for as long as it stays open).

const stillMember = async (ctx: Context, workspaceId: string) => !!ctx.user && (await isMemberCached(ctx.user.id, workspaceId));

// Resolving an event reuses the socket's context, so drop the DataLoader caches first or the second
// event would be built from the first event's cached users/projects.
const fresh = (field: string) => (payload: Record<string, unknown>, _args: unknown, ctx: Context) => {
  clearLoaders(ctx.loaders);
  return payload[field];
};

export const subscriptionResolvers = {
  Subscription: {
    issueEvents: {
      subscribe: async (root: unknown, args: { projectId: string }, ctx: Context, info: never) => {
        const user = requireUser(ctx);
        const projectId = dbId(args.projectId, 'Project');
        const workspaceId = await workspaceIdOf('Project', projectId);
        if (!workspaceId) throw new GraphQLError('Project not found', { extensions: { code: 'NOT_FOUND' } });
        await authorize(user.id, workspaceId, 'MEMBER', 'Project');
        return (withFilter as any)(
          () => pubsub.asyncIterableIterator(TOPIC.issue),
          async (p: any, _a: unknown, c: Context) => p.projectId === projectId && (await stillMember(c, p.workspaceId)),
        )(root, args, ctx, info);
      },
      resolve: fresh('issueEvents'),
    },

    commentAdded: {
      subscribe: async (root: unknown, args: { issueId: string }, ctx: Context, info: never) => {
        const user = requireUser(ctx);
        const issueId = dbId(args.issueId, 'Issue');
        const workspaceId = await workspaceIdOf('Issue', issueId);
        if (!workspaceId) throw new GraphQLError('Issue not found', { extensions: { code: 'NOT_FOUND' } });
        await authorize(user.id, workspaceId, 'MEMBER', 'Issue');
        return (withFilter as any)(
          () => pubsub.asyncIterableIterator(TOPIC.comment),
          async (p: any, _a: unknown, c: Context) => p.issueId === issueId && (await stillMember(c, p.workspaceId)),
        )(root, args, ctx, info);
      },
      resolve: fresh('commentAdded'),
    },

    activityAdded: {
      subscribe: async (root: unknown, args: { workspaceId: string }, ctx: Context, info: never) => {
        const user = requireUser(ctx);
        const workspaceId = dbId(args.workspaceId, 'Workspace');
        await authorize(user.id, workspaceId, 'MEMBER', 'Workspace');
        return (withFilter as any)(
          () => pubsub.asyncIterableIterator(TOPIC.activity),
          async (p: any, _a: unknown, c: Context) => p.workspaceId === workspaceId && (await stillMember(c, workspaceId)),
        )(root, args, ctx, info);
      },
      resolve: fresh('activityAdded'),
    },

    notificationReceived: {
      subscribe: (root: unknown, args: unknown, ctx: Context, info: never) => {
        const user = requireUser(ctx);
        // Addressed to a user: the filter is the entire access control, so it must be exact.
        return (withFilter as any)(
          () => pubsub.asyncIterableIterator(TOPIC.notification),
          (p: any) => p.userId === user.id,
        )(root, args, ctx, info);
      },
      resolve: fresh('notificationReceived'),
    },
  },
};
