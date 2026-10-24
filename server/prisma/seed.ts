import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Dev-only seed password for all three users.
const passwordHash = await bcrypt.hash('password123', 10);

const [ada, grace, linus] = await Promise.all(
  [
    ['ada@taskflow.dev', 'Ada Lovelace'],
    ['grace@taskflow.dev', 'Grace Hopper'],
    ['linus@taskflow.dev', 'Linus Torvalds'],
  ].map(([email, name]) =>
    prisma.user.upsert({ where: { email }, update: {}, create: { email, name, passwordHash } }),
  ),
);

const ws = await prisma.workspace.upsert({
  where: { slug: 'acme' },
  update: {},
  create: {
    name: 'Acme Inc',
    slug: 'acme',
    members: {
      create: [
        { userId: ada.id, role: 'OWNER' },
        { userId: grace.id, role: 'ADMIN' },
        { userId: linus.id, role: 'MEMBER' },
      ],
    },
  },
});

const bug = await prisma.label.upsert({
  where: { workspaceId_name: { workspaceId: ws.id, name: 'bug' } },
  update: {},
  create: { workspaceId: ws.id, name: 'bug', color: '#ef4444' },
});
await prisma.label.upsert({
  where: { workspaceId_name: { workspaceId: ws.id, name: 'feature' } },
  update: {},
  create: { workspaceId: ws.id, name: 'feature', color: '#3b82f6' },
});

const project = await prisma.project.upsert({
  where: { workspaceId_key: { workspaceId: ws.id, key: 'ENG' } },
  update: {},
  create: { workspaceId: ws.id, key: 'ENG', name: 'Engineering', description: 'Core product work' },
});

if ((await prisma.issue.count({ where: { projectId: project.id } })) === 0) {
  const seeds = [
    ['Set up CI pipeline', 'TODO', 'HIGH', grace.id],
    ['Login page crashes on Safari', 'IN_PROGRESS', 'URGENT', linus.id],
    ['Design kanban board', 'IN_PROGRESS', 'MEDIUM', ada.id],
    ['Write onboarding docs', 'BACKLOG', 'LOW', null],
    ['Ship v0.1', 'DONE', 'MEDIUM', ada.id],
  ] as const;
  for (const [i, [title, status, priority, assigneeId]] of seeds.entries()) {
    await prisma.issue.create({
      data: {
        projectId: project.id,
        workspaceId: ws.id,
        number: i + 1,
        title,
        status,
        priority,
        position: (i + 1) * 1024,
        reporterId: ada.id,
        assigneeId,
        labels: title.includes('crash') ? { connect: { id: bug.id } } : undefined,
      },
    });
  }
  await prisma.project.update({ where: { id: project.id }, data: { issueCounter: seeds.length } });
}

console.log('Seeded. Log in with ada@taskflow.dev (OWNER), grace@taskflow.dev (ADMIN), linus@taskflow.dev (MEMBER).');
console.log('Dev password for all three: password123');
await prisma.$disconnect();
