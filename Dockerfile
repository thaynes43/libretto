# --- Build stage: install deps, compile TypeScript, prune to production deps.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

# --- Runtime stage: non-root, single volume at /config.
FROM node:22-alpine
ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /config && chown node:node /config
USER node
VOLUME /config
EXPOSE 8080
CMD ["node", "dist/index.js"]
