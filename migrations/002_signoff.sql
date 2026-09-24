-- 跨境实训成果签收协同：完整领域模型
-- 设计要点：
--  * 批次规则与节点截止时间全部版本化，历史决定冻结在当时版本，事后改规则不改写历史
--  * 提交构成版本链（前序版本指针 + 来源时区），决定/缺口/争议/豁免全部只追加
--  * 证书只追加、只能以“撤销记录 + 新决定”纠正；结项档案含规范化哈希

PRAGMA foreign_keys = ON;

-- ============ 机构与用户 ============
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('school', 'overseas_school', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE organization_withdrawals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  effective_at TEXT NOT NULL,          -- UTC，退出生效时刻（迟到责任豁免起点）
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('student', 'mentor', 'enterprise_reviewer', 'academic_admin')),
  can_grade INTEGER NOT NULL DEFAULT 0, -- 评分权限：导师是否能给出签收决定
  active INTEGER NOT NULL DEFAULT 1
);

-- 批次参与方（院校/境外校/企业）
CREATE TABLE batch_parties (
  batch_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('school', 'overseas_school', 'enterprise')),
  PRIMARY KEY (batch_id, organization_id)
);

-- ============ 批次与规则版本 ============
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  current_rule_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 规则逐版本快照：require_all_mentors / 企业复核是否必经 / 补交窗口 / 宽限分钟 / 时区策略 / 离线补传窗口
CREATE TABLE batch_rules (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  version INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id),
  change_reason TEXT,
  require_all_mentors INTEGER NOT NULL,
  require_enterprise_review INTEGER NOT NULL,
  resubmit_window_hours INTEGER,       -- 附条件/局部退回之后的补交窗口，NULL=不限
  grace_minutes INTEGER NOT NULL DEFAULT 0,
  offline_report_window_hours INTEGER NOT NULL DEFAULT 0, -- 离线补传允许的上报延迟
  review_sla_hours INTEGER,             -- 导师/企业自收到提交起的评审 SLA（NULL=不考核）
  rule_json TEXT NOT NULL,             -- 完整规则快照（规范化 JSON）
  PRIMARY KEY (batch_id, version)
);

-- ============ 节点、截止时间版本、签署范围 ============
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('team', 'individual')),
  -- 签署范围快照：{mentorIds:[...], enterpriseRequired:bool}
  signing_scope_json TEXT NOT NULL,
  current_deadline_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (batch_id, code)
);

CREATE TABLE milestone_deadlines (
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  version INTEGER NOT NULL,
  deadline_at TEXT NOT NULL,           -- UTC 绝对时刻
  changed_at TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id),
  notice_text TEXT,
  PRIMARY KEY (milestone_id, version)
);

-- ============ 团队、成员、评分授权 ============
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (batch_id, code)
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  left_at TEXT,                         -- 个人离队时刻（机构退出时回填）
  PRIMARY KEY (team_id, user_id)
);

-- 导师在某节点的评分权限
CREATE TABLE grading_grants (
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  mentor_id TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (milestone_id, mentor_id)
);

-- ============ 成果 ============
CREATE TABLE deliverables (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  kind TEXT NOT NULL CHECK (kind IN ('team', 'individual')),
  team_id TEXT REFERENCES teams(id),
  owner_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX ux_deliv_team ON deliverables(milestone_id, team_id) WHERE kind = 'team';
CREATE UNIQUE INDEX ux_deliv_owner ON deliverables(milestone_id, owner_user_id) WHERE kind = 'individual';

-- ============ 提交版本链 ============
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  seq INTEGER NOT NULL,
  previous_submission_id TEXT REFERENCES submissions(id), -- 前序版本
  content_summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  storage_ref TEXT,
  source_tz TEXT NOT NULL,              -- IANA 时区，如 Asia/Shanghai / Europe/Berlin
  source_offset_minutes INTEGER NOT NULL,
  authored_at TEXT NOT NULL,            -- 离线时为声称完成时刻，否则=接收时刻
  submitted_at TEXT NOT NULL,          -- 服务器接收 UTC
  is_offline INTEGER NOT NULL DEFAULT 0,
  submitter_id TEXT NOT NULL REFERENCES users(id),
  closes_gap_ids_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (deliverable_id, seq),
  UNIQUE (deliverable_id, submitter_id, content_hash, authored_at) -- 重复回执：同作者同内容同时刻只入账一次
);

