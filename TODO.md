# AI Delivery Control Plane 总体 TODO

> 状态：M0 已完成并通过退出门槛。M1、M2、M3 尚未开始，开始 M1 前仍需用户明确批准。

## 0. 项目目标与阶段顺序

- [x] M0：架构基线与工程骨架——建立可运行、可验证的框架，未实现模块明确返回 `501 FEATURE_NOT_IMPLEMENTED`。
- [ ] M1：账户、数据库、安全与代码审查——先完成一条可故障注入、可追踪、可对账的可靠 CR 链路。
- [ ] M2：设计稿与 HTML 协作——完成需求/Figma/HTML、批注、Agent Patch、版本冲突、预览和审批。
- [ ] M3：研发与最终交付闭环——完成文档裁切、Workspace、代码生成、验证、审查、Proof Bundle、Engineering Gate 和 PR。

阶段顺序固定为 `M0 → M1 → M2 → M3`。下一阶段必须在上一阶段退出门槛通过并完成架构 Review 后开始。

## 1. 已确认技术基线

### 1.1 前端

- [x] 使用 Vue 3 + TypeScript + Vite。
- [x] 使用 Composition API；新代码不使用 Options API。
- [x] 使用 Vue Router 管理页面路由。
- [x] 仅将真正跨页面、跨功能的客户端状态放入 Pinia；服务端状态优先由 API Query 层管理，禁止把所有状态塞入全局 Store。
- [x] 根据 OpenAPI/Schema 生成或共享类型安全的 API Client，禁止手写两份相互漂移的请求类型。
- [x] 建立统一的错误展示、权限态、加载态、空态和异步 Run 状态组件。

### 1.2 后端

- [x] 使用 ExpressJS + TypeScript。
- [x] Express 仅作为 HTTP Adapter；Route Handler 保持轻薄。
- [x] 采用模块化单体 Control Plane，依赖方向为 `interface/adapters → application → domain`。
- [x] 通过 Composition Root 显式创建和注入 Repository、Provider、Clock、ID Generator、Message Publisher 等依赖。
- [x] 系统边界使用运行时 Schema 校验 API、消息、Artifact 和领域事件。
- [x] 统一错误模型、错误码、请求 ID、Trace ID、结构化日志和错误中间件。

### 1.3 首期基础设施

- [x] PostgreSQL：业务状态权威事实源。
- [x] RabbitMQ：异步任务的至少一次投递。
- [x] S3/MinIO：保存不可变大型 Artifact。
- [x] OpenTelemetry：Trace、Metrics 和日志关联。
- [ ] Rootless Docker：首期 Sandbox 执行边界。
- [x] Redis 暂不引入；等出现明确缓存、Fan-out、限流或 Presence 问题后单独立项。
- [x] Kafka、Temporal、Kubernetes、Elasticsearch、Service Mesh、Firecracker 暂不引入。

## 2. 开发前必须冻结的架构决策

- [x] ADR-001：以 `DeliveryRun` 而非 Conversation 作为系统核心运行抽象。
- [x] ADR-002：采用模块化单体 Control Plane，Worker 与 Sandbox Runner 独立进程/部署。
- [x] ADR-003：PostgreSQL + Transactional Outbox + RabbitMQ + Inbox/Dedup，语义为 at-least-once。
- [x] ADR-004：记录 PostgreSQL Queue 作为替代方案，并规划后续 A/B 实验。
- [x] ADR-005：Artifact/ArtifactVersion 不可变、内容寻址和版本血缘。
- [x] ADR-006：入站 API Token 只存 Hash；可恢复第三方 Secret 使用信封加密。
- [x] ADR-007：Control Plane 与 Execution Plane 的信任边界。
- [x] ADR-008：HTML 只作为 Design Domain 的权威事实，不是全局唯一事实。
- [x] ADR-009：ExternalEffect 作为 GitHub/Figma/Preview 等外部副作用账本。
- [x] ADR-010：Redis 延后，缓存必须绑定不可变版本引用。
- [x] ADR-011：代码生成 → 确定性验证 → 代码审查 → Engineering Gate → PR。
- [x] ADR-012：代码质量门禁、架构依赖规则、覆盖率基线与 Dogfooding 策略。

## 3. 领域事实与不可变契约

### 3.1 各领域权威事实

