# 独立业务仓库使用已发布的 @yss123/cage-* 依赖；先提交 pnpm-lock.yaml。
# --framework-path 创建的 link: 本地依赖只用于源码开发，不能拷贝进独立镜像。
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build:app
RUN pnpm --filter @app/api deploy --prod --legacy /out/api

# 发布过程先单独运行此 target，迁移账号只注入迁移任务。
FROM build AS migration
CMD ["pnpm", "cage", "migrate"]

# API 与 worker 共用运行时镜像，通过启动命令区分职责。
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /app/apps/web/dist /app/web
ENV NODE_ENV=production PORT=3000 WEB_DIR=/app/web
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
# worker 启动命令：node dist/worker.js
