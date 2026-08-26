# AI Delivery Control Plane

这是一个以后端系统设计为核心的 AI 软件交付控制面。当前里程碑为 **M0：架构与工程骨架**，业务能力尚未实现。

## 当前状态

- Vue 3 Web 框架；
- ExpressJS Control Plane API；
- Worker 健康与依赖探测进程；
- Sandbox Runner 健康与 Docker 探测进程；
- PostgreSQL、RabbitMQ、MinIO、OpenTelemetry Collector、Jaeger 本地基础设施；
- Identity、Project、Artifact、Workflow、Review、Design、Delivery、Integration、Audit 只提供 `501 FEATURE_NOT_IMPLEMENTED` 边界。

M1 的用户、Token、Secret、数据库业务表和 Review Harness 尚未开始。

## 环境要求

- Node.js 24 或更高；
- pnpm 10.33.2；
- Docker Desktop / Docker Engine 与 Compose。

## 启动

```bash
cp .env.example .env
pnpm install
pnpm dev
```

也可以只启动基础设施，再按需分别启动进程：

```bash
pnpm infra:up
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm dev:sandbox
```

停止本地基础设施：

```bash
pnpm infra:down
```

入口：

- Web：`http://127.0.0.1:5173`
- API liveness：`http://127.0.0.1:3000/health/live`
- API readiness：`http://127.0.0.1:3000/health/ready`
- OpenAPI：`http://127.0.0.1:3000/api/v1/openapi.json`
- RabbitMQ：`http://127.0.0.1:15672`
- MinIO：`http://127.0.0.1:9001`
- Jaeger：`http://127.0.0.1:16686`

## 质量门禁

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm check:architecture
pnpm check:dead-code
pnpm check:duplication
pnpm build
```

`pnpm test:integration` 只有在 `.env` 中设置 `RUN_INFRA_INTEGRATION=true` 且基础设施已启动时才运行真实依赖探测；CI 未启动基础设施时会明确跳过该组测试。

完整规划见 [TODO.md](./TODO.md)，工程原则见 [AGENTS.md](./AGENTS.md)。
