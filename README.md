# 跨境实训成果签收流

面向职业院校跨境实训「集中结项」阶段的成果签收协同后端：管理课程批次、产出节点、团队/个人成果的提交版本链、境外导师签收（含附条件通过）、企业复核（争议/局部退回）、学员补交关闭本人缺口、截止时间变更与逾期归因、机构退出、证书计入后的撤销重裁，以及与「当时规则 + 签署范围」一致的结项档案导出。

Node.js + Koa + better-sqlite3，SQLite 文件位于运行目录，迁移脚本在 `migrations`，无其他数据库或缓存依赖。

- 启动：`docker build -t training-flow . && docker run --rm -p 8080:8080 training-flow`
- 本地：`npm install` 后 `npm start`（可用 `DB_PATH` / `PORT` 覆盖）
- 测试：`npm test`　构建（语法检查）：`npm run build`

## 领域模型与确定性规则

- **提交版本链** `submission_versions`：每次提交保留内容摘要、来源时区（IANA，按该时区把“墙上时间”换算为 UTC，自动处理夏令时）、前序版本、提交人、事件发生时刻与服务器接收时刻。
- **导师先于补交发表意见**：签收可不带 `versionId`（文件未到先给意见），补交后版本链照常延续。
- **附条件通过 / 评分权限**：导师在批次授权中具备 `canScore` 且不超过 `maxScore` 才能打分；`conditional` 必须列明整改缺口。
- **企业复核**：可 `approved / conditional / returned / partial_return / disputed`。局部退回必须把团队缺口落实到具体学员；`splitTeamGap` 可把一个团队缺口作废并拆成多条个人缺口。
- **学员补交只能关闭本人缺口**：个人缺口仅负责人可用其本人提交的版本关闭；团队缺口（未落实到人）可由团队任一成员以本人版本关闭。
- **重复回执幂等**：签收以 `(node, signer, receiptKey)` 去重，重放原样返回且不重复产生缺口；离线提交以 `(deliverable, clientEventId)` 去重。
- **离线补传**：`isBackfill + occurredAt` 按事件实际发生时刻入链并参与逾期判定，而非服务器接收时刻。
- **截止时间变更**：每次变更写入不可变历史并记录责任方。逾期归因：未超当前生效期限=未逾期；截止时间被提前且在原期限内完成=记改期责任方；延期后仍超最终期限=仍记学员；缺口自带期限不随节点改期变动。
- **机构退出**：机构置 `exited`、其用户停用（再动作返回 `INSTITUTION_EXITED`）、在途个人缺口置 `waived`（豁免但留痕）、看板将其签署人标注为 waived，豁免方不再阻塞证书与结项。
- **已计证书成果的纠正**：满足各方有效确认且无开放/冻结缺口方可计入证书；计入后成果锁定，不能再直接签收或补交，只能由教务发起「撤销记录（证书吊销）+ 后继成果 + 新决定」纠正，全过程留痕。
- **争议**：企业可发起争议，裁决成立会冻结该成果开放缺口；同一方重新签收时其遗留 open/frozen 缺口自动作废。
- **结项档案**：导出为不可变快照，节点冻结其创建时的规则版本与签署范围；批次规则版本化（`batch_rule_versions`），改规则不回溯历史节点；档案含逐节点 manifest 与整体 `contentHash`。
- 所有写用例均在数据库事务内执行；唯一约束兜底并发重复提交/回执。

## HTTP 接口

请求体为 JSON，写接口通过请求头 `x-actor-id`（或 body.actorId）标识操作人。错误返回 `{ "error": "<CODE>", "message": "..." }`，状态码：400 校验 / 403 越权 / 404 不存在 / 409 冲突（含 `NOT_ELIGIBLE`、`REVOKED`、`FROZEN`、`CERT_LOCKED`、`INSTITUTION_EXITED`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/api/institutions` | 建机构 `{id,name}` |
| POST | `/api/institutions/:id/exit` | 机构退出 `{reason,batchId?,effectiveAt?}` |
| POST | `/api/users` | 建用户 `{id,institutionId?,name,role,timezone?}` |
| POST | `/api/batches` | 建批次 `{id,code,title,rules}` |
| GET | `/api/batches/:id` | 批次详情 |
| POST | `/api/batches/:id/rules` | 更新规则（版本化）`{rules,note}` |
| POST | `/api/batches/:id/staff` | 授权导师/复核 `{userId,role,canScore?,maxScore?,scopeTeamId?}` |
| POST | `/api/teams` | 建团队 `{id,batchId,name,memberIds?}` |
| POST | `/api/teams/:id/members` | 加学员 `{userId}` |
| POST | `/api/nodes` | 建节点 `{id,batchId,code,title,deadlineAt,deadlineTz,signingScope}` |
| POST | `/api/nodes/:id/deadline-changes` | 改期 `{newDeadlineAt,reason,responsibleParty}` |
| POST | `/api/deliverables` | 建成果 `{id,nodeId,teamId?|ownerUserId,title,kind}` |
| GET | `/api/deliverables/:id` | 成果详情（版本/签收/缺口） |
| POST | `/api/deliverables/:id/submissions` | 提交/补交 `{summary,sourceTz?,clientEventId?,occurredAt?,isBackfill?}` |
| POST | `/api/deliverables/:id/signoffs` | 签收 `{nodeId,party,decision,score?,comment?,receiptKey,versionId?,gaps?,disputeReason?}` |
| GET | `/api/deliverables/:id/eligibility` | 证书资格预检 |
| POST | `/api/deliverables/:id/revoke` | 教务撤销已计证书成果 `{reason}` |
| POST | `/api/gaps/:id/split` | 企业拆团队缺口 `{assignments:[{userId,title?}]}` |
| POST | `/api/gaps/:id/close` | 学员补交关闭缺口 `{versionId}` |
| POST | `/api/disputes/:id/resolve` | 裁决争议 `{outcome,resolution}` |
| POST | `/api/certificates` | 计入证书 `{batchId,userId,deliverableId,versionId}` |
| POST | `/api/revocations/:id/new-decision` | 撤销后新决定 `{successorDeliverableId,decision,score?,comment?,versionId?,gaps?}` |
| GET | `/api/batches/:id/dashboard` | 结项看板：尚缺谁的确认 + 各缺口/成果逾期与责任方汇总 |
| POST | `/api/batches/:id/archive` | 导出结项档案（不可变快照 + 哈希） |
| POST | `/api/batches/:id/close` | 关闭批次 |

时间字段：建议传带偏移的 ISO（如 `2026-10-01T00:00:00+08:00`）；不带偏移的墙上时间需配合 `sourceTz/deadlineTz` 解释。

## 代码布局

- `migrations/001_init.sql`、`migrations/002_signoff_collab.sql` — 表结构（启动时按 `schema_version` 自动应用）
- `src/db.js` — 迁移执行与连接
- `src/domain.js` — 全部事务化用例与逾期归因、看板、档案导出
- `src/app.js` — Koa 路由与错误码映射
- `src/server.js` — 装配启动
- `test/` — 领域规则与 HTTP 端到端测试