- [x] 设计事实：`DesignArtifactVersion + content_hash`。
- [x] 研发事实：`base_commit_sha + patch/commit_sha`。
- [x] 审查事实：`head_sha + diff_hash + ruleset_version`。
- [x] 验证事实：绑定精确 Commit/Artifact 的 `Evidence`。
- [x] 外部交付事实：`ExternalEffect + provider_object_id`。
- [x] Run 开始时冻结所有输入；执行途中禁止隐式读取 `latest`。

### 3.2 核心运行模型

- [x] `Run` 表示一次业务运行。
- [x] `Task` 表示一项逻辑工作。
- [x] `Attempt` 表示某个 Worker 对 Task 的一次物理执行。
- [x] Task 重试必须创建新 Attempt，不得覆盖历史 Attempt。
- [x] Attempt 保存 `worker_id`、Lease、Heartbeat、Fencing Token、错误和输出 Artifact 引用。
- [x] 所有状态变化通过领域状态机完成，并同时产生审计记录。

### 3.3 状态机

- [x] Run：`DRAFT → QUEUED → RUNNING → WAITING_APPROVAL → SUCCEEDED`。
- [x] Run 异常态：`FAILED`、`CANCEL_REQUESTED`、`CANCELLED`、`STALE`、`REJECTED`。
- [x] Task：`BLOCKED → READY → RUNNING → SUCCEEDED`。
- [x] Task 异常态：`WAITING_RETRY`、`FAILED`、`CANCELLED`、`STALE`。
- [x] Attempt：`CREATED → LEASED → RUNNING → SUCCEEDED`。
- [x] Attempt 异常态：`FAILED`、`TIMED_OUT`、`LEASE_EXPIRED`、`ABANDONED`。
- [x] 为每个允许的转换定义前置条件、操作者、原因、领域事件和乐观锁行为。

## 4. 目标仓库结构

```text
apps/
  api/                    ExpressJS Control Plane API
  web/                    Vue 3 产品界面
  worker/                 Review、Agent、Integration Worker
  sandbox-runner/         不可信代码和 HTML 的隔离执行

packages/
  domain/                 纯领域对象、状态机、错误
  contracts/              API、消息、Artifact Schema
  health/                 进程健康模型与依赖探测编排
  database/               Migration、Repository、事务工具
  messaging/              Outbox、Inbox、RabbitMQ Adapter
  object-storage/         S3/MinIO Adapter 与 Readiness
  security/               Token、Secret、RBAC、加密
  observability/          OTel、日志、指标
  providers-github/       GitHub Provider Adapter
  providers-agent/        Agent/LLM Provider Contract
  testkit/                Fixture、容器集成测试、故障注入

docs/
  architecture/
  adr/
  api/
  threat-model/
  runbooks/

infra/
  compose/
  otel/
  rabbitmq/
  minio/
```

## 5. M0：架构基线与工程骨架

### M0.1 仓库与工具链

- [x] 初始化 pnpm workspace，不创建与当前阶段无关的业务实现。
- [x] 创建 `apps/api`、`apps/web`、`apps/worker`、`apps/sandbox-runner` 和必要 packages 空壳。
- [x] 建立统一的 `format`、`lint`、`typecheck`、`test`、`test:integration`、`build`、`check:architecture` 脚本。
- [x] TypeScript 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`useUnknownInCatchVariables`、`noImplicitOverride`。
- [x] 建立 ESLint 类型感知规则、格式检查、禁止循环依赖和模块边界检查。
- [x] 建立测试框架和覆盖率配置：全局 lines/statements/functions ≥ 85%，branches ≥ 80%；核心领域 branches ≥ 90%。
- [x] 创建 `.env.example`，只包含变量名和安全说明，不包含可用 Secret。
- [x] 创建 `.gitignore`，排除数据库、日志、覆盖率、构建产物、工作树和本地 Secret。
- [x] 建立 CI 骨架，但未实现的集成测试必须明确跳过原因，禁止伪通过。

验收：

- [x] 全新 Checkout 可以安装依赖并运行全部基础脚本。
- [x] 架构检查能识别示例循环依赖和非法跨层引用，测试结束后删除故障 Fixture。
- [x] Git 仓库不包含构建产物、Token、数据库文件或本地配置。

### M0.2 ExpressJS API 骨架

