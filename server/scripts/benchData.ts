// Shared by the benchmark and the pagination tests. Creates a 'bench' workspace with 50 issues (dev DB only).
import { prisma } from '../src/db.js';

export const N = 50;

export async function ensureBenchData() {
  if (await prisma.workspace.findUnique({ where: { slug: 'bench' } })) return;
  const ada = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@taskflow.dev' } });
  const users = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      prisma.user.upsert({
        where: { email: `bench${i}@example.com` },
        update: {},
        create: { email: `bench${i}@example.com`, name: `Bench User ${i}`, passwordHash: 'x' },
      }),
    ),
  );
  const ws = await prisma.workspace.create({
    data: {
      name: 'Bench',
      slug: 'bench',
      members: { create: [{ userId: ada.id, role: 'OWNER' }, ...users.map((u) => ({ userId: u.id, role: 'MEMBER' as const }))] },
    },
  });
  const labels = await Promise.all(
    ['bug', 'feature', 'chore', 'docs'].map((name) => prisma.label.create({ data: { workspaceId: ws.id, name } })),
  );
  const project = await prisma.project.create({
    data: { workspaceId: ws.id, name: 'Bench', key: 'BNCH', issueCounter: N },
  });
  const statuses = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE'] as const;
  for (let i = 1; i <= N; i++) {
    await prisma.issue.create({
      data: {
        projectId: project.id,
        workspaceId: ws.id,
        number: i,
        title: `Bench issue ${i}${i % 7 === 0 ? ' login bug' : ''}`,
        status: statuses[i % 4],
        position: i * 1024,
        reporterId: users[i % 10].id,
        assigneeId: users[(i * 3) % 10].id,
        labels: { connect: [{ id: labels[i % 4].id }, { id: labels[(i + 1) % 4].id }] },
        comments: {
          create: [
            { authorId: users[(i + 1) % 10].id, body: 'First!' },
            { authorId: users[(i + 2) % 10].id, body: 'Looking into it' },
          ],
        },
      },
    });
  }
  console.log(`Created bench workspace with ${N} issues`);
}

