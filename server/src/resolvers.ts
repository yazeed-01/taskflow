import { GraphQLError, GraphQLScalarType } from 'graphql';
import type { Issue, IssuePriority, IssueStatus, Role } from '@prisma/client';
import { prisma } from './db.js';
import { requireUser, type Context } from './context.js';
import { dbId, fromGlobalId, toGlobalId, type NodeType } from './ids.js';
import { checkPassword, hashPassword, signToken } from './auth.js';
import { authorize, forbidden, roleIn, workspaceIdOf } from './authz.js';
import { countIssues, paginateIssues, type IssueConnection, type IssueConnectionArgs } from './pagination.js';
import { asResult } from './errors.js';
import {
  activityConnection,
  notificationConnection,
  prefetchedOf,
  publishIssueEvent,
  recordActivity,
  STATUS_LABEL,
  unreadCount,
} from './feed.js';
import { pubsub, TOPIC } from './events.js';
import { forgetMembership } from './membershipCache.js';
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from './ratelimit.js';

const notFound = (what: string) =>
  new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });

const badInput = (message: string, field?: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', field } });

const DateTime = new GraphQLScalarType<Date, string>({
  name: 'DateTime',
  serialize: (v) => (v instanceof Date ? v : new Date(v as string)).toISOString(),
  parseValue: (v) => new Date(v as string),
});

// Every type with a global ID exposes it the same way. Declared once, reused below.
const globalId = (type: NodeType) => ({ id: (o: { id: string }) => toGlobalId(type, o.id) });

// Types reachable through `node(id)`. Activity and Notification are deliberately not Nodes.
const loaders: Partial<Record<NodeType, (id: string) => Promise<unknown>>> = {
  User: (id) => prisma.user.findUnique({ where: { id } }),
  Workspace: (id) => prisma.workspace.findUnique({ where: { id } }),
  Project: (id) => prisma.project.findUnique({ where: { id } }),
  Issue: (id) => prisma.issue.findUnique({ where: { id } }),
  Comment: (id) => prisma.comment.findUnique({ where: { id } }),
  Label: (id) => prisma.label.findUnique({ where: { id } }),
};

type CreateIssueInput = {
  projectId: string;
  title: string;
  description?: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId?: string | null;
  labelIds?: string[] | null;
};

type UpdateIssueInput = {
  id: string;
  title?: string | null;
  description?: string | null;
  priority?: IssuePriority | null;
  assigneeId?: string | null;
  labelIds?: string[] | null;
};

// ---------- authorization helpers ----------

/** Read-side check for queries returning nullable data: non-members get null, never an error that leaks existence. */
async function canRead(ctx: Context, type: NodeType, id: string): Promise<boolean> {
  const user = requireUser(ctx);
  if (type === 'User') return id === user.id || (await sharesWorkspace(user.id, id));
  const workspaceId = await workspaceIdOf(type, id);
  return !!workspaceId && !!(await roleIn(user.id, workspaceId));
}

async function sharesWorkspace(a: string, b: string): Promise<boolean> {
  const mine = await prisma.membership.findMany({ where: { userId: a }, select: { workspaceId: true } });
  const hit = await prisma.membership.findFirst({
    where: { userId: b, workspaceId: { in: mine.map((m) => m.workspaceId) } },
  });
  return !!hit;
}

/** Assignees and labels must belong to the same workspace as the issue (otherwise cross-tenant data leaks). */
async function assertAssignable(workspaceId: string, assigneeId: string) {
  if (!(await roleIn(assigneeId, workspaceId))) throw badInput('Assignee is not a member of this workspace', 'assigneeId');
}
async function assertLabels(workspaceId: string, labelIds: string[]) {
  const count = await prisma.label.count({ where: { id: { in: labelIds }, workspaceId } });
  if (count !== new Set(labelIds).size) throw badInput('Unknown label for this workspace', 'labelIds');
}

async function ownerCount(workspaceId: string) {
  return prisma.membership.count({ where: { workspaceId, role: 'OWNER' } });
}

/** Authorize an action on an existing issue (by global ID). Returns db ids. */
async function authorizeIssue(ctx: Context, globalIssueId: string, min: Role = 'MEMBER') {
  const user = requireUser(ctx);
  const id = dbId(globalIssueId, 'Issue');
  const workspaceId = await workspaceIdOf('Issue', id);
  if (!workspaceId) throw notFound('Issue');
  await authorize(user.id, workspaceId, min, 'Issue');
  return { user, id, workspaceId };
}

const memberPayload = (workspaceId: string, userId: string) =>
  prisma.membership.findUniqueOrThrow({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { user: true },
  });

/** "ENG-12" */
async function identifierOf(ctx: Context, issue: Pick<Issue, 'projectId' | 'number'>) {
  const p = await ctx.loaders.project.load(issue.projectId);
  return `${p!.key}-${issue.number}`;
}

export const resolvers = {
  DateTime,

  Node: {
    // Interfaces need a type resolver; `node(id)` tags its result with __typename.
    __resolveType: (obj: { __typename: string }) => obj.__typename,
  },

  Query: {
    me: (_: unknown, __: unknown, ctx: Context) => ctx.user,
    workspaces: (_: unknown, __: unknown, ctx: Context) => {
      const user = requireUser(ctx);
      return prisma.workspace.findMany({ where: { members: { some: { userId: user.id } } } });
    },
    workspace: (_: unknown, { slug }: { slug: string }, ctx: Context) => {
      const user = requireUser(ctx);
      return prisma.workspace.findFirst({ where: { slug, members: { some: { userId: user.id } } } });
    },
    project: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const raw = dbId(id, 'Project');
      return (await canRead(ctx, 'Project', raw)) ? prisma.project.findUnique({ where: { id: raw } }) : null;
    },
    issue: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const raw = dbId(id, 'Issue');
      return (await canRead(ctx, 'Issue', raw)) ? prisma.issue.findUnique({ where: { id: raw } }) : null;
    },
    notifications: (
      _: unknown,
      args: { first?: number | null; after?: string | null; unreadOnly?: boolean | null },
      ctx: Context,
    ) => notificationConnection(requireUser(ctx).id, args), // scoped to the caller: no way to ask for someone else's
    node: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const { type, id: rawId } = fromGlobalId(id);
      const load = loaders[type];
      if (!load || !(await canRead(ctx, type, rawId))) return null;
      const row = await load(rawId);
      return row ? { __typename: type, ...(row as object) } : null;
    },
  },

  User: {
    ...globalId('User'),
    // Field-level authorization: the same User object, different visibility per viewer.
    email: async (u: { id: string; email: string }, _: unknown, ctx: Context) =>
      ctx.user && (await ctx.loaders.sharesWorkspaceWithViewer.load(u.id)) ? u.email : null,
  },
  Label: globalId('Label'),

  Workspace: {
    ...globalId('Workspace'),
    members: (w: { id: string }) =>
      prisma.membership.findMany({ where: { workspaceId: w.id }, include: { user: true } }),
    projects: (w: { id: string }) => prisma.project.findMany({ where: { workspaceId: w.id } }),
    labels: (w: { id: string }) => prisma.label.findMany({ where: { workspaceId: w.id } }),
    viewerRole: async (w: { id: string }, _: unknown, ctx: Context) => (await roleIn(requireUser(ctx).id, w.id))!,
    // Authorized by the parent: Query.workspace only returns workspaces the viewer belongs to.
    activity: (w: { id: string }, args: { first?: number | null; after?: string | null }) =>
      activityConnection(w.id, args),
    issues: (w: { id: string }, args: IssueConnectionArgs) =>
      paginateIssues({ workspaceId: w.id }, args, w.id),
  },

  Project: {
    ...globalId('Project'),
    workspace: (p: { workspaceId: string }, _: unknown, ctx: Context) =>
      ctx.loaders.workspace.load(p.workspaceId),
    issues: (p: { id: string; workspaceId: string }, args: IssueConnectionArgs) =>
      paginateIssues({ projectId: p.id }, args, p.workspaceId),
  },

  IssueConnection: {
    // Lazy: the COUNT query only runs when a client selects totalCount.
    totalCount: (c: IssueConnection) => countIssues(c.where, c.countCap),
  },

  NotificationConnection: {
    unreadCount: (c: { userId: string }) => unreadCount(c.userId),
  },

  // Child fields go through per-request DataLoaders: 50 issues -> 1 batched query per relation, not 50.
  Issue: {
    ...globalId('Issue'),
    // Fields below prefer data prefetched once for a subscription event (see publishIssueEvent), else use DataLoaders.
    identifier: async (i: { projectId: string; number: number }, _: unknown, ctx: Context) => {
      const p = prefetchedOf(i)?.project ?? (await ctx.loaders.project.load(i.projectId));
      return `${p!.key}-${i.number}`;
    },
    project: (i: { projectId: string }, _: unknown, ctx: Context) =>
      prefetchedOf(i)?.project ?? ctx.loaders.project.load(i.projectId),
    reporter: (i: { reporterId: string }, _: unknown, ctx: Context) =>
      prefetchedOf(i)?.reporter ?? ctx.loaders.user.load(i.reporterId),
    assignee: (i: { assigneeId: string | null }, _: unknown, ctx: Context) =>
      i.assigneeId ? (prefetchedOf(i)?.assignee ?? ctx.loaders.user.load(i.assigneeId)) : null,
    labels: (i: { id: string }, _: unknown, ctx: Context) =>
      prefetchedOf(i)?.labels ?? ctx.loaders.labelsByIssue.load(i.id),
    comments: (i: { id: string }, _: unknown, ctx: Context) => ctx.loaders.commentsByIssue.load(i.id),
  },

  Comment: {
    ...globalId('Comment'),
    issue: (c: { issueId: string }, _: unknown, ctx: Context) => ctx.loaders.issue.load(c.issueId),
    author: (c: { authorId: string }, _: unknown, ctx: Context) => ctx.loaders.user.load(c.authorId),
  },

  Activity: {
    ...globalId('Activity'),
    actor: (a: { actorId: string }, _: unknown, ctx: Context) => ctx.loaders.user.load(a.actorId),
    issue: (a: { issueId: string | null }, _: unknown, ctx: Context) =>
      a.issueId ? ctx.loaders.issue.load(a.issueId) : null,
  },

  Notification: {
    ...globalId('Notification'),
    activity: (n: { activityId: string }, _: unknown, ctx: Context) => ctx.loaders.activity.load(n.activityId),
    read: (n: { readAt: Date | null }) => n.readAt !== null,
  },

  Mutation: {
    // ----- auth (throws: credentials are not "expected data") -----
    signUp: async (_: unknown, { input }: { input: { name: string; email: string; password: string } }) => {
      const email = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badInput('Invalid email', 'email');
      if (input.password.length < 8) throw badInput('Password must be at least 8 characters', 'password');
      if (!input.name.trim()) throw badInput('Name is required', 'name');
      if (await prisma.user.findUnique({ where: { email } })) throw badInput('Email already registered', 'email');
      const user = await prisma.user.create({
        data: { email, name: input.name.trim(), passwordHash: await hashPassword(input.password) },
      });
      return { token: signToken(user.id), user };
    },

    login: async (_: unknown, { input }: { input: { email: string; password: string } }) => {
      const email = input.email.trim().toLowerCase();
      assertLoginAllowed(email);
      const user = await prisma.user.findUnique({ where: { email } });
      const ok = await checkPassword(input.password, user?.passwordHash ?? null);
      if (!user || !ok) {
        recordLoginFailure(email);
        // Same message for unknown email and wrong password.
        throw new GraphQLError('Invalid email or password', { extensions: { code: 'UNAUTHENTICATED' } });
      }
      clearLoginFailures(email);
      return { token: signToken(user.id), user };
    },

    // ----- members -----
    addMember: asResult(
      'AddMemberPayload',
      async (_: unknown, { input }: { input: { workspaceId: string; email: string; role: Role } }, ctx: Context) => {
        const user = requireUser(ctx);
        const workspaceId = dbId(input.workspaceId, 'Workspace');
        const callerRole = await authorize(user.id, workspaceId, 'ADMIN', 'Workspace');
        if (input.role === 'OWNER' && callerRole !== 'OWNER') throw forbidden('Only owners can add owners');
        const target = await prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
        if (!target) throw notFound('User');
        if (await roleIn(target.id, workspaceId)) throw badInput('User is already a member', 'email');
        await prisma.membership.create({ data: { workspaceId, userId: target.id, role: input.role } });
        await recordActivity({
          workspaceId,
          actor: user,
          type: 'MEMBER_ADDED',
          summary: `${user.name} added ${target.name} to the workspace`,
          notify: [target.id],
        });
        return { member: await memberPayload(workspaceId, target.id) };
      },
    ),

    updateMemberRole: asResult(
      'UpdateMemberRolePayload',
      async (_: unknown, { input }: { input: { workspaceId: string; userId: string; role: Role } }, ctx: Context) => {
        const user = requireUser(ctx);
        const workspaceId = dbId(input.workspaceId, 'Workspace');
        const targetId = dbId(input.userId, 'User');
        const callerRole = await authorize(user.id, workspaceId, 'ADMIN', 'Workspace');
        const current = await roleIn(targetId, workspaceId);
        if (!current) throw notFound('Member');
        // Touching the OWNER role (granting it or taking it away) is owner-only.
        if ((current === 'OWNER' || input.role === 'OWNER') && callerRole !== 'OWNER') {
          throw forbidden('Only owners can grant or change the owner role');
        }
        if (current === 'OWNER' && input.role !== 'OWNER' && (await ownerCount(workspaceId)) <= 1) {
          throw badInput('A workspace must keep at least one owner', 'role');
        }
        await prisma.membership.update({
          where: { workspaceId_userId: { workspaceId, userId: targetId } },
          data: { role: input.role },
        });
        return { member: await memberPayload(workspaceId, targetId) };
      },
    ),

    removeMember: asResult(
      'RemoveMemberPayload',
      async (_: unknown, { input }: { input: { workspaceId: string; userId: string } }, ctx: Context) => {
        const user = requireUser(ctx);
        const workspaceId = dbId(input.workspaceId, 'Workspace');
        const targetId = dbId(input.userId, 'User');
        // Anyone may leave; removing someone else needs ADMIN.
        const callerRole = await authorize(user.id, workspaceId, targetId === user.id ? 'MEMBER' : 'ADMIN', 'Workspace');
        const current = await roleIn(targetId, workspaceId);
        if (!current) throw notFound('Member');
        if (current === 'OWNER' && targetId !== user.id && callerRole !== 'OWNER') {
          throw forbidden('Only owners can remove owners');
        }
        if (current === 'OWNER' && (await ownerCount(workspaceId)) <= 1) {
          throw badInput('A workspace must keep at least one owner', 'userId');
        }
        await prisma.$transaction([
          // Their assigned issues become unassigned instead of pointing at a non-member.
          prisma.issue.updateMany({
            where: { assigneeId: targetId, project: { workspaceId } },
            data: { assigneeId: null },
          }),
          prisma.membership.delete({ where: { workspaceId_userId: { workspaceId, userId: targetId } } }),
        ]);
        forgetMembership(targetId, workspaceId); // live subscriptions must notice immediately, not after the cache expires
        return { removedUserId: toGlobalId('User', targetId) };
      },
    ),

    // ----- workspace content -----
    createWorkspace: asResult(
      'CreateWorkspacePayload',
      async (_: unknown, { input }: { input: { name: string; slug: string } }, ctx: Context) => {
        const user = requireUser(ctx);
        if (!/^[a-z0-9-]{2,30}$/.test(input.slug)) throw badInput('Slug must be 2-30 chars: a-z, 0-9, -', 'slug');
        if (!input.name.trim()) throw badInput('Name is required', 'name');
        if (await prisma.workspace.findUnique({ where: { slug: input.slug } })) {
          throw badInput('Slug already taken', 'slug');
        }
        const workspace = await prisma.workspace.create({
          data: { name: input.name.trim(), slug: input.slug, members: { create: { userId: user.id, role: 'OWNER' } } },
        });
        return { workspace };
      },
    ),

    createProject: asResult(
      'CreateProjectPayload',
      async (
        _: unknown,
        { input }: { input: { workspaceId: string; name: string; key: string; description?: string | null } },
        ctx: Context,
      ) => {
        const user = requireUser(ctx);
        const workspaceId = dbId(input.workspaceId, 'Workspace');
        await authorize(user.id, workspaceId, 'ADMIN', 'Workspace');
        const key = input.key.toUpperCase();
        if (!/^[A-Z]{2,5}$/.test(key)) throw badInput('Key must be 2-5 letters', 'key');
        if (!input.name.trim()) throw badInput('Name is required', 'name');
        if (await prisma.project.findUnique({ where: { workspaceId_key: { workspaceId, key } } })) {
          throw badInput('Project key already used in this workspace', 'key');
        }
        const project = await prisma.project.create({
          data: { workspaceId, name: input.name.trim(), key, description: input.description },
        });
        return { project };
      },
    ),

    createIssue: asResult(
      'CreateIssuePayload',
      async (_: unknown, { input }: { input: CreateIssueInput }, ctx: Context) => {
        const user = requireUser(ctx);
        if (!input.title.trim()) throw badInput('Title is required', 'title');
        const projectId = dbId(input.projectId, 'Project');
        const workspaceId = await workspaceIdOf('Project', projectId);
        if (!workspaceId) throw notFound('Project');
        await authorize(user.id, workspaceId, 'MEMBER', 'Project');
        const assigneeId = input.assigneeId ? dbId(input.assigneeId, 'User') : null;
        if (assigneeId) await assertAssignable(workspaceId, assigneeId);
        const labelIds = input.labelIds?.map((l) => dbId(l, 'Label'));
        if (labelIds) await assertLabels(workspaceId, labelIds);

        const issue = await prisma.$transaction(async (tx) => {
          // Atomic per-project counter -> ENG-1, ENG-2, ...
          const project = await tx.project.update({
            where: { id: projectId },
            data: { issueCounter: { increment: 1 } },
          });
          // Append to the bottom of the target column.
          const last = await tx.issue.findFirst({
            where: { projectId, status: input.status },
            orderBy: { position: 'desc' },
          });
          return tx.issue.create({
            data: {
              projectId,
              workspaceId,
              number: project.issueCounter,
              title: input.title.trim(),
              description: input.description,
              status: input.status,
              priority: input.priority,
              position: (last?.position ?? 0) + 1024,
              reporterId: user.id,
              assigneeId,
              labels: labelIds ? { connect: labelIds.map((id) => ({ id })) } : undefined,
            },
          });
        });

        await publishIssueEvent('CREATED', issue, user, workspaceId, ctx.loaders);
        await recordActivity({
          workspaceId,
          actor: user,
          type: 'ISSUE_CREATED',
          issueId: issue.id,
          summary: `${user.name} created ${await identifierOf(ctx, issue)} "${issue.title}"`,
          notify: [assigneeId],
        });
        return { issue };
      },
    ),

    updateIssue: asResult(
      'UpdateIssuePayload',
      async (_: unknown, { input }: { input: UpdateIssueInput }, ctx: Context) => {
        const { user, id, workspaceId } = await authorizeIssue(ctx, input.id);
        const before = await prisma.issue.findUniqueOrThrow({ where: { id } });
        const assigneeId = input.assigneeId ? dbId(input.assigneeId, 'User') : input.assigneeId;
        if (assigneeId) await assertAssignable(workspaceId, assigneeId);
        const labelIds = input.labelIds?.map((l) => dbId(l, 'Label'));
        if (labelIds) await assertLabels(workspaceId, labelIds);
        if (input.title !== undefined && input.title !== null && !input.title.trim()) {
          throw badInput('Title cannot be empty', 'title');
        }
        const issue = await prisma.issue.update({
          where: { id },
          data: {
            // `undefined` = field omitted, leave unchanged; explicit `null` on assigneeId = unassign.
            title: input.title?.trim() ?? undefined,
            description: input.description,
            priority: input.priority ?? undefined,
            assigneeId,
            labels: labelIds ? { set: labelIds.map((l) => ({ id: l })) } : undefined,
          },
        });

        await publishIssueEvent('UPDATED', issue, user, workspaceId, ctx.loaders);
        const ident = await identifierOf(ctx, issue);
        const assigneeChanged = assigneeId !== undefined && assigneeId !== before.assigneeId;
        const changed =
          assigneeChanged ||
          (input.priority != null && input.priority !== before.priority) ||
          (input.title != null && input.title.trim() !== before.title) ||
          (input.description !== undefined && input.description !== before.description) ||
          labelIds !== undefined;
        if (changed) {
          let summary = `${user.name} updated ${ident}`;
          if (assigneeChanged) {
            const to = assigneeId ? await ctx.loaders.user.load(assigneeId) : null;
            summary = to ? `${user.name} assigned ${ident} to ${to.name}` : `${user.name} unassigned ${ident}`;
          } else if (input.priority != null && input.priority !== before.priority) {
            summary = `${user.name} set ${ident} priority to ${input.priority}`;
          }
          await recordActivity({
            workspaceId,
            actor: user,
            type: 'ISSUE_UPDATED',
            issueId: issue.id,
            summary,
            notify: assigneeChanged ? [assigneeId] : [before.assigneeId, before.reporterId],
          });
        }
        return { issue };
      },
    ),

    moveIssue: asResult(
      'MoveIssuePayload',
      async (
        _: unknown,
        { input }: { input: { id: string; status: IssueStatus; position: number } },
        ctx: Context,
      ) => {
        const { user, id, workspaceId } = await authorizeIssue(ctx, input.id);
        if (!Number.isFinite(input.position)) throw badInput('position must be a finite number', 'position');
        const before = await prisma.issue.findUniqueOrThrow({ where: { id } });
        const issue = await prisma.issue.update({
          where: { id },
          data: { status: input.status, position: input.position },
        });
        await publishIssueEvent('MOVED', issue, user, workspaceId, ctx.loaders); // every move is live, even within a column
        if (before.status !== issue.status) {
          // ...but only column changes are worth a line in the feed
          await recordActivity({
            workspaceId,
            actor: user,
            type: 'ISSUE_MOVED',
            issueId: issue.id,
            summary: `${user.name} moved ${await identifierOf(ctx, issue)} to ${STATUS_LABEL[issue.status]}`,
            notify: [issue.assigneeId, issue.reporterId],
          });
        }
        return { issue };
      },
    ),

    addComment: asResult(
      'AddCommentPayload',
      async (_: unknown, { input }: { input: { issueId: string; body: string } }, ctx: Context) => {
        const { user, id: issueId, workspaceId } = await authorizeIssue(ctx, input.issueId);
        if (!input.body.trim()) throw badInput('Comment cannot be empty', 'body');
        const comment = await prisma.comment.create({
          data: { issueId, authorId: user.id, body: input.body.trim() },
        });
        const issue = await prisma.issue.findUniqueOrThrow({ where: { id: issueId } });
        void pubsub.publish(TOPIC.comment, { commentAdded: comment, issueId, workspaceId });
        await recordActivity({
          workspaceId,
          actor: user,
          type: 'COMMENT_ADDED',
          issueId,
          summary: `${user.name} commented on ${await identifierOf(ctx, issue)}`,
          notify: [issue.assigneeId, issue.reporterId],
        });
        return { comment };
      },
    ),

    createLabel: asResult(
      'CreateLabelPayload',
      async (
        _: unknown,
        { input }: { input: { workspaceId: string; name: string; color?: string | null } },
        ctx: Context,
      ) => {
        const user = requireUser(ctx);
        const workspaceId = dbId(input.workspaceId, 'Workspace');
        await authorize(user.id, workspaceId, 'ADMIN', 'Workspace');
        if (!input.name.trim()) throw badInput('Name is required', 'name');
        if (await prisma.label.findUnique({ where: { workspaceId_name: { workspaceId, name: input.name.trim() } } })) {
          throw badInput('Label already exists', 'name');
        }
        const label = await prisma.label.create({
          data: { workspaceId, name: input.name.trim(), color: input.color ?? undefined },
        });
        return { label };
      },
    ),

    markNotificationsRead: async (_: unknown, { input }: { input: { ids?: string[] | null } }, ctx: Context) => {
      const user = requireUser(ctx);
      const ids = input.ids?.map((i) => dbId(i, 'Notification'));
      await prisma.notification.updateMany({
        // userId in the filter means you can never mark (or probe) someone else's notifications
        where: { userId: user.id, readAt: null, ...(ids && { id: { in: ids } }) },
        data: { readAt: new Date() },
      });
      return { unreadCount: await unreadCount(user.id) };
    },
  },
};
