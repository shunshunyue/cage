# 同一份镜像启动 API 或 worker；迁移使用独立 migration target。
# 当前是源码 monorepo 构建，不需要先将 @cage/* 发布到 npm。
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /cage
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
RUN pnpm --filter @app/api deploy --prod --legacy /out/api

FROM build AS migration
WORKDIR /cage/examples/purchase-admin
CMD ["node", "../../packages/cli/bin/cage.js", "migrate"]

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /cage/examples/purchase-admin/apps/web/dist /app/web
ENV NODE_ENV=production PORT=3000 WEB_DIR=/app/web
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
# worker: docker run ... <image> node dist/worker.js
