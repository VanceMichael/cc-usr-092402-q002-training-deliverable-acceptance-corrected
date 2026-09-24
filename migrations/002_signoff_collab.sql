-- 跨境实训成果签收协同：完整领域模型
-- 所有时间均以 UTC 文本存储（ISO-8601），来源时区单独留痕。

-- 机构（可能退出）
CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exited')),
  exited_at TEXT,
  created_at TEXT NOT NULL
);

-- 用户：全局身份 + 基础角色；跨批次的具体授权见 batch_staff / team_members
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','mentor','reviewer','admin')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  active INTEGER NOT NULL DEFAULT 1
);

-- 课程批次：规则以版本化 JSON 留存，档案导出与“当时规则”对齐
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  rules TEXT NOT NULL,                       -- 当前规则 JSON
  rules_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE batch_rule_versions (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  version INTEGER NOT NULL,
  rules TEXT NOT NULL,
  enacted_by TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (batch_id, version)
);

-- 团队与成员
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, name)
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (team_id, user_id)
);

-- 批次内导师/企业复核授权；can_score/max_score 表达“评分权限”
CREATE TABLE batch_staff (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('mentor','reviewer')),
  can_score INTEGER NOT NULL DEFAULT 0,
  max_score REAL,
  scope_team_id TEXT REFERENCES teams(id),   -- NULL = 全批次
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, user_id)
);

-- 产出节点：截止时间、签署范围、创建时规则快照
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  deadline_at TEXT NOT NULL,                 -- UTC 时刻
  deadline_tz TEXT NOT NULL DEFAULT 'UTC',   -- 截止时间公布时的时区
  signing_scope TEXT NOT NULL,               -- JSON，例如 {"parties":["mentor","enterprise"]}
  rules_snapshot TEXT NOT NULL,              -- 创建节点时冻结的规则
  rules_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, code)
);

-- 截止时间变更：责任方留痕，供逾期归因
CREATE TABLE deadline_changes (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  old_deadline_at TEXT,
  new_deadline_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  responsible_party TEXT NOT NULL
    CHECK (responsible_party IN ('school','mentor','enterprise','student','institution')),
  changed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_deadline_changes_node ON deadline_changes(node_id);

-- 成果：团队成果或个人成果
CREATE TABLE deliverables (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  team_id TEXT REFERENCES teams(id),
  owner_user_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('team','individual')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','revoked')),
  predecessor_id TEXT REFERENCES deliverables(id), -- 撤销重裁后承接整改的后继成果
  certificate_counted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_deliverables_node ON deliverables(node_id);

-- 提交版本链：内容摘要、来源时区、前序版本
CREATE TABLE submission_versions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  version_no INTEGER NOT NULL,
  content_summary TEXT NOT NULL,
  source_tz TEXT NOT NULL,
  predecessor_id TEXT REFERENCES submission_versions(id),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  client_event_id TEXT,                      -- 离线端事件号：同成果内重复补传幂等
  occurred_at TEXT NOT NULL,                 -- 事件实际发生时刻（UTC，按来源时区换算）
  is_backfill INTEGER NOT NULL DEFAULT 0,   -- 是否离线补传
  received_at TEXT NOT NULL,                 -- 服务器接收时刻（UTC）
  UNIQUE (deliverable_id, version_no),
  UNIQUE (deliverable_id, client_event_id)
);
CREATE INDEX idx_versions_deliverable ON submission_versions(deliverable_id, version_no);

-- 签收意见（导师/企业）。导师可在补交文件到达前先发表意见（version_id 可空）。
-- receipt_key 用于“重复回执”去重：同节点同签署人同回执号只承认一次。
CREATE TABLE signoffs (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  deliverable_id TEXT REFERENCES deliverables(id),
  signer_user_id TEXT NOT NULL REFERENCES users(id),
  party TEXT NOT NULL CHECK (party IN ('mentor','enterprise')),
  decision TEXT NOT NULL CHECK (decision IN
    ('approved','conditional','returned','partial_return','disputed')),
  score REAL,
  comment TEXT,
  receipt_key TEXT NOT NULL,
  version_id TEXT REFERENCES submission_versions(id),
  created_at TEXT NOT NULL,
  UNIQUE (node_id, signer_user_id, receipt_key)
);
CREATE INDEX idx_signoffs_deliverable ON signoffs(deliverable_id, party);

-- 整改缺口：附条件通过/局部退回产生；assignee 为空=团队缺口，企业可拆成个人缺口。
-- 学员补交时只能关闭 assignee = 本人的缺口。
CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  version_id TEXT REFERENCES submission_versions(id),
  signoff_id TEXT REFERENCES signoffs(id),
  created_by_party TEXT NOT NULL CHECK (created_by_party IN ('mentor','enterprise')),
  created_by TEXT NOT NULL,
  assignee_user_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed','void','frozen','waived')),
  due_at TEXT,                               -- NULL = 跟随节点截止时间
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT REFERENCES users(id),
  closed_by_version_id TEXT REFERENCES submission_versions(id)
);
CREATE INDEX idx_gaps_deliverable ON gaps(deliverable_id, status);
CREATE INDEX idx_gaps_assignee ON gaps(assignee_user_id, status);

-- 企业复核发起的争议
CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  signoff_id TEXT REFERENCES signoffs(id),
  raised_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','upheld','rejected','withdrawn')),
  resolution TEXT,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_disputes_deliverable ON disputes(deliverable_id);

-- 已计入证书的成果留痕
CREATE TABLE certificate_records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  version_id TEXT NOT NULL REFERENCES submission_versions(id),
  issued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'counted' CHECK (status IN ('counted','revoked'))
);
CREATE INDEX idx_cert_deliverable ON certificate_records(deliverable_id);

-- 撤销记录 + 新决定：已计证书成果的唯一纠正路径
CREATE TABLE revocations (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  certificate_id TEXT REFERENCES certificate_records(id),
  reason TEXT NOT NULL,
  revoked_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE new_decisions (
  id TEXT PRIMARY KEY,
  revocation_id TEXT NOT NULL REFERENCES revocations(id),
  successor_deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  decision TEXT NOT NULL CHECK (decision IN
    ('approved','conditional','returned','partial_return','disputed')),
  score REAL,
  comment TEXT,
  version_id TEXT REFERENCES submission_versions(id),
  decided_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_new_decisions_revocation ON new_decisions(revocation_id);
CREATE INDEX idx_new_decisions_successor ON new_decisions(successor_deliverable_id);

-- 机构退出
CREATE TABLE institution_exits (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  batch_id TEXT REFERENCES batches(id),       -- NULL = 全局退出
  reason TEXT,
  effective_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

-- 结项档案：不可变导出，内容哈希校验，规则/签署范围随档冻结
CREATE TABLE archive_exports (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  batch_status_at_export TEXT NOT NULL,
  rules_version INTEGER NOT NULL,
  rules_snapshot TEXT NOT NULL,
  manifest TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  exported_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_archive_batch ON archive_exports(batch_id);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
