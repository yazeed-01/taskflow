# One image: the API and the built React app, served from the same origin (no CORS, one deploy unit).
#   docker build -t taskflow .
#   docker run -p 4000:4000 -e JWT_SECRET=$(openssl rand -hex 32) -v taskflow-data:/data taskflow

# ---- 1. build the client ----
FROM node:22-slim AS client
WORKDIR /app
# codegen reads the server's schema (../server/src/schema.graphql relative to client/)
COPY server/src/schema.graphql server/src/schema.graphql
COPY client/package.json client/package-lock.json client/
RUN cd client && npm ci
COPY client client
RUN cd client && npm run build

# ---- 2. run the API ----
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server ./
RUN npx prisma generate
COPY --from=client /app/client/dist /app/client-dist

ENV NODE_ENV=production \
    PORT=4000 \
    CLIENT_DIR=/app/client-dist \
    DATABASE_URL=file:/data/taskflow.db \
    TRUST_PROXY=true
# SQLite lives on a volume so it survives restarts. For several instances use Postgres + a shared pub/sub.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4000
USER node
# JWT_SECRET is deliberately NOT set here: the server refuses to start without it.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node --import tsx src/index.ts"]