- [x] 创建 Composition Root 和 App Factory，测试可以在不监听端口的情况下实例化应用。
- [x] 建立请求 ID、Trace、结构化日志、Body Size Limit、安全 Header、错误处理中间件。
- [x] 建立 `/health/live` 和 `/health/ready`。
- [x] 建立 `/api/v1` 版本前缀和统一响应/错误约定。
- [x] 建立运行时请求/响应 Schema 和 OpenAPI 生成入口。
- [x] 为 Identity、Project、Artifact、Workflow、Review、Design、Delivery、Integration、Audit 建立模块注册点。
- [x] 未实现路由返回 `501 FEATURE_NOT_IMPLEMENTED`，包含 capability、plannedPhase 和 traceId。
- [x] 禁止返回假 Run、假 Artifact 或假 Provider 成功结果。

### M0.3 Vue 3 Web 骨架

- [x] 创建 Vue 3 + Vite + TypeScript 应用。
- [x] 建立 Vue Router、API Client、权限守卫和基础布局。
- [x] 建立统一错误页、404、501 能力占位页和服务不可用状态。
- [x] 建立 Run 状态、错误模型和 Trace ID 的展示约定。
- [x] 不提前制作 M2/M3 的完整视觉页面。

### M0.4 本地基础设施

- [x] Docker Compose 启动 PostgreSQL、RabbitMQ、MinIO、OTel Collector 和 Trace Backend。
- [x] Readiness 分别验证关键依赖，而不是只检查进程存在。
- [x] 配置失败时 fail-fast，错误不得泄露凭据。
- [x] API、Worker、Sandbox Runner 传播统一 Trace Context。

### M0.5 架构文档

- [x] `docs/architecture/system-context.md`。
- [x] `docs/architecture/container-view.md`。
- [x] `docs/architecture/domain-model.md`。
- [x] `docs/architecture/database-erd.md`。
- [x] `docs/architecture/run-state-machine.md`。
- [x] `docs/architecture/event-catalog.md`。
- [x] `docs/architecture/artifact-lineage.md`。
- [x] `docs/threat-model/security-boundaries.md`。
- [x] `docs/api/api-conventions.md`。
- [x] `docs/runbooks/worker-recovery.md`。
- [x] `docs/runbooks/secret-rotation.md`。
- [x] `docs/runbooks/external-effect-reconciliation.md`。

### M0 退出门槛

- [x] 一条命令可启动本地环境。
- [x] 四个应用/进程骨架均可 Build；API、Worker、Sandbox Runner 均提供与运行方式匹配的健康检查。
- [x] PostgreSQL、RabbitMQ 或 MinIO 不可用时 Readiness 正确失败。
- [x] HTTP 请求具有 request_id 和 trace_id。
- [x] 所有未实现能力稳定返回 501，不伪装成已完成。
- [x] 文档、目录、模块注册和依赖规则一致。
- [x] 全部质量门禁通过并完成一次人工架构 Review。

## 6. M1：账户、数据库、安全与代码审查

### M1.1 数据库基础

- [ ] 建立可审计、只向前演进的 Migration 流程。
- [ ] 创建 `users`、`user_password_credentials`、`sessions`。
- [ ] 创建 `organizations`、`organization_members`、`projects`、`project_members`。
- [ ] 创建 `api_tokens`、`encrypted_secrets`、`secret_rotation_events`。
- [ ] 创建 `audit_events`。
- [ ] 所有租户数据包含明确的 Organization/Project 归属。
- [ ] 建立邮箱规范化唯一约束、Membership 唯一约束、外键和必要 Check Constraint。

### M1.2 Identity、RBAC、Token 与 Secret

- [ ] 密码使用 Argon2id，禁止可逆加密密码。
- [ ] Session Refresh Token 只存 Hash。
- [ ] GitHub Action Access Token 使用高熵随机值，创建时只显示一次。
- [ ] Access Token 数据库只存 public token ID/prefix、Hash、Scope、Project、过期和撤销信息。
- [ ] 首期 Scope：`review:trigger`、`review:read`、`project:read`、`artifact:read`。
- [ ] 第三方可恢复 Secret 使用 AES-256-GCM 信封加密，记录 nonce、AAD 和 key_version。
- [ ] KEK 不进入数据库和仓库；支持密钥轮换。
- [ ] 日志、Trace、消息和错误响应统一 Secret Redaction。
- [ ] 为 GitHub OIDC 保留 Provider 接口，但不阻塞首期 Token 方案。

### M1.3 可靠接入与消息基础

