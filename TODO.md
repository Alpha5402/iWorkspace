# AI Delivery Control Plane 总体 TODO

> 状态：M0 已完成。M1 原邀请制主闭环与 L2 自动化验证已完成；公开注册、邮箱验证、个人 Organization、PostgreSQL 限流、JWT 双 Token、平台管理员后台、组织切换、设备会话、密码变更撤销与非敏感 Token 元数据的 L2 已落地。身份 Principal 统一、Artifact GC、Ruleset 版本编辑、容量基线、真实 GitHub/DeepSeek、进程故障接管和 Dogfooding Proof Bundle（L3）仍待完成。M2、M3 未开始。

## 0. 项目目标与阶段顺序

- [x] M0：架构基线与工程骨架——建立可运行、可验证的框架，未实现模块明确返回 `501 FEATURE_NOT_IMPLEMENTED`。
- [ ] M1：账户、数据库、安全与代码审查——原邀请制主闭环、公开注册、双 Token、平台用户管理和设备会话的 L2 已完成；其余硬化项及 L3 退出门槛待完成。
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

### M1-00：契约与数据库基础

- [x] 使用 Kysely、显式前向 Migration、独立数据库角色和事务工具。
- [x] 建立 Identity、Tenant、Review、Task、Outbox/Inbox、Artifact、Evidence、Provider Invocation 和 External Effect 核心表。
- [x] 使用唯一键、外键、Check Constraint、部分唯一索引和条件更新共同保证业务约束。
- [x] 为租户表启用 RLS，并通过事务级租户上下文隔离 API/Worker 数据访问。
- [x] 空库迁移、关键约束、RLS、`SKIP LOCKED` 和 JSONB 边界已有自动化测试。

### M1-01：身份、邀请与会话

- [x] 当前基线由可信 CLI 初始化首位管理员，后续用户通过一次性邀请加入；公开注册由 M1-11 替换这一产品边界。
- [x] 密码使用 Argon2id；一次性邀请令牌和旋转 Refresh Token 仅保存摘要。
- [x] Access/Refresh Cookie 使用安全属性，写请求校验 CSRF Header 和 Origin。
- [x] 旧 Refresh Token 重用会撤销整个 Family；最后一个 OWNER 受数据库和用例保护。

### M1-02：项目 RBAC、Token、Secret 与 Audit

- [x] 实现组织/项目角色检查和成员的最小管理接口。
- [x] 项目 Access Token 使用 256-bit 随机值和 Pepper HMAC 摘要，仅创建时返回一次明文。
- [x] 实现 AES-256-GCM 信封加密、带版本 KEK 包装和 Secret 轮换记录。
- [x] 管理、规则、Token、Secret、GitHub 连接和任务重放写入 Audit Event。
- [x] 日志与错误边界执行敏感字段脱敏，不把部署密钥写入数据库。

### M1-03：GitHub App 接入

- [x] 实现安装 URL/回调状态校验、仓库绑定、权限快照和按需 Installation Token。
- [x] Webhook 使用原始请求体做 HMAC-SHA256 验签，并以 Delivery ID 去重。
- [x] 自动 Review 的逻辑唯一键与 Action `Idempotency-Key` 均由数据库唯一约束原子裁决。
- [x] 同一 Commit 的重复 Webhook 不产生第二个逻辑 Run；权限/认证错误使用稳定错误码。
- [x] GitHub Connection 使用可审计的逻辑移除，并提供对应管理台入口。

### M1-04：异步作业内核

- [x] 实现 Transactional Outbox、Publisher Confirm、Consumer Inbox 和版本化 Event Envelope。
- [x] RabbitMQ 声明 Review 队列、TTL、重试路由和 Dead-letter Exchange。
- [x] 实现数据库时间 Lease、Heartbeat、Attempt、Fencing Token、Retry Wait、Lease Reaper 和容量租约。
- [x] Relay 所有权、重复消费、ACK/NACK、旧 Attempt 回写和延迟重试已有自动化测试。
- [x] 失败任务查询与重放会生成新 Event ID，并保留 causationId。
- [ ] 在真实多进程环境执行 Worker 强杀、Broker 中断和 DLQ 人工重放演练。

### M1-05：Artifact 与 Evidence