-- ============ 签收决定（只追加） ============
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('mentor', 'enterprise_reviewer', 'academic_admin')),
  kind TEXT NOT NULL CHECK (kind IN (
    'approved', 'conditional', 'rejected',
    'partial_return', 'dispute',
    'dispute_upheld', 'dispute_rejected',
    'reopened_after_issue', 'forced_approval'
  )),
  comment TEXT,
  based_on_submission_id TEXT REFERENCES submissions(id),
  rule_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  superseded_by TEXT,                   -- 被同方后续决定/裁决取代时回填（行不删除）
  is_effective INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_decisions_deliv ON decisions(deliverable_id);

-- ============ 缺口（团队成果可拆到个人） ============
CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  raised_by_decision_id TEXT NOT NULL REFERENCES decisions(id),
  assignee_user_id TEXT REFERENCES users(id),  -- NULL = 团队共同负责
  assignee_team_id TEXT REFERENCES teams(id),
  description TEXT NOT NULL,
  due_at TEXT,                          -- SLA 时刻（NULL=无独立时限，跟随节点截止时间）
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'waived', 'dismissed')),
  closed_by_submission_id TEXT REFERENCES submissions(id),
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_gaps_deliv ON gaps(deliverable_id);

-- ============ 争议与裁决 ============
CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  gap_id TEXT REFERENCES gaps(id),
  raised_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'rejected')),
  decision_id TEXT NOT NULL REFERENCES decisions(id), -- 企业发起争议时写入的 dispute 决定
  resolved_by TEXT REFERENCES users(id),
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
);

-- ============ 豁免（机构退出/教务显式豁免，均留痕） ============
CREATE TABLE signoff_waivers (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  party TEXT NOT NULL,                  -- mentor:<uid> / enterprise / student:<uid> / deliverable
  reason TEXT NOT NULL,                 -- org_withdrawal / admin_waive
  ref_id TEXT,                          -- 例如 withdrawal id
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES users(id),
  UNIQUE (deliverable_id, party)
);

-- ============ SLA 逾期事件（冻结在当时规则/截止版本） ============
CREATE TABLE sla_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('submit', 'resubmit', 'gap_close', 'review')),
  actor_user_id TEXT REFERENCES users(id),
  actor_org_id TEXT REFERENCES organizations(id),
  party TEXT NOT NULL CHECK (party IN ('student', 'mentor', 'enterprise')),
  due_at TEXT,
  deadline_version INTEGER,
  rule_version INTEGER NOT NULL,
  effective_event_at TEXT NOT NULL,    -- 离线时取 authored_at
  recorded_at TEXT NOT NULL,
  late_minutes INTEGER NOT NULL,        -- 扣过宽限；<=0 表示准时
  responsible_party TEXT,              -- NULL=准时；否则 student/mentor/enterprise
  exempt_reason TEXT                    -- 如 org_withdrawal：本应逾期但豁免
);
CREATE INDEX ix_sla_batch ON sla_events(batch_id);

-- ============ 证书与撤销（只追加纠正） ============
CREATE TABLE certificates (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  deliverable_id TEXT NOT NULL REFERENCES deliverables(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  rule_version_at_issue INTEGER NOT NULL,
  deadline_version_at_issue INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'valid' CHECK (state IN ('valid', 'revoked'))
);
CREATE UNIQUE INDEX ux_cert_active
  ON certificates(batch_id, milestone_id, user_id) WHERE state = 'valid';

CREATE TABLE certificate_revocations (
  id TEXT PRIMARY KEY,
  certificate_id TEXT NOT NULL REFERENCES certificates(id),
  revoked_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  correction_decision_id TEXT REFERENCES decisions(id), -- 配套的新决定
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============ 结项档案 ============
CREATE TABLE batch_closures (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id),
  closed_at TEXT NOT NULL,
  closed_by TEXT REFERENCES users(id),
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL
);

-- 结项后的纠正只能追加（如证书撤销+新决定），哈希链接在档案之后
CREATE TABLE closure_addenda (
  id TEXT PRIMARY KEY,
  closure_id TEXT NOT NULL REFERENCES batch_closures(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- certificate_revocation / correction_decision / rule_note
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (closure_id, seq)
);

-- ============ 幂等操作（重复回执/离线重传） ============
CREATE TABLE idempotent_ops (
  idempotency_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
