# syntax=docker/dockerfile:1.6
# ──────────────────────────────────────────────────────────────────────
# Stage 1: build
# Compiles TypeScript → dist/ and generates the Prisma client.
# Uses devDependencies so tsc + tsx (for seed scripts) are available.
# ──────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Prisma needs openssl + libc6-compat even at build time
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Install ALL dependencies (incl. dev) for the build
COPY package.json package-lock.json ./
RUN npm ci

# Copy source — note: prisma/ must come BEFORE prisma generate
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

# Generate Prisma client (writes node_modules/.prisma/client/)
RUN npx prisma generate

# Build TypeScript → dist/
RUN npm run build

# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime
# Ships dist/, production node_modules, prisma/ folder, and the prisma
# CLI binary for in-container `prisma migrate deploy`.
# ──────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Runtime Prisma deps
RUN apk add --no-cache openssl libc6-compat tini

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and Prisma artifacts from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Create uploads dir owned by node user — defensive fallback in case
# AZURE_STORAGE_ACCOUNT_NAME isn't set at runtime (e.g. local docker run
# without env vars). Code path is gated by env var check in src/index.ts
# so this dir stays empty in normal production deploys.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# Drop privileges — node user (UID 1000) exists in node:alpine
USER node

# Backend reads process.env.PORT || 3001
ENV PORT=3001
EXPOSE 3001

# tini for proper signal handling (PID 1) — important so SIGTERM from
# Container Apps gracefully stops the process
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