- [x] MinIO 上传先写临时对象并校验哈希/大小，再提升为内容寻址正式对象。
- [x] Review 输入、批次、模型调用、Finding 和报告通过 Artifact Link/Evidence 记录血缘。
- [x] 生成固定 JSON、争议项、批次摘要、Coverage Manifest、文本摘要和 HTML 报告。
- [x] 校验失败会清理临时对象，Artifact 下载时复核内容哈希。
- [x] 增加进程崩溃遗留临时对象及“正式对象成功、元数据事务回滚”孤儿对象的定时 GC；使用可配置安全宽限期、有界分页、数据库引用复核和单飞调度，避免删除仍可能提交的对象。

### M1-06：Ruleset 与 Diff Pipeline

- [x] 可创建 Ruleset Draft 并发布为不可变版本；Review 创建时冻结明确版本。
- [x] 解析 GitHub Diff、Hunk 与新旧行位置，记录二进制/截断/超限 Coverage。
- [x] 根据路径与语言映射规则，并按目录邻近/import 关系构建稳定批次。
- [x] 受信任的确定性规则先执行；用户规则不能上传可执行脚本。
- [x] 已发布 Ruleset Version 可显式切换为项目默认版本。
- [ ] 补充 Draft 编辑和同一 Ruleset 下的新版本创建接口。

### M1-07：DeepSeek Review 与 Verify

- [x] 通过供应商无关 Provider Port 调用 `/responses`，本地 Zod 校验 JSON Schema 输出。
- [x] Design、Implementation、Defect 分类 Review 与高严重度二次 Verify 已接入 DAG。
- [x] Finding 位置、Evidence、Fingerprint、去重、降级/争议/拒绝规则均有确定性校验。
- [x] 保存模型、Prompt/Schema 版本、输入哈希、Response ID、用量、耗时和错误分类，不保存思维链。
- [x] Stub 覆盖非法输出修复、重复结果、429、5xx、超时和非重试错误。
- [ ] 使用真实 `DEEPSEEK_API_KEY` 完成显式开启的 Provider E2E。

### M1-08：GitHub Check 与 External Effect

- [x] Check 创建使用唯一 Logical Effect、`external_id=reviewRunId` 和稳定详情 URL。
- [x] 请求结果不确定时进入 `UNKNOWN`，通过 External ID 协调后才允许确定终态。
- [x] 发布前复核 PR Head；新 Commit 会使旧 Run 进入 `STALE` 且不发布 Check。
- [x] 最多选择 50 条已确认、可定位 Finding；只有 `CONFIRMED BLOCKING` 产生 `failure`。
- [x] Installation Token 获取失败发生在 Check 不确定写入窗口之外，不会误标为 `UNKNOWN`。
- [ ] 在真实 GitHub 上验证“服务端成功、客户端超时”不会创建第二个 Check Run。

### M1-09：最小 Vue 3 管理台

- [x] 登录、邀请接受、项目列表/创建、项目管理和 Review 详情调用真实 API Client。
- [x] 项目页覆盖 GitHub 连接、Access Token、Ruleset 发布和 Review 触发/列表。
- [x] Review 详情展示时间线、Coverage、Finding、Artifact，并通过 SSE + `Last-Event-ID` 恢复。
- [x] 前端凭据不进入 Local Storage；错误、加载、空态和权限态有统一表达。
- [x] 关键用户交互已有组件测试，不使用前端 Mock 数据作为运行事实。

### M1-10：硬化与验收

- [x] L2 质量门禁通过：Format、Lint、Typecheck、单元测试、集成测试、架构检查、Dead Code、重复度和 Build。
- [x] Identity、Security、Review Harness 与 Domain 核心边界分别强制至少 90% 的分支覆盖率。
- [x] 自动化覆盖重复投递、租约接管、Fencing、Head 变化、Provider 错误、Artifact 校验和 External Effect 协调。
- [ ] 完成每日 10,000 Review / 100 活跃 Run 的容量基线并归档指标。
- [ ] 使用真实 GitHub App、测试仓库和 DeepSeek 跑通 Webhook 与 Action Token 两条 L3 路径。
- [ ] 运行本仓库 Dogfooding，并整理“需求 → 运行证据”的 M1 Proof Bundle。

### M1-11：公开注册、平台用户分层与 JWT 双 Token

#### 目标与角色边界

