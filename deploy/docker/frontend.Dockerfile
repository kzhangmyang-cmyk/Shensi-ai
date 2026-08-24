FROM node:22.22.3-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile
COPY frontend frontend
COPY contracts contracts
RUN pnpm --filter ./frontend build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
