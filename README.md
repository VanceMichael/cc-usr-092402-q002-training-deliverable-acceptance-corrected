# 跨境实训成果签收流

面向职业院校跨境实训项目集中结项场景的后端工程：在课程批次、产出节点之上提供完整的成果签收协同。基于 Koa + better-sqlite3，SQLite 文件放在运行目录，迁移脚本位于 `migrations`，不依赖其他数据库或缓存服务。

启动：`docker build -t training-flow . && docker run --rm -p 8080:8080 training-flow`（本地可 `DB_PATH=/tmp/app.db npm start`，端口 `PORT`）。本地测试：`npm test`，语法检查：`npm run build`。

## 领域规则

- **版本化提交**：每次提交保留内容摘要、内容哈希、来源 IANA 时区（含夏令时偏移换算）与前序版本指针，形成版本链。
- **评分权限与签署范围**：节点固化签署范围（评分导师名单、企业复核是否必经）。只有 `can_grade` 且在范围内的导师、批次企业方复核员能给决定；决定冻结所依据的规则版本与提交版本。
- **附条件通过 / 局部退回 / 争议**：导师可 `conditional`；企业复核可 `partial_return` 把一个团队成果拆成个人或团队缺口（`gaps`），可 `dispute` 发起争议；争议由教务裁决，成立则签收打回重开缺口，驳回则以豁免补齐企业确认。
- **缺口与补交**：学员补交只能关闭自己负责（或所在团队共同负责）的缺口，越权关闭被拒。针对缺口的补交只让提出缺口的一方基于新版本重签；通用新版本则使所有旧签收失效。
- **确定的边界处理**
  - 截止时间、批次规则均版本化，历史 SLA 与决定冻结在当时版本，事后变更不改写历史；
  - 重复回执：写接口支持 `Idempotency-Key`，同键同请求确定性重放，同键不同请求冲突；离线补传按“作者+内容+声称完成时刻”自然去重；
  - 离线补传：在规则允许的上报窗口内以 `authoredAt` 计时，超窗口或声称未来时间拒绝；
  - 机构退出：退出生效后，其导师确认/企业复核/学员责任按角色确定豁免并留痕，学员离队、个人缺口豁免、整队无人则团队成果豁免；豁免不追溯已结项批次；
  - 结项冻结：关闭后规则/截止/结构不可改；纠正只能以追加方式进入哈希链 addendum。
- **证书纠正**：成果完成后按在册成员发证；已计入证书的成果不能就地修改，只能由教务“撤销记录（可整队撤销）+ 新决定”纠正；整改后凭新决定重新出证，均追加进档案。
- **教务看板**：每个批次可见尚缺谁的确认（含开放缺口负责人及是否逾期）、未裁决争议、逾期事件及责任方（学员/导师/企业，机构退出豁免单列）、豁免清单、证书统计，并给出能否结项。
- **结项档案**：批次全部完成且无开放争议才能关闭；导出与当时规则版本、截止版本、签署范围一致的完整清单（提交链/决定/缺口/争议/豁免/SLA/证书/撤销），规范化哈希自验，结项后的纠正以 addendum 哈希链接力。

## HTTP 接口（JSON）

写接口可带 `Idempotency-Key`；操作者用 `X-Actor-Id` 表明身份。主要路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/admin/organizations`、`/admin/users` | 机构/用户 |
| POST | `/batches` | 建批次（含首版规则） |
| POST | `/batches/:batchId/parties` | 加入参与方 |
| POST | `/batches/:batchId/rules` | 规则新版本 |
| POST | `/batches/:batchId/milestones` | 建节点（含签署范围、首版截止） |
| POST | `/milestones/:id/deadline` | 截止时间新版本 |
| POST | `/batches/:batchId/teams`、`/teams/:id/members` | 团队与成员 |
| POST | `/milestones/:id/deliverables` | 成果（团队/个人唯一） |
| POST | `/organizations/:id/withdraw` | 机构退出 |
| POST | `/deliverables/:id/submissions` | 提交/离线补传/关闭缺口 |
| POST | `/deliverables/:id/decisions` | 导师/企业决定与缺口、争议 |
| POST | `/disputes/:id/resolve` | 教务裁决 |
| GET | `/deliverables/:id` | 成果状态评估 |
| GET | `/batches/:id/dashboard` | 教务看板 |
| POST | `/milestones/:id/certificates` | 签发证书 |
| POST | `/certificates/:id/revoke` | 撤销 + 新决定 |
| POST | `/batches/:id/close`、GET `/batches/:id/archive` | 结项与导出 |

## 代码结构

- `migrations/002_signoff.sql` — 全部表结构（只追加、版本化、哈希链）
- `src/db.js` / `src/util.js` / `src/errors.js` — 迁移执行、时间时区/哈希工具、错误类型
- `src/service.js` — 领域服务（事务、状态机、SLA、看板、档案）
- `src/app.js` / `src/server.js` — HTTP 适配与启动
- `test/signoff.test.js`（19 例）、`test/http.test.js`（4 例）— 领域与端到端测试

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译或构建：`npm run build`
