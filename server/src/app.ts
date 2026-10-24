import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { buildContext, buildContextFromHeader } from './context.js';
import { schema } from './schema.js';
import { createServer } from './server.js';
import { admissionControl } from './overload.js';

export async function createApp() {
  const app = express();
  const httpServer = http.createServer(app);
  const apollo = createServer({ plugins: [ApolloServerPluginDrainHttpServer({ httpServer })] });
  await apollo.start();

  // Subscriptions: same path, upgraded to a WebSocket (graphql-ws protocol).
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql', maxPayload: 64 * 1024 });
  const wsCleanup = useServer(
    {
      schema,
      // Browsers can't set headers on a WebSocket, so the token travels in connectionParams.
      context: (ctx) => buildContextFromHeader(ctx.connectionParams?.authorization as string | undefined),
    },
    wsServer,
  );

  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

  const admission = admissionControl();
  // Liveness plus load figures: lets a load balancer or a human see saturation (queued/rejected) without a profiler.
  app.get('/healthz', (_req, res) => void res.json({ ok: true, ...admission.stats() }));

  const origins = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    '/graphql',
    // Coarse per-IP flood protection. Login brute-forcing has its own, stricter limiter (ratelimit.ts).
    rateLimit({
      windowMs: 60_000,
      limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 600),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { errors: [{ message: 'Too many requests', extensions: { code: 'RATE_LIMITED' } }] },
    }),
    admission, // before body parsing: a request that will be refused shouldn't cost us a JSON.parse first
    cors({ origin: origins?.length ? origins : false }), // same-origin by default; opt in to cross-origin
    express.json({ limit: '100kb' }),
    expressMiddleware(apollo, { context: async ({ req }) => buildContext(req) }),
  );

  // Production: serve the built React app from the same origin (no CORS, one deploy unit).
  const clientDir = process.env.CLIENT_DIR && path.resolve(process.env.CLIENT_DIR);
  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => void res.sendFile(path.join(clientDir, 'index.html')));
  }

  const close = async () => {
    await wsCleanup.dispose();
    await apollo.stop();
  };
  return { app, httpServer, close };
}