- [ ] 创建 `webhook_inbox`、`idempotency_records`、`outbox_events`、`consumer_inbox`。
- [ ] `(provider, delivery_id)` 唯一。
- [ ] 业务状态和 Outbox Event 在同一数据库事务提交。
- [ ] Outbox Relay 支持重试、锁、并发发布和可观测延迟。
- [ ] Consumer 在副作用前后正确处理 Inbox、ACK/NACK 和重复投递。
- [ ] 建立 DLQ 和人工重放 Runbook；重放不得绕过幂等。

### M1.4 Workflow Core

- [ ] 创建 `runs`、`run_input_snapshots`、`tasks`、`task_dependencies`、`attempts`。
- [ ] 实现状态机和乐观锁。
- [ ] 实现 Lease、Heartbeat、Timeout、Cancel、Retry 和 Fencing Token。
- [ ] 同一 Task 同时最多有一个有效 Lease。
- [ ] 旧 Attempt 不能覆盖新 Attempt 结果。
- [ ] Run 输入一旦 QUEUED 即不可修改。

### M1.5 Artifact 与 Evidence

- [ ] 创建 `artifacts`、`artifact_versions`、`evidence`。
- [ ] Artifact Blob 写入 MinIO/S3；数据库只保存元数据、小型结构化索引和哈希。
- [ ] ArtifactVersion 不可覆盖，使用 parent_version_id 表达血缘。
- [ ] 校验对象存储内容哈希和数据库记录一致。

### M1.6 Review Domain

- [ ] 创建 `repositories`、`repository_connections`。
- [ ] 创建 `rulesets`、`ruleset_versions`；已发布版本不可修改。
- [ ] 创建 `review_runs`、`review_batches`、`review_findings`、`finding_verifications`。
- [ ] GitHub Action 入口：`POST /api/v1/projects/{projectId}/reviews`。
- [ ] GitHub Webhook 入口：`POST /api/v1/integrations/github/webhooks`。
- [ ] 两种入口归一化为相同 ReviewRequest 和 Run Input Snapshot。
- [ ] 冻结 repository、base_sha、head_sha、diff_hash、ruleset_version 和触发者。

### M1.7 Review Harness

- [ ] Git Diff 范围识别和解析。
- [ ] Token/大小预算和安全裁切。
- [ ] 依赖感知分批。
- [ ] Design、Implementation、Defect 三类审查能力接口。
- [ ] Rules Mapping。
- [ ] 确定性规则先于 LLM 结论。
- [ ] Verify 对 Finding 去重、过滤、重排并标记争议。
- [ ] 结构化 Finding 包含 rule_id、severity、confidence、file、line、message、evidence、fingerprint 和 verification_status。
- [ ] 生成 JSON、摘要和 HTML Review Artifact；输出必须绑定精确 head_sha 和 ruleset_version。

### M1.8 ExternalEffect 与 GitHub 发布

- [ ] 创建 `external_effects`、`external_effect_attempts`。
- [ ] `logical_effect_key` 唯一。
- [ ] 实现 GitHub Check/Comment Provider Adapter。
- [ ] 网络结果不明时进入 `UNKNOWN`，禁止直接按失败重发。
- [ ] Reconciler 根据 Provider Object ID 或稳定 Marker 对账。
- [ ] Head SHA 已变化时旧 Review 标记 STALE，禁止发布为当前结果。

### M1.9 故障注入验收

- [ ] 同一 GitHub Delivery ID 发送 5 次，只产生一个逻辑 ReviewRun。
- [ ] Outbox 提交后 API 崩溃，Relay 恢复后仍能发布。
- [ ] Worker 完成计算但 ACK 前崩溃，新 Attempt 能安全恢复。
- [ ] GitHub 已接收评论但响应丢失，对账后不生成第二条。
- [ ] Review 期间 Head SHA 更新，旧 Run 变为 STALE。
- [ ] Worker A Lease 过期、B 接管后，A 恢复也无法覆盖 B。
- [ ] 可以通过 trace_id 追踪 HTTP → DB → Outbox → MQ → Worker → Artifact → GitHub。
- [ ] 任意日志、Trace、错误、消息和测试快照中不存在 Secret 明文。

### M1 退出门槛

- [ ] 真实完成一条 GitHub Action/Webhook → Review → GitHub Delivery 链路。
- [ ] 所有故障注入场景可重复运行且结果稳定。
- [ ] 数据库迁移、约束、安全测试、集成测试和质量门禁全部通过。
- [ ] 使用本项目 Review Harness 审查本仓库，并将结果作为 Dogfooding Artifact 保存。