- [x] 开放公开注册，但新账户先进入 `PENDING_VERIFICATION`；完成邮箱验证后才激活账户并在同一事务创建个人 Organization。
- [x] 平台角色固定为 `SUPER_ADMIN / ADMIN / USER`，与组织角色 `OWNER / ADMIN / MEMBER`、项目角色 `MAINTAINER / REVIEWER / VIEWER` 相互独立，禁止根据名称相同隐式继承权限。
- [x] 首位 `SUPER_ADMIN` 仍由可信 CLI 创建；只有 `SUPER_ADMIN` 可以授予或撤销平台 `ADMIN`，并保护最后一个 `SUPER_ADMIN` 不被停用、降级或删除。
- [x] 平台 `ADMIN` 可以查询和管理全站普通用户、会话与账户状态，但不因平台角色自动获得任意租户项目数据访问权；进入租户业务仍需显式 Membership。
- [ ] 统一 Principal 类型为 `USER_SESSION / PROJECT_TOKEN / SYSTEM`；所有权限决策和 Audit Event 必须记录 Principal 类型与稳定 ID。
- [ ] 保留项目 Access Token 作为项目级机器身份，通过 `project_id + scopes + token_id` 鉴权；`created_by` 只表达创建者和审计血缘，不把机器 Token 伪装成创建它的用户。

#### JWT 双 Token 与会话安全

- [x] Access Token 和 Refresh Token 均使用 JWT；使用不同的 `typ`、Audience 和独立可轮换 EdDSA 密钥，防止两类 Token 混用。
- [x] Access JWT 默认 10 分钟，至少包含 `sub=userId`、`organizationId`、`sessionId` 和 `jti`；不把可变角色当成无需复核的长期授权事实。
- [x] Refresh JWT 默认 30 天，至少包含 `sub`、`sessionId`、`familyId`、`jti` 和 `tokenType=refresh`；数据库保存 Refresh Token 摘要/JTI 状态，不保存明文。
- [x] Refresh JWT 每次使用都旋转；旧 Token 重用、账户停用、管理员撤销或用户“退出全部设备”时撤销整个 Session Family。
- [x] 密码变更必须撤销该用户的全部 Session Family，并要求使用新密码重新登录。
- [x] Access/Refresh JWT 继续使用 `HttpOnly + Secure + SameSite=Lax` Cookie；Refresh Cookie 限定 `/api/v1/auth` 路径，前端不得写入 Local Storage。
- [x] 所有写请求继续执行 CSRF Header 与 Origin 校验；平台角色和 Membership 在服务端读取当前状态，角色撤销不能依赖旧 JWT 自然过期。
- [x] 支持登录设备/Session 列表、撤销单个 Session、退出其他设备和退出全部设备。

#### 注册、组织切换与账户生命周期

- [x] 实现 `POST /api/v1/auth/register`、`POST /api/v1/auth/verify-email`、`POST /api/v1/auth/resend-verification`；重复邮箱和验证码状态使用稳定错误码且不泄露账户是否存在。
- [x] 邮箱验证 Token 使用高熵随机值、单次使用、短期过期并仅保存摘要；生产环境通过 Email Provider Port + Outbox 发送，禁止在响应和日志返回验证 Token。
- [x] 初期使用 PostgreSQL 记录公开注册、登录和重发验证的分布式限流桶；只有指标证明数据库成为瓶颈后才引入 Redis。
- [x] 实现 `GET /api/v1/me/organizations` 与 `POST /api/v1/auth/switch-organization`；切换时验证 Membership、撤销旧 Session Family 并签发绑定新 Organization 的双 Token。
- [x] 用户状态至少支持 `PENDING_VERIFICATION / ACTIVE / SUSPENDED`；停用采用可审计状态迁移，不物理删除用户、凭据、审计和历史运行血缘。

#### 平台管理员后台

- [x] 实现 `GET /api/v1/admin/users`，支持游标分页、邮箱/状态/平台角色筛选和稳定排序，禁止无界全表返回。
- [x] 实现 `GET /api/v1/admin/users/:userId`，展示基础信息、平台角色、组织 Membership 和 Session 摘要，且不返回密码哈希、完整 Token、Cookie 或 Secret。
- [x] 在管理员用户详情中补充由该用户创建的项目 Token 非敏感元数据；通过专用安全视图暴露，禁止返回 Token 摘要和明文。
- [x] 实现用户停用/恢复、撤销所有 Session、授予/撤销 `ADMIN` 的用例和 API；所有操作要求原因并写入 Audit Event。
- [x] Vue 3 新增注册、邮箱验证、组织切换和 `/admin/users` 页面；路由守卫只改善体验，后端必须独立执行完整授权。
- [x] 管理员后台对高风险操作提供二次确认，并清楚区分平台角色、组织角色和项目角色。

