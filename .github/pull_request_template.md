## 变更契约

- [ ] 说明本次变更解决的问题、明确范围以及没有处理的范围。
- [ ] 记录关键决策、替代方案、Trade-off、容量或安全假设及验证方式。
- [ ] API、消息、数据库、Artifact 与前端契约已同步；版本化边界没有被隐式改变。
- [ ] 没有越过当前里程碑，未来能力保持明确的 `FEATURE_NOT_IMPLEMENTED`。

## 正确性与风险审查

- [ ] 优先检查正确性、安全、事务、并发、幂等、兼容性和故障恢复，再检查格式与风格。
- [ ] 状态机、权限、租户隔离、重试、重复投递、旧 Attempt 回写及外部副作用失败路径已覆盖。
- [ ] 数据库约束、事务和条件更新共同保证关键不变量，不依赖调用方约定。
- [ ] Secret、Token、Cookie、密码、模型 reasoning 与第三方凭据没有进入日志、响应或 Git。
- [ ] 每条 Review Finding 均包含证据和最小可定位文件/行号；无法定位的结论不伪装成行级 Finding。
- [ ] 所有 Blocking Finding 已解决或有明确、可审计的接受理由；未解决时不得交付。

## 验证证据

- [ ] 新功能或缺陷包含先失败、后通过的回归测试，且覆盖关键失败路径。
- [ ] `pnpm quality` 与 `git diff --check` 通过。
- [ ] 里程碑交付执行 `pnpm quality:milestone`，Mutation Score 不低于 90%。
- [ ] 数据库变更验证空库迁移、升级迁移、约束和 RLS；Worker/消息变更验证重复投递、崩溃、重试与 Fencing。
- [ ] 列出真实执行的命令、产物和 L0-L4 验证等级；Mock、Build 或页面可打开不得表述为 L3/L4。
- [ ] 明确仍未覆盖的真实 Provider、浏览器、容量、安全或生产环境风险。

## Review 结果

- [ ] Reviewer 已记录 Blocking/Major/Minor/Info Finding 及处理结果。
- [ ] 争议项、接受风险和最终决定具有可追踪证据。
- [ ] 需要 Dogfooding 的里程碑已保存本项目 Review Harness 产物。