## 7. M2：设计稿与 HTML 协作

### M2.1 Design Artifact

- [ ] 创建 `design_documents`、`annotations`、`annotation_anchors`、`design_patches`、`design_approvals`、`preview_snapshots`。
- [ ] 支持需求文本、静态 HTML、Figma Snapshot 和已有 Design ArtifactVersion 输入。
- [ ] Figma 证据必须由用户对本次 Run 显式选择，不自动绑定项目历史稿件。
- [ ] HTML Bundle 使用内容哈希和 ArtifactVersion 保存，禁止原地覆盖。

### M2.2 Annotation Anchor

- [ ] Anchor 组合 stable `data-node-id`、DOM Path、元素指纹、Text Quote、Ancestor Context、Screenshot Region 和 artifact_version_id。
- [ ] 节点定位失败时返回明确状态，不静默批注到错误元素。
- [ ] 设计锚点迁移策略和冲突展示。

### M2.3 Structured Patch

- [ ] Patch 包含 base_version_hash、operations、precondition、target node、generated_by_task 和 validation_result。
- [ ] `current_hash != base_version_hash` 时返回 `409 ARTIFACT_VERSION_CONFLICT`。
- [ ] Patch 通过解析、Schema、安全和渲染检查后才生成新 ArtifactVersion。
- [ ] 保存 HTML Diff、视觉证据和完整血缘。

### M2.4 Preview 与安全

- [ ] Preview 在 Sandbox/隔离 iframe 中运行。
- [ ] 默认禁止访问 Control Plane Cookie 和数据库凭据。
- [ ] 配置 CSP、网络策略、资源大小、进程、CPU、内存和超时限制。
- [ ] 不信任导入 HTML 中的 Script、iframe 和远程资源。
- [ ] Sandbox 安全配置失败时 fail-closed。

### M2.5 审批与下游绑定

- [ ] UI/UX 可以接受、拒绝或追加批注。
- [ ] 审批生成不可变 Approval Snapshot。
- [ ] 后续 Run 只能显式绑定批准的 Design ArtifactVersion。
- [ ] 禁止下游隐式读取 latest Design。

### M2 退出门槛

- [ ] HTML 导入、批注、Agent Patch、新版本、Diff、预览和审批形成真实闭环。
- [ ] 旧 base hash 稳定产生版本冲突。
- [ ] Figma Snapshot 不会污染其他 Run。
- [ ] Anchor 失败、恶意 HTML、Sandbox 超时和渲染失败均有真实测试。
- [ ] M2 代码通过本项目 Review Harness 自审查。

## 8. M3：研发与最终交付闭环

### M3.1 输入与 Canonical Delivery Spec

- [ ] 支持需求、可预览与裁切的文档、批准的 Design ArtifactVersion。
- [ ] DevelopmentRun 冻结 requirement_version、document_slices、design_artifact_version、base_commit_sha、verification_plan_version、ruleset_version 和 agent_policy_version。
- [ ] 人工审批快照是后续代码生成的唯一可信输入。

### M3.2 Workspace 与代码生成

- [ ] 每个 Run/Attempt 使用独立 `.workspace/delivery-worktrees/{runId}/{attemptId}`。
- [ ] 并发 Attempt 禁止修改同一个 Worktree。
- [ ] Agent Provider 与具体模型/SDK 解耦。
- [ ] 代码生成输出 Patch/Commit 和 Diff Manifest，不直接宣称交付成功。

### M3.3 Verification

- [ ] 在 Sandbox 中执行真实 Build、Lint、Typecheck、Test 和项目自定义命令。
- [ ] 真实 `run_command`、exit_code、stdout/stderr Artifact 是权威事实；模型解释不得覆盖。
- [ ] Evidence 绑定 commit_sha、command、environment_digest、时间、exit_code、日志和 trace_id。
- [ ] Commit 变化后旧 Evidence 自动失效。
- [ ] 验证失败可创建明确的修复 Attempt，并再次回到 Verification。

### M3.4 Review、Proof Bundle 与 Gate

- [ ] Review 使用最终 Net Diff，不审查已经被后续提交抵消的历史 Patch。
- [ ] 复用 M1 Review Harness 和 RulesetVersion。
- [ ] Proof Bundle 包含需求、设计、Diff、验证、审查、模型/Prompt 版本、审批和外部交付结果。
- [ ] Engineering Gate 在 Verification 和 Review 都完成后评估。
- [ ] Gate 失败不得创建 Ready PR。