#### 数据库与迁移

- [x] 通过前向 Migration 扩展用户状态与平台角色，新增邮箱验证、Session/JTI、角色变更和限流数据；禁止修改已发布 Migration。
- [x] 为规范化邮箱、未消费验证 Token、Session JTI、最后一个 `SUPER_ADMIN` 和角色变更并发建立数据库约束或事务锁。
- [x] API 普通租户连接不得获得无界跨租户权限；平台管理查询使用单独、最小授权的 Repository/数据库角色，不复用 Migrator 或超级管理员连接。
- [x] 设计 Access/Refresh JWT 密钥版本字段和双密钥轮换窗口，保证部署滚动升级期间旧 Token 可验证、新 Token 使用最新 Key。

#### 关键决策与 Trade-off

本切片已固定以下实现决策：注册发生在租户创建之前，因此身份邮件使用独立 Outbox，不削弱必须携带租户标识的业务事件 Envelope；验证 Token 摘要与可投递密文分离，密文使用独立版本化 KEK，仅由 Email Worker 在内存解密；过期、租约和限流窗口统一使用 PostgreSQL 时钟；注册与重发对已存在/不存在账户返回相同响应。代价是增加一套小型 Identity Outbox 与部署密钥，但换来事务性邮件意图、可接管投递、稳定幂等和账户枚举防护。

平台管理使用独立的 `iw_platform_admin` 数据库角色和连接池；该角色可绕过租户 RLS，但只获得用户、组织 Membership 与 Session 所需的列级/表级权限，明确不能读取 `projects`。用户状态与角色变更通过全局 Advisory Lock、目标行锁和同事务 Audit Event 串行化。代价是多一个受约束连接池并降低管理员写吞吐，但管理操作低频，换来可证明的跨租户权限边界与“最后一个活跃 SUPER_ADMIN”并发保护。组织切换会撤销旧 Session Family 并签发绑定目标 Organization 的新双 Token，牺牲跨标签页继续使用旧会话的便利，避免租户上下文混用。

- [ ] 记录 ADR：公开注册扩大攻击面并增加 Email Provider、限流和账户枚举防护成本，但换来自助获客与独立用户身份。
- [ ] 记录 ADR：Refresh Token 虽采用 JWT，仍保持服务端 Session/JTI 状态，因此牺牲“完全无状态”，换取旋转、重放检测、管理员撤销和设备管理能力。
- [ ] 记录 ADR：平台管理员不自动绕过租户权限，增加一次显式授权检查，但显著缩小后台账号泄露后的数据暴露范围。
- [ ] 记录 ADR：公开注册用户自动创建个人 Organization，避免没有租户上下文的悬空账户；代价是 Organization 数量会随注册用户增长。

#### 测试与退出条件

- [x] 覆盖重复邮箱并发注册、验证 Token 重放/过期、限流、邮箱 Provider 失败与 Outbox 重试。
- [x] 覆盖 Access/Refresh 类型混淆、错误 Audience/Key、Refresh 重放、密钥轮换、账户停用和 Session 全量撤销。
- [x] 补充密码变更后的 Session 全量撤销测试。
- [x] 覆盖越权提权、最后一个 `SUPER_ADMIN` 保护、管理员不能隐式读取租户项目、跨组织切换和停用后的即时授权拒绝。
- [x] 管理员用户列表验证游标分页稳定性、敏感字段缺失和操作审计。
- [ ] 使用接近容量假设的数据量验证管理员用户查询计划与索引命中。
- [ ] 浏览器真实跑通“公开注册 → 邮箱验证 → 登录 → 切换组织 → 管理员查询/停用用户 → Session 失效”，不使用前端 Mock 作为完成证据。
- [x] Identity、Security 核心分支覆盖率继续不低于 90%，并通过完整 `pnpm quality`、空库迁移和升级迁移测试。

### M1 退出门槛

- [x] 原邀请制身份与 Review 主闭环的数据库迁移、约束、安全测试、集成测试和质量门禁已通过（旧 L2 基线）。
- [x] 公开注册、平台用户分层、管理员后台、组织切换、设备会话与 JWT 双 Token 主路径通过新的 L2 验收。
- [ ] 真实 GitHub Action/Webhook → Review → GitHub Check 链路通过（L3）。
- [ ] 真实进程/基础设施故障注入可重复运行且结果稳定（L3）。
- [ ] 本仓库 Dogfooding Artifact 与 M1 Proof Bundle 已保存（L3）。

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
