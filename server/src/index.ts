import { createApp } from './app.js';
import { prisma } from './db.js';
import { ensureSearchIndex } from './search.js';

const port = Number(process.env.PORT ?? 4000);

// WAL lets readers and the writer run at the same time (the default rollback journal makes them block each other).
// Standard practice for SQLite under concurrent load; its isolated effect was not measured here. Stored in the DB file.
await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
await ensureSearchIndex(); // no-op when it exists; builds it for a fresh database
const { httpServer, close } = await createApp();

httpServer.listen(port, () => {
  console.log(`TaskFlow API ready at http://localhost:${port}/graphql (WebSocket subscriptions on the same path)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void close().finally(() => process.exit(0)));
}
