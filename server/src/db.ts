import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

// Counts every SQL statement Prisma sends. Used by the benchmark and the batching test
// to prove how many DB round-trips a GraphQL operation costs.
export const queryStats = { count: 0 };
prisma.$on('query', () => {
  queryStats.count++;
});
