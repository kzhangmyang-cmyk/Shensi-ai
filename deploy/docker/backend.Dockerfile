FROM node:22.22.3-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile
COPY backend backend
COPY contracts contracts
COPY frontend/src/generated/ai-acquisition.ts frontend/src/generated/ai-acquisition.ts
COPY frontend/src/generated/decision-simulation.ts frontend/src/generated/decision-simulation.ts
COPY frontend/src/generated/platform-admin.ts frontend/src/generated/platform-admin.ts
COPY desktop/src/generated/ai-acquisition.d.ts desktop/src/generated/ai-acquisition.d.ts
RUN pnpm --filter ./contracts check:types && pnpm --filter ./backend build

FROM node:22.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production CRM_STORE=mysql
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/contracts ./contracts
USER node
EXPOSE 4188
CMD ["node", "backend/dist/server.js"]
