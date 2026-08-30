# AI Delivery Control Plane

这是一个以后端系统设计为核心的 AI 软件交付控制面。M0 已完成，当前正在完成 **M1：身份安全、分布式作业内核与 Review Harness** 的真实环境验收；M2 设计协作和 M3 交付闭环尚未开始。

## 当前状态

- Vue 3 最小管理台，覆盖公开注册、邮箱验证、登录、组织/设备、平台用户管理、项目与 Review；
- ExpressJS 模块化单体 Control Plane API，使用 PostgreSQL RLS、显式 Migration 和稳定 Schema；
- JWT Access/Refresh 双 Token、旋转会话、项目 Token、Secret 信封加密、平台/租户分层 RBAC 与审计；
- 独立 Worker，使用 Transactional Outbox、RabbitMQ、Consumer Inbox、Lease、Heartbeat 和 Fencing Token 执行可恢复 Review DAG；
- 不可变 Ruleset、冻结 GitHub Diff、确定性规则、模型 Provider Port、Verify 门禁、MinIO Artifact 血缘和 GitHub External Effect Ledger；
- Sandbox Runner 仍只有 M0 安全边界和 Docker 探测，M1 不执行目标仓库代码；
- PostgreSQL、RabbitMQ、MinIO、OpenTelemetry Collector、Jaeger 本地基础设施；
- Design 与 Delivery 能力继续明确返回 `501 FEATURE_NOT_IMPLEMENTED`，不会伪装为已完成。

M1 的 L2 自动化门禁、本地多进程/基础设施故障演练和完整 Review 容量基线已通过。真实 GitHub App、DeepSeek、浏览器完整身份路径和本仓库 Dogfooding 仍是未完成的 L3 边界，详见 [TODO.md](./TODO.md)。

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
pnpm quality
```

`pnpm test:integration` 只有在 `.env` 中设置 `RUN_INFRA_INTEGRATION=true` 且基础设施已启动时才运行真实依赖探测；CI 未启动基础设施时会明确跳过该组测试。

## M1 故障演练

确保没有其他 Review Worker 消费本地队列后运行：

```bash
pnpm drill:worker-reliability
```

Harness 默认连续执行两轮。每轮创建并迁移受保护命名的临时数据库，对测试 Worker 执行 `SIGKILL`，验证 Lease/Fencing 接管，重启本项目 RabbitMQ 容器，制造并安全重放真实 DLQ 消息，最后核对唯一外部副作用、固定 Artifact 和空队列并删除临时数据。脱敏结果写入被 Git 忽略的 `.workspace/proofs/`；检测到其他消费者、遗留消息或非本项目 RabbitMQ 容器名时会拒绝运行。

## M1 容量基线

确保没有其他 Review Worker 消费本地队列后运行：

```bash
pnpm benchmark:review-capacity
```

Harness 默认在受保护的一次性数据库中创建 100 个活跃 Run，启动 8 个真实 Worker 进程，通过本机 RabbitMQ 与 MinIO 跑完整 Review DAG。GitHub 和模型 Provider 使用带固定延迟与 Token 用量的受控 Stub，因此结果用于验证队列背压、数据库容量租约、任务吞吐、Artifact 和 External Effect，不代表真实供应商性能或账单。报告会记录 Task/Provider 排队延迟、队列峰值、并发上限、Token 成本推演和最终收敛状态，并写入被忽略的 `.workspace/proofs/`。

完整规划见 [TODO.md](./TODO.md)，工程原则见 [AGENTS.md](./AGENTS.md)。