### M3.5 PR 与 Preview

- [ ] 创建 Preview Artifact/Deployment，并保存可追踪的版本引用。
- [ ] PR 创建使用 ExternalEffect 幂等和 Reconciliation。
- [ ] PR 可以反向追溯到需求、设计、Run、Task、Attempt、证据、审查和批准。

### M3 退出门槛

- [ ] 从需求和批准设计稿到代码、验证、审查、Preview 和 PR 的真实闭环完成。
- [ ] 故障恢复、Stale Commit、重复 PR 请求和外部结果未知场景可验证。
- [ ] Proof Bundle 和 Engineering Gate 不依赖模型自述。
- [ ] M3 代码通过本项目 Review Harness 自审查。

## 9. 缓存专项（满足真实需求后启动）

- [ ] Artifact Slice Cache Key 绑定 `artifact_hash + parser_version + slice_policy_version`。
- [ ] Repository Index Cache Key 绑定 `repository_id + head_sha + indexer_version`。
- [ ] 记录命中率、回源耗时、缓存容量和失效原因。
- [ ] 验证缓存击穿、热点 Key、并发回源和 Provider 限流。
- [ ] 禁止 `project:latest-html`、`repo:latest-index` 等不可审计 Key。
- [ ] 通过 ADR 对比本地缓存、PostgreSQL、Redis 和不缓存方案后再选型。

## 10. 代码质量专项

### 10.1 静态质量

- [ ] 类型感知 ESLint 零错误。
- [ ] TypeScript 严格检查零错误。
- [ ] 格式检查零差异。
- [ ] 循环依赖为零。
- [ ] 架构边界违规为零。
- [ ] 禁止无理由 `any`、`@ts-ignore`、非空断言和 ESLint Disable。
- [ ] 使用依赖与重复代码检查工具发现无用依赖、死代码和复制粘贴。

### 10.2 测试质量

- [ ] 全局 lines/statements/functions ≥ 85%，branches ≥ 80%。
- [ ] Identity、Security、Workflow、Review branches ≥ 90%。
- [ ] 测试必须包含有效断言，不允许为覆盖率执行代码但不验证结果。
- [ ] 状态机、安全、幂等和外部副作用在各里程碑前执行定向 Mutation Testing 或等价的测试有效性检查。
- [ ] 新缺陷必须先添加可失败的回归测试，再修复。

### 10.3 Review 与 Dogfooding

- [ ] 每个 PR 使用统一 Review Checklist。
- [ ] 优先审查正确性、安全、事务、并发、兼容性和测试，再审查风格。
- [ ] Review Finding 必须包含证据和可定位文件/行号。
- [ ] 阻塞 Finding 未解决时不得交付。
- [ ] M1 后每个里程碑使用本项目 Review Harness 审查自身代码。
- [ ] 自审查发现的问题、争议项和最终处理结果作为 Artifact 留存。

## 11. 每个任务的 Definition of Done

- [ ] 行为与当前 TODO/ADR 一致。
- [ ] 没有越过当前里程碑边界顺手实现未来功能。
- [ ] API、消息、数据库和前端契约同步更新。
- [ ] 失败路径和关键边界有测试。
- [ ] Migration 可从空库执行，约束真实生效。
- [ ] 没有 Secret、构建产物、日志或本地数据库进入 Git。
- [ ] `pnpm format:check` 通过。
- [ ] `pnpm lint` 通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 通过。
- [ ] 相关 `pnpm test:integration` 通过。
- [ ] `pnpm check:architecture` 通过。
- [ ] `pnpm build` 通过。
- [ ] `git diff --check` 通过。
- [ ] 文档和 ADR 已更新。
- [ ] 明确说明验证层级及仍未覆盖的真实环境风险。

## 12. 明确延后项

- [ ] 多区域与跨区域一致性。
- [ ] Kubernetes 与自动扩缩容。
- [ ] Kafka、Temporal、Service Mesh。
- [ ] Firecracker 或自建 microVM 基础设施。
- [ ] GitLab、Bitbucket 等额外代码托管 Provider。
- [ ] 实时多人协同编辑。
- [ ] 企业 SSO、计费和商业租户套餐。
- [ ] 多语言 Worker Runtime。
- [ ] 自动合并 Autofix。

延后项可以定义 Provider Contract 或返回 501，但不得实现半成品或伪造成功结果。
