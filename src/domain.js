// 成果签收协同领域服务：全部用例在显式事务内执行，保证并发与重复请求下的确定性。
import { newId, nowIso, DomainError, toUtcIso, normalizeTz, sha256 } from "./util.js";

const PARTY_BY_STAFF_ROLE = { mentor: "mentor", reviewer: "enterprise" };

export function createServices(db) {
  const get = (sql, ...params) => {
    const row = db.prepare(sql).get(...params);
    if (!row) throw new DomainError("NOT_FOUND", "记录不存在");
    return row;
  };

  const userById = (id) => get("SELECT * FROM users WHERE id = ?", id);
  const batchById = (id) => get("SELECT * FROM batches WHERE id = ?", id);
  const nodeById = (id) => get("SELECT * FROM nodes WHERE id = ?", id);
  const deliverableById = (id) => get("SELECT * FROM deliverables WHERE id = ?", id);

  const assertActive = (user) => {
    const inst = user.institution_id
      ? db.prepare("SELECT status FROM institutions WHERE id = ?").get(user.institution_id)
      : null;
    if (inst && inst.status === "exited") {
      throw new DomainError("INSTITUTION_EXITED", "所属机构已退出，不能再产生新动作");
    }
    if (!user.active) throw new DomainError("FORBIDDEN", "用户已停用");
  };

  const staffRow = (batchId, userId) =>
    db.prepare(
      "SELECT * FROM batch_staff WHERE batch_id = ? AND user_id = ?",
    ).get(batchId, userId);

  // ---------- IANA 时区下某一瞬间的偏移（分钟） ----------
  function tzOffsetMinutesAt(date, timeZone) {
    if (!timeZone || timeZone === "UTC") return 0;
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(
      dtf.formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]),
    );
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return (asUtc - date.getTime()) / 60000;
  }

  // 事件时间解析：带偏移的 ISO 直接换算；“墙上时间”按来源时区解释（两次迭代消除 DST 边界误差）。
  function resolveEventTime(input, sourceTz) {
    if (input instanceof Date) return input.toISOString();
    if (typeof input !== "string") throw new DomainError("VALIDATION", "时间格式不正确");
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(input)) return new Date(input).toISOString();
    let guess = Date.parse(`${input.replace(" ", "T")}Z`);
    if (Number.isNaN(guess)) throw new DomainError("VALIDATION", `无法解析时间: ${input}`);
    let off = tzOffsetMinutesAt(new Date(guess), sourceTz);
    let utc = guess - off * 60000;
    off = tzOffsetMinutesAt(new Date(utc), sourceTz);
    utc = guess - off * 60000;
    return new Date(utc).toISOString();
  }

  // ============================================================
  // 基础数据：机构 / 用户 / 批次 / 团队 / 授权 / 节点
  // ============================================================
  const createInstitution = ({ id, name }) => {
    db.prepare(
      "INSERT INTO institutions(id, name, created_at) VALUES (?,?,?)",
    ).run(id, name, nowIso());
    return db.prepare("SELECT * FROM institutions WHERE id = ?").get(id);
  };

  const createUser = ({ id, institutionId, name, role, timezone }) => {
    const tz = normalizeTz(timezone || "UTC");
    db.prepare(
      `INSERT INTO users(id, institution_id, name, role, timezone) VALUES (?,?,?,?,?)`,
    ).run(id, institutionId ?? null, name, role, tz);
    return userById(id);
  };

  const createBatch = ({ id, code, title, rules }) => {
    const json = JSON.stringify(rules ?? {});
    const at = nowIso();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO batches(id, code, title, rules, rules_version, created_at)
         VALUES (?,?,?,?,1,?)`,
      ).run(id, code, title, json, at);
      db.prepare(
        `INSERT INTO batch_rule_versions(batch_id, version, rules, enacted_by, effective_at, note)
         VALUES (?,1,?, 'system', ?, '建批规则')`,
      ).run(id, json, at);
    });
    tx();
    return batchById(id);
  };

  const updateBatchRules = (batchId, rules, note, actorId) => {
    const batch = batchById(batchId);
    if (batch.status !== "open") throw new DomainError("CONFLICT", "批次已关闭，不能再改规则");
    userById(actorId);
    const nextVersion = batch.rules_version + 1;
    const json = JSON.stringify(rules);
    const at = nowIso();
    db.prepare("UPDATE batches SET rules = ?, rules_version = ? WHERE id = ?")
      .run(json, nextVersion, batchId);
    db.prepare(
      `INSERT INTO batch_rule_versions(batch_id, version, rules, enacted_by, effective_at, note)
       VALUES (?,?,?,?,?,?)`,
    ).run(batchId, nextVersion, json, actorId, at, note ?? null);
    return { batchId, version: nextVersion, effectiveAt: at };
  };

  const addStaff = ({ batchId, userId, role, canScore = false, maxScore = null, scopeTeamId = null }) => {
    if (!PARTY_BY_STAFF_ROLE[role]) throw new DomainError("VALIDATION", "staff 角色必须是 mentor/reviewer");
    batchById(batchId); userById(userId);
    db.prepare(
      `INSERT INTO batch_staff(batch_id, user_id, role, can_score, max_score, scope_team_id, assigned_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(batch_id, user_id) DO UPDATE SET
         role=excluded.role, can_score=excluded.can_score,
         max_score=excluded.max_score, scope_team_id=excluded.scope_team_id`,
    ).run(batchId, userId, role, canScore ? 1 : 0, maxScore, scopeTeamId, nowIso());
    return staffRow(batchId, userId);
  };

  const createTeam = ({ id, batchId, name }) => {
    batchById(batchId);
    db.prepare("INSERT INTO teams(id, batch_id, name, created_at) VALUES (?,?,?,?)")
      .run(id, batchId, name, nowIso());
    return db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
  };

  const addTeamMember = (teamId, userId) => {
    get("SELECT * FROM teams WHERE id = ?", teamId);
    const u = userById(userId);
    if (u.role !== "student") throw new DomainError("VALIDATION", "仅学员可加入团队");
    db.prepare(
      `INSERT INTO team_members(team_id, user_id, joined_at) VALUES (?,?,?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET left_at = NULL`,
    ).run(teamId, userId, nowIso());
  };

  const isTeamMember = (teamId, userId) =>
    !!db.prepare(
      "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND left_at IS NULL",
    ).get(teamId, userId);

  const createNode = ({ id, batchId, code, title, deadlineAt, deadlineTz = "UTC", signingScope }) => {
    const batch = batchById(batchId);
    const tz = normalizeTz(deadlineTz);
    const deadline = resolveEventTime(deadlineAt, tz);
    const scope = signingScope ?? { parties: ["mentor", "enterprise"] };
    if (!Array.isArray(scope.parties) || scope.parties.length === 0) {
      throw new DomainError("VALIDATION", "签署范围必须包含至少一方");
    }
    db.prepare(
      `INSERT INTO nodes(id, batch_id, code, title, deadline_at, deadline_tz,
         signing_scope, rules_snapshot, rules_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, batchId, code, title, deadline, tz,
      JSON.stringify(scope), batch.rules, batch.rules_version, nowIso());
    return nodeById(id);
  };

  // 截止时间变更：必须给出责任方，写入不可追加修改的历史。
  const changeDeadline = ({ nodeId, newDeadlineAt, reason, responsibleParty, actorId }) => {
    const node = nodeById(nodeId);
    userById(actorId);
    const next = resolveEventTime(newDeadlineAt, node.deadline_tz);
    if (next === node.deadline_at) throw new DomainError("CONFLICT", "新截止时间与当前一致");
    const id = newId("dlc");
    db.prepare(
      `INSERT INTO deadline_changes(id, node_id, old_deadline_at, new_deadline_at,
         reason, responsible_party, changed_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, node.id, node.deadline_at, next, reason, responsibleParty, actorId, nowIso());
    db.prepare("UPDATE nodes SET deadline_at = ? WHERE id = ?").run(next, node.id);
    return db.prepare("SELECT * FROM deadline_changes WHERE id = ?").get(id);
  };

  // ============================================================
  // 成果与提交版本链
  // ============================================================
  const createDeliverable = ({ id, nodeId, teamId = null, ownerUserId = null, title, kind }) => {
    const node = nodeById(nodeId);
    if (kind === "team") {
      if (!teamId) throw new DomainError("VALIDATION", "团队成果必须指定 teamId");
      const team = get("SELECT * FROM teams WHERE id = ? AND batch_id = ?", teamId, node.batch_id);
      if (!team) throw new DomainError("VALIDATION", "团队不属于该批次");
    } else if (kind === "individual") {
      if (!ownerUserId) throw new DomainError("VALIDATION", "个人成果必须指定 ownerUserId");
      ownerUserId && userById(ownerUserId);
    } else {
      throw new DomainError("VALIDATION", "kind 必须是 team/individual");
    }
    db.prepare(
      `INSERT INTO deliverables(id, node_id, team_id, owner_user_id, title, kind, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, node.id, teamId, ownerUserId, title, kind, nowIso());
    return deliverableById(id);
  };

  // 提交（含离线补传）。client_event_id 提供幂等：同一端事件重放返回既有版本。
  const submitVersion = ({
    deliverableId, summary, sourceTz, submittedBy,
    clientEventId = null, occurredAt = null, isBackfill = false, predecessorId = null,
  }) => {
    if (!summary || !String(summary).trim()) throw new DomainError("VALIDATION", "内容摘要不能为空");
    const deliverable = deliverableById(deliverableId);
    if (deliverable.status === "revoked") {
      throw new DomainError("REVOKED", "成果已撤销，补交须提交到后继成果");
    }
    if (deliverable.certificate_counted) {
      throw new DomainError("CERT_LOCKED", "成果已计入证书，纠正须走撤销记录与新决定");
    }
    const node = nodeById(deliverable.node_id);
    const user = userById(submittedBy);
    assertActive(user);

    // 提交权限：团队成员 / 个人成果负责人 / 教务代办
    const isAdmin = user.role === "admin";
    if (!isAdmin) {
      if (deliverable.kind === "team" && !isTeamMember(deliverable.team_id, submittedBy)) {
        throw new DomainError("FORBIDDEN", "仅团队成员可提交该团队成果");
      }
      if (deliverable.kind === "individual" && deliverable.owner_user_id !== submittedBy) {
        throw new DomainError("FORBIDDEN", "仅负责人可提交该个人成果");
      }
    }

    if (clientEventId) {
      const existing = db.prepare(
        "SELECT * FROM submission_versions WHERE deliverable_id = ? AND client_event_id = ?",
      ).get(deliverableId, clientEventId);
      if (existing) return { ...existing, replayed: true };
    }

    const tz = normalizeTz(sourceTz || user.timezone || "UTC");
    const eventTime = resolveEventTime(occurredAt ?? new Date().toISOString(), tz);
    const receivedAt = nowIso();

    let predecessor = predecessorId
      ? get("SELECT * FROM submission_versions WHERE id = ?", predecessorId)
      : db.prepare(
          "SELECT * FROM submission_versions WHERE deliverable_id = ? ORDER BY version_no DESC LIMIT 1",
        ).get(deliverableId);
    if (predecessor && predecessor.deliverable_id !== deliverableId) {
      throw new DomainError("VALIDATION", "前序版本不属于该成果");
    }

    const tx = db.transaction(() => {
      const maxRow = db.prepare(
        "SELECT COALESCE(MAX(version_no),0) AS n FROM submission_versions WHERE deliverable_id = ?",
      ).get(deliverableId);
      const versionNo = maxRow.n + 1;
      const id = newId("ver");
      db.prepare(
        `INSERT INTO submission_versions(id, deliverable_id, version_no, content_summary,
           source_tz, predecessor_id, submitted_by, client_event_id,
           occurred_at, is_backfill, received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, deliverableId, versionNo, String(summary).trim(), tz,
        predecessor ? predecessor.id : null, submittedBy, clientEventId,
        eventTime, isBackfill ? 1 : 0, receivedAt);
      return db.prepare("SELECT * FROM submission_versions WHERE id = ?").get(id);
    });
    try {
      return tx();
    } catch (err) {
      // 并发下唯一键竞争：重放既有事件，保证确定性。
      if (clientEventId && String(err.message).includes("UNIQUE")) {
        return db.prepare(
          "SELECT * FROM submission_versions WHERE deliverable_id = ? AND client_event_id = ?",
        ).get(deliverableId, clientEventId);
      }
      throw err;
    }
  };

  // ============================================================
  // 签收 / 附条件通过 / 局部退回 / 争议
  // ============================================================
  function assertSigner({ node, deliverable, signerUserId, party, score }) {
    const user = userById(signerUserId);
    assertActive(user);
    const staff = staffRow(node.batch_id, signerUserId);
    if (!staff || PARTY_BY_STAFF_ROLE[staff.role] !== party) {
      throw new DomainError("FORBIDDEN", `该用户不是本批次的${party === "mentor" ? "导师" : "企业复核"}`);
    }
    if (staff.scope_team_id !== null && staff.scope_team_id !== deliverable.team_id) {
      throw new DomainError("FORBIDDEN", "签署人无权签收该团队范围外的成果");
    }
    const scope = JSON.parse(node.signing_scope);
    if (!scope.parties.includes(party)) {
      throw new DomainError("OUT_OF_SCOPE", "本方不在节点签署范围内");
    }
    if (score !== null && score !== undefined) {
      if (!staff.can_score) throw new DomainError("FORBIDDEN", "该导师没有评分权限");
      if (staff.max_score !== null && score > staff.max_score) {
        throw new DomainError("FORBIDDEN", `评分超出授权上限 ${staff.max_score}`);
      }
    }
    return staff;
  }

  function insertGap({ deliverableId, versionId, signoffId, party, signerId, assigneeUserId, title, detail, dueAt }) {
    const id = newId("gap");
    db.prepare(
      `INSERT INTO gaps(id, deliverable_id, version_id, signoff_id, created_by_party,
         created_by, assignee_user_id, title, detail, due_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, deliverableId, versionId ?? null, signoffId, party, signerId,
      assigneeUserId ?? null, title, detail ?? null, dueAt ?? null, nowIso());
    return id;
  }

  // 通用签收登记。decision: approved | conditional | returned | partial_return | disputed
  // receiptKey 去重；gaps 用于 conditional/partial_return；disputeReason 用于 disputed。
  const recordSignoff = ({
    nodeId, deliverableId, signerUserId, party, decision,
    score = null, comment = null, receiptKey, versionId = null,
    gaps = [], disputeReason = null,
  }) => {
    if (!receiptKey) throw new DomainError("VALIDATION", "回执必须带 receiptKey");
    const node = nodeById(nodeId);
    const deliverable = deliverableById(deliverableId);
    if (deliverable.node_id !== nodeId) throw new DomainError("VALIDATION", "成果与节点不匹配");
    if (deliverable.status === "revoked") throw new DomainError("REVOKED", "成果已撤销");
    if (deliverable.certificate_counted) {
      throw new DomainError("CERT_LOCKED", "成果已计入证书，纠正须走撤销记录与新决定");
    }
    assertSigner({ node, deliverable, signerUserId, party, score });
    if (versionId) {
      const v = get("SELECT * FROM submission_versions WHERE id = ?", versionId);
      if (v.deliverable_id !== deliverableId) throw new DomainError("VALIDATION", "回执版本与成果不匹配");
    }

    // 重复回执：同节点同签署人同回执号只承认一次，原样回放，不产生副作用。
    const dup = db.prepare(
      "SELECT * FROM signoffs WHERE node_id = ? AND signer_user_id = ? AND receipt_key = ?",
    ).get(nodeId, signerUserId, receiptKey);
    if (dup) return { ...dup, replayed: true };

    const valid = ["approved", "conditional", "returned", "partial_return", "disputed"];
    if (!valid.includes(decision)) throw new DomainError("VALIDATION", `未知决定 ${decision}`);
    if (decision === "disputed" && !disputeReason) {
      throw new DomainError("VALIDATION", "争议必须填写原因");
    }

    const tx = db.transaction(() => {
      const id = newId("sig");
      db.prepare(
        `INSERT INTO signoffs(id, node_id, deliverable_id, signer_user_id, party,
           decision, score, comment, receipt_key, version_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, nodeId, deliverableId, signerUserId, party, decision,
        score, comment, receiptKey, versionId, nowIso());

      // 同一方重新签收：其此前遗留的开放/冻结缺口作废，以本次决定为准。
      db.prepare(
        `UPDATE gaps SET status = 'void'
         WHERE deliverable_id = ? AND created_by_party = ?
           AND status IN ('open','frozen') AND signoff_id IS NOT NULL AND signoff_id <> ?`,
      ).run(deliverableId, party, id);

      if (decision === "conditional" || decision === "partial_return" || decision === "returned") {
        if (!gaps.length) throw new DomainError("VALIDATION", "非通过决定必须列明整改缺口");
        for (const g of gaps) {
          let assignee = g.assigneeUserId ?? null;
          if (deliverable.kind === "individual") {
            // 个人成果的整改缺口只能属于成果负责人。
            if (assignee && assignee !== deliverable.owner_user_id) {
              throw new DomainError("VALIDATION", "个人成果缺口只能分派给负责人");
            }
            assignee = deliverable.owner_user_id;
          } else if (assignee && !isTeamMember(deliverable.team_id, assignee)) {
            throw new DomainError("VALIDATION", "缺口负责人不是该团队学员");
          }
          if (decision === "partial_return" && !assignee) {
            throw new DomainError("VALIDATION", "局部退回必须把缺口落实到具体学员");
          }
          insertGap({
            deliverableId, versionId, signoffId: id, party, signerId: signerUserId,
            assigneeUserId: assignee, title: g.title, detail: g.detail, dueAt: g.dueAt ?? null,
          });
        }
      }

      if (decision === "approved") {
        // 通过：关闭本方在该成果上仍开放的缺口。
        db.prepare(
          `UPDATE gaps SET status = 'closed', closed_at = ?, closed_by = ?
           WHERE deliverable_id = ? AND status = 'open' AND created_by_party = ?`,
        ).run(nowIso(), signerUserId, deliverableId, party);
      }

      if (decision === "disputed") {
        db.prepare(
          `INSERT INTO disputes(id, deliverable_id, signoff_id, raised_by, reason, created_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(newId("dsp"), deliverableId, id, signerUserId, disputeReason, nowIso());
      }
      return db.prepare("SELECT * FROM signoffs WHERE id = ?").get(id);
    });
    return tx();
  };

  // 企业把一个团队缺口拆成个人整改：原团队缺口作废，生成若干个人缺口。
  const splitTeamGap = ({ gapId, reviewerUserId, assignments }) => {
    const gap = get("SELECT * FROM gaps WHERE id = ?", gapId);
    const deliverable = deliverableById(gap.deliverable_id);
    const node = nodeById(deliverable.node_id);
    const reviewer = userById(reviewerUserId);
    assertActive(reviewer);
    const staff = staffRow(node.batch_id, reviewerUserId);
    if (!staff || staff.role !== "reviewer") throw new DomainError("FORBIDDEN", "仅企业复核可拆单");
    if (gap.status !== "open" || gap.assignee_user_id) {
      throw new DomainError("CONFLICT", "只能拆分尚未落实到人的开放团队缺口");
    }
    if (!Array.isArray(assignments) || !assignments.length) {
      throw new DomainError("VALIDATION", "拆单必须指定学员");
    }
    return db.transaction(() => {
      db.prepare("UPDATE gaps SET status = 'void' WHERE id = ?").run(gapId);
      const ids = assignments.map((a) => {
        if (deliverable.kind === "team" && !isTeamMember(deliverable.team_id, a.userId)) {
          throw new DomainError("VALIDATION", "被分派学员不在团队中");
        }
        return insertGap({
          deliverableId: deliverable.id, versionId: gap.version_id, signoffId: gap.signoff_id,
          party: "enterprise", signerId: reviewerUserId,
          assigneeUserId: a.userId, title: a.title ?? gap.title,
          detail: a.detail ?? gap.detail, dueAt: a.dueAt ?? gap.due_at,
        });
      });
      return { voidedGap: gapId, newGapIds: ids };
    })();
  };

  // 学员补交后关闭缺口：
  //  - 个人缺口（assignee 非空）：只能由本人用本人提交的版本关闭；
  //  - 团队缺口（assignee 为空）：可由团队任一成员用其本人提交的版本关闭。
  const closeGapWithSubmission = ({ gapId, studentUserId, versionId }) => {
    const gap = get("SELECT * FROM gaps WHERE id = ?", gapId);
    const student = userById(studentUserId);
    assertActive(student);
    const deliverable = deliverableById(gap.deliverable_id);
    if (gap.assignee_user_id === null) {
      if (deliverable.kind !== "team" || !isTeamMember(deliverable.team_id, studentUserId)) {
        throw new DomainError("FORBIDDEN", "仅该团队成员可关闭团队缺口");
      }
    } else if (gap.assignee_user_id !== studentUserId) {
      throw new DomainError("FORBIDDEN", "学员只能关闭自己负责的缺口");
    }
    if (gap.status === "void") throw new DomainError("CONFLICT", "缺口已作废");
    if (gap.status === "waived") throw new DomainError("CONFLICT", "缺口已随机构退出豁免");
    if (gap.status === "frozen") throw new DomainError("FROZEN", "缺口已冻结，须先解除争议或走撤销纠正");
    if (gap.status === "closed") return { ...gap, replayed: true };
    const version = get("SELECT * FROM submission_versions WHERE id = ?", versionId);
    if (version.deliverable_id !== gap.deliverable_id) {
      throw new DomainError("VALIDATION", "补交版本与缺口不属于同一成果");
    }
    if (version.submitted_by !== studentUserId) {
      throw new DomainError("FORBIDDEN", "须由本人提交的版本关闭缺口");
    }
    db.prepare(
      `UPDATE gaps SET status = 'closed', closed_at = ?, closed_by = ?, closed_by_version_id = ?
       WHERE id = ?`,
    ).run(nowIso(), studentUserId, versionId, gapId);
    return db.prepare("SELECT * FROM gaps WHERE id = ?").get(gapId);
  };

  const resolveDispute = ({ disputeId, outcome, resolution, deciderUserId }) => {
    const dispute = get("SELECT * FROM disputes WHERE id = ?", disputeId);
    if (dispute.status !== "open") throw new DomainError("CONFLICT", "争议已裁决");
    if (!["upheld", "rejected", "withdrawn"].includes(outcome)) {
      throw new DomainError("VALIDATION", "裁决结果非法");
    }
    userById(deciderUserId);
    db.prepare(
      `UPDATE disputes SET status = ?, resolution = ?, decided_by = ?, decided_at = ?
       WHERE id = ?`,
    ).run(outcome, resolution ?? null, deciderUserId, nowIso(), disputeId);
    if (outcome === "upheld") {
      // 争议成立：冻结该成果上的开放缺口（含团队缺口），等待该方重新签收。
      const disputed = get("SELECT * FROM signoffs WHERE id = ?", dispute.signoff_id);
      db.prepare(
        "UPDATE gaps SET status = 'frozen' WHERE deliverable_id = ? AND status = 'open'",
      ).run(disputed.deliverable_id);
    }
    return db.prepare("SELECT * FROM disputes WHERE id = ?").get(disputeId);
  };

  // ============================================================
  // 机构退出：确定性冻结
  // ============================================================
  const exitInstitution = ({ institutionId, batchId = null, reason = null, effectiveAt = null, actorId }) => {
    const inst = get("SELECT * FROM institutions WHERE id = ?", institutionId);
    if (inst.status === "exited") throw new DomainError("CONFLICT", "机构已退出");
    userById(actorId);
    const at = effectiveAt ? new Date(effectiveAt).toISOString() : nowIso();
    return db.transaction(() => {
      db.prepare("UPDATE institutions SET status = 'exited', exited_at = ? WHERE id = ?")
        .run(at, institutionId);
      db.prepare("UPDATE users SET active = 0 WHERE institution_id = ?").run(institutionId);
      db.prepare(
        `INSERT INTO institution_exits(id, institution_id, batch_id, reason, effective_at, created_by)
         VALUES (?,?,?,?,?,?)`,
      ).run(newId("ext"), institutionId, batchId, reason, at, actorId);

      // 退出机构学员/签署人名下的开放缺口豁免：不再拖累结项，但留痕可审计。
      db.prepare(
        `UPDATE gaps SET status = 'waived'
         WHERE status = 'open' AND assignee_user_id IN (
           SELECT id FROM users WHERE institution_id = ?
         )`,
      ).run(institutionId);
      return { institutionId, effectiveAt: at };
    })();
  };

  // ============================================================
  // 证书计入 / 撤销 + 新决定
  // ============================================================
  function latestDecisions(deliverableId) {
    const rows = db.prepare(
      "SELECT * FROM signoffs WHERE deliverable_id = ? ORDER BY created_at, rowid",
    ).all(deliverableId);
    const byParty = {};
    for (const r of rows) byParty[r.party] = r; // 最后一条为准
    // 撤销重裁产生的新决定（针对后继成果）同样计入对应方。
    const ndRows = db.prepare(
      "SELECT * FROM new_decisions WHERE successor_deliverable_id = ? ORDER BY created_at, rowid",
    ).all(deliverableId);
    for (const nd of ndRows) {
      const staff = db.prepare(
        `SELECT bs.role FROM batch_staff bs
         JOIN deliverables d ON d.id = ?
         JOIN nodes n ON n.id = d.node_id AND n.batch_id = bs.batch_id
         WHERE bs.user_id = ?`,
      ).get(deliverableId, nd.decided_by);
      const party = staff ? PARTY_BY_STAFF_ROLE[staff.role] : null;
      if (party) byParty[party] = { ...nd, decision: nd.decision, via_new_decision: true };
    }
    return byParty;
  }

  // 某方在该成果上仍可履行签收义务的候选人（考虑团队范围与机构退出）。
  function activeSignersForParty(party, node, deliverable) {
    const role = party === "mentor" ? "mentor" : "reviewer";
    const rows = db.prepare("SELECT * FROM batch_staff WHERE batch_id = ? AND role = ?")
      .all(node.batch_id, role);
    return rows.filter((s) =>
      s.scope_team_id === null || s.scope_team_id === deliverable.team_id)
      .map((s) => userById(s.user_id))
      .filter((u) => u.active);
  }

  const certificateEligibility = (deliverableId) => {
    const deliverable = deliverableById(deliverableId);
    const node = nodeById(deliverable.node_id);
    const scope = JSON.parse(node.signing_scope);
    const decisions = latestDecisions(deliverableId);
    const missingParties = [];
    const waivedParties = [];
    const blockedParties = [];
    for (const party of scope.parties) {
      const d = decisions[party];
      if (!d) {
        // 该方已无任何在职签署人（机构退出）→ 豁免该方，不永久阻塞结项。
        if (activeSignersForParty(party, node, deliverable).length === 0) waivedParties.push(party);
        else missingParties.push(party);
        continue;
      }
      if (!["approved", "conditional"].includes(d.decision)) blockedParties.push(party);
    }
    const openGaps = db.prepare(
      "SELECT * FROM gaps WHERE deliverable_id = ? AND status IN ('open','frozen')",
    ).all(deliverableId);
    const waivedGaps = db.prepare(
      "SELECT COUNT(*) AS n FROM gaps WHERE deliverable_id = ? AND status = 'waived'",
    ).get(deliverableId).n;
    return {
      eligible: missingParties.length === 0 && blockedParties.length === 0 && openGaps.length === 0,
      missingParties, waivedParties, blockedParties,
      openGapCount: openGaps.length, waivedGapCount: waivedGaps,
    };
  };

  const countCertificate = ({ batchId, userId, deliverableId, versionId }) => {
    batchById(batchId); userById(userId);
    const deliverable = deliverableById(deliverableId);
    const node = nodeById(deliverable.node_id);
    if (node.batch_id !== batchId) throw new DomainError("VALIDATION", "成果不在该批次");
    const eligibility = certificateEligibility(deliverableId);
    if (!eligibility.eligible) {
      throw new DomainError("NOT_ELIGIBLE", "成果尚未满足计入证书条件", eligibility);
    }
    const version = get("SELECT * FROM submission_versions WHERE id = ?", versionId);
    if (version.deliverable_id !== deliverableId) throw new DomainError("VALIDATION", "版本与成果不匹配");
    if (deliverable.certificate_counted) throw new DomainError("CONFLICT", "该成果已计入证书");

    return db.transaction(() => {
      const id = newId("crt");
      db.prepare(
        `INSERT INTO certificate_records(id, batch_id, user_id, deliverable_id, version_id, issued_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(id, batchId, userId, deliverableId, versionId, nowIso());
      db.prepare("UPDATE deliverables SET certificate_counted = 1 WHERE id = ?").run(deliverableId);
      // 计入即冻结残余开放状态。
      db.prepare(
        "UPDATE gaps SET status = 'frozen' WHERE deliverable_id = ? AND status = 'open'",
      ).run(deliverableId);
      return db.prepare("SELECT * FROM certificate_records WHERE id = ?").get(id);
    })();
  };

  // 已计证书成果只能“撤销记录 + 新决定”：创建后继成果承接整改。
  const revokeForCorrection = ({ deliverableId, reason, adminUserId }) => {
    const deliverable = deliverableById(deliverableId);
    const admin = userById(adminUserId);
    if (admin.role !== "admin") throw new DomainError("FORBIDDEN", "仅教务可发起撤销");
    if (!deliverable.certificate_counted) {
      throw new DomainError("CONFLICT", "仅已计入证书的成果需要走撤销纠正");
    }
    return db.transaction(() => {
      const cert = db.prepare(
        "SELECT * FROM certificate_records WHERE deliverable_id = ? AND status = 'counted' ORDER BY issued_at DESC LIMIT 1",
      ).get(deliverableId);
      const revId = newId("rev");
      db.prepare(
        `INSERT INTO revocations(id, deliverable_id, certificate_id, reason, revoked_by, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(revId, deliverableId, cert ? cert.id : null, reason, adminUserId, nowIso());
      db.prepare("UPDATE deliverables SET status = 'revoked' WHERE id = ?").run(deliverableId);
      if (cert) db.prepare("UPDATE certificate_records SET status = 'revoked' WHERE id = ?").run(cert.id);

      // 后继成果承接：冻结缺口重新开放到新成果上。
      const succId = newId("dlv");
      db.prepare(
        `INSERT INTO deliverables(id, node_id, team_id, owner_user_id, title, kind,
           predecessor_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(succId, deliverable.node_id, deliverable.team_id, deliverable.owner_user_id,
        `${deliverable.title}（撤销重裁）`, deliverable.kind, deliverableId, nowIso());
      const frozen = db.prepare(
        "SELECT * FROM gaps WHERE deliverable_id = ? AND status = 'frozen'",
      ).all(deliverableId);
      for (const g of frozen) {
        insertGap({
          deliverableId: succId, versionId: null, signoffId: null,
          party: g.created_by_party, signerId: g.created_by,
          assigneeUserId: g.assignee_user_id, title: g.title, detail: g.detail, dueAt: g.due_at,
        });
      }
      return {
        revocationId: revId, successorDeliverableId: succId,
        reopenedGapCount: frozen.length,
      };
    })();
  };

  // 撤销后的新决定（针对后继成果）。
  const recordNewDecision = ({
    revocationId, successorDeliverableId, deciderUserId, decision,
    score = null, comment = null, versionId = null, gaps = [],
  }) => {
    const revocation = get("SELECT * FROM revocations WHERE id = ?", revocationId);
    const successor = deliverableById(successorDeliverableId);
    if (successor.predecessor_id !== revocation.deliverable_id) {
      throw new DomainError("VALIDATION", "该成果不是本次撤销的后继成果");
    }
    const node = nodeById(successor.node_id);
    const decider = userById(deciderUserId);
    assertActive(decider);
    const staff = staffRow(node.batch_id, deciderUserId);
    if (!staff) throw new DomainError("FORBIDDEN", "新决定必须由批次签署方人员作出");
    if (staff.scope_team_id !== null && staff.scope_team_id !== successor.team_id) {
      throw new DomainError("FORBIDDEN", "签署人无权决定该团队范围外的成果");
    }
    const party = PARTY_BY_STAFF_ROLE[staff.role];
    if (score !== null && score !== undefined) {
      if (!staff.can_score) throw new DomainError("FORBIDDEN", "没有评分权限");
      if (staff.max_score !== null && score > staff.max_score) {
        throw new DomainError("FORBIDDEN", `评分超出授权上限 ${staff.max_score}`);
      }
    }
    if (!["approved", "conditional", "returned", "partial_return", "disputed"].includes(decision)) {
      throw new DomainError("VALIDATION", "未知决定");
    }
    if (versionId) {
      const v = get("SELECT * FROM submission_versions WHERE id = ?", versionId);
      if (v.deliverable_id !== successorDeliverableId) throw new DomainError("VALIDATION", "版本不属于后继成果");
    }
    return db.transaction(() => {
      const id = newId("nd");
      db.prepare(
        `INSERT INTO new_decisions(id, revocation_id, successor_deliverable_id, decision,
           score, comment, version_id, decided_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(id, revocationId, successorDeliverableId, decision,
        score, comment, versionId, deciderUserId, nowIso());
      if (["conditional", "returned", "partial_return"].includes(decision)) {
        if (!gaps.length) throw new DomainError("VALIDATION", "非通过决定必须列明缺口");
        for (const g of gaps) {
          let assignee = g.assigneeUserId ?? null;
          if (successor.kind === "individual") {
            if (assignee && assignee !== successor.owner_user_id) {
              throw new DomainError("VALIDATION", "个人成果缺口只能分派给负责人");
            }
            assignee = successor.owner_user_id;
          } else if (assignee && !isTeamMember(successor.team_id, assignee)) {
            throw new DomainError("VALIDATION", "缺口负责人不是该团队学员");
          }
          if (decision === "partial_return" && !assignee) {
            throw new DomainError("VALIDATION", "局部退回必须把缺口落实到具体学员");
          }
          insertGap({
            deliverableId: successorDeliverableId, versionId, signoffId: null,
            party, signerId: deciderUserId, assigneeUserId: assignee,
            title: g.title, detail: g.detail, dueAt: g.dueAt ?? null,
          });
        }
      }
      if (decision === "approved") {
        db.prepare(
          "UPDATE gaps SET status = 'closed', closed_at = ?, closed_by = ? WHERE deliverable_id = ? AND status = 'open' AND created_by_party = ?",
        ).run(nowIso(), deciderUserId, successorDeliverableId, party);
      }
      return db.prepare("SELECT * FROM new_decisions WHERE id = ?").get(id);
    })();
  };

  // ============================================================
  // 逾期归因
  // ============================================================
  const deadlineHistory = (nodeId) =>
    db.prepare("SELECT * FROM deadline_changes WHERE node_id = ? ORDER BY created_at").all(nodeId);

  // dueAt：缺口自身期限；null 表示跟随节点截止时间。workAt：事件发生时刻（补交/关闭），null=仍未完成。
  // 归因规则（按评估时刻 T 已生效的改期计划判定）：
  //  1. T <= 当前生效截止时间 D → 未逾期；
  //  2. 逾期且截止时间曾被【提前】（D < 原期限 O），且 T <= O → 改期责任方
  //     （学员按原计划仍准时，逾期由提前改期一方造成）；
  //  3. 其余逾期（无改期，或延期后仍超过延期期限 D）→ student；
  //  延后改期只用于解除“当前逾期”状态并留痕审计，不能为错过最终期限的学员免责。
  function attributeOverdue({ nodeId, dueAt, workAt }) {
    const node = nodeById(nodeId);
    const reference = workAt ?? nowIso();
    const refMs = new Date(reference).getTime();

    if (dueAt) {
      const dueMs = new Date(dueAt).getTime();
      if (refMs <= dueMs) {
        return { overdue: false, dueAt, workAt: reference, responsibleParty: null };
      }
      // 缺口自带期限：不因节点整体改期而变动，逾期责任落在负责人一方。
      return { overdue: true, dueAt, workAt: reference, responsibleParty: "student" };
    }

    const changes = deadlineHistory(nodeId)
      .filter((c) => new Date(c.created_at).getTime() <= refMs)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const last = changes[changes.length - 1];
    const currentDue = last ? last.new_deadline_at : node.deadline_at;

    if (refMs <= new Date(currentDue).getTime()) {
      return { overdue: false, dueAt: currentDue, workAt: reference, responsibleParty: null };
    }

    let party = "student";
    if (last && last.old_deadline_at &&
        new Date(last.new_deadline_at).getTime() < new Date(last.old_deadline_at).getTime() &&
        refMs <= new Date(last.old_deadline_at).getTime()) {
      party = last.responsible_party;
    }
    return { overdue: true, dueAt: currentDue, workAt: reference, responsibleParty: party };
  }

  // ============================================================
  // 批次结项看板
  // ============================================================
  const dashboard = (batchId) => {
    const batch = batchById(batchId);
    const nodes = db.prepare("SELECT * FROM nodes WHERE batch_id = ? ORDER BY created_at").all(batchId);
    const staff = db.prepare("SELECT * FROM batch_staff WHERE batch_id = ?").all(batchId);

    const exitedInstitutions = new Set(
      db.prepare("SELECT institution_id FROM institution_exits WHERE batch_id IS NULL OR batch_id = ?")
        .all(batchId).map((r) => r.institution_id),
    );

    const result = [];
    for (const node of nodes) {
      const scope = JSON.parse(node.signing_scope);
      const deliverables = db.prepare("SELECT * FROM deliverables WHERE node_id = ?").all(node.id);
      const nodeView = {
        nodeId: node.id, code: node.code, title: node.title,
        deadlineAt: node.deadline_at, deadlineTz: node.deadline_tz,
        signingScope: scope.parties, deliverables: [],
      };

      for (const d of deliverables) {
        const signoffs = db.prepare(
          "SELECT * FROM signoffs WHERE deliverable_id = ? ORDER BY created_at, rowid",
        ).all(d.id);
        const latestByUser = new Map();
        for (const s of signoffs) latestByUser.set(s.signer_user_id, s);
        // 后继成果上的新决定同样构成该方当前决定。
        for (const nd of db.prepare(
          "SELECT * FROM new_decisions WHERE successor_deliverable_id = ?",
        ).all(d.id)) {
          const staff = db.prepare(
            `SELECT bs.role FROM batch_staff bs
             JOIN nodes n ON n.id = ? AND n.batch_id = bs.batch_id
             WHERE bs.user_id = ?`,
          ).get(d.node_id, nd.decided_by);
          if (staff) latestByUser.set(nd.decided_by, { party: PARTY_BY_STAFF_ROLE[staff.role], decision: nd.decision });
        }
        const CONFIRMING = new Set(["approved", "conditional"]);

        // 尚缺谁的确认：签署范围内负有签收义务的人员，其当前决定不是通过/附条件通过即视为未确认。
        const missingConfirmations = [];
        for (const party of scope.parties) {
          const role = party === "mentor" ? "mentor" : "reviewer";
          const candidates = staff.filter((s) => s.role === role &&
            (s.scope_team_id === null || s.scope_team_id === d.team_id));
          for (const c of candidates) {
            const u = userById(c.user_id);
            const waived = u.institution_id && exitedInstitutions.has(u.institution_id);
            const latest = latestByUser.get(c.user_id);
            const confirmed = latest && CONFIRMING.has(latest.decision);
            if (!confirmed) {
              missingConfirmations.push({
                party, userId: c.user_id, name: u.name,
                currentDecision: latest ? latest.decision : null,
                waived: !!waived, waivedBy: waived ? "institution" : null,
              });
            }
          }
        }

        const gaps = db.prepare("SELECT * FROM gaps WHERE deliverable_id = ?").all(d.id);
        const gapViews = gaps.map((g) => {
          let attribution = null;
          if (g.status === "open") {
            attribution = attributeOverdue({
              nodeId: node.id, dueAt: g.due_at, workAt: null,
            });
          } else if (g.status === "closed" && g.closed_by_version_id) {
            const v = db.prepare("SELECT * FROM submission_versions WHERE id = ?")
              .get(g.closed_by_version_id);
            attribution = attributeOverdue({
              nodeId: node.id, dueAt: g.due_at, workAt: v.occurred_at,
            });
          }
          return {
            gapId: g.id, status: g.status, title: g.title,
            assigneeUserId: g.assignee_user_id,
            overdue: attribution ? attribution.overdue : false,
            responsibleParty: attribution ? attribution.responsibleParty : null,
            dueAt: attribution ? attribution.dueAt : (g.due_at ?? node.deadline_at),
          };
        });

        // 成果级逾期：以最近版本事件时间判定（离线补传按事件发生时刻而非接收时刻）。
        const latestVersion = db.prepare(
          "SELECT * FROM submission_versions WHERE deliverable_id = ? ORDER BY version_no DESC LIMIT 1",
        ).get(d.id);
        const deliverableAttribution = latestVersion
          ? attributeOverdue({ nodeId: node.id, dueAt: null, workAt: latestVersion.occurred_at })
          : attributeOverdue({ nodeId: node.id, dueAt: null, workAt: null });

        nodeView.deliverables.push({
          deliverableId: d.id, title: d.title, kind: d.kind,
          teamId: d.team_id, ownerUserId: d.owner_user_id,
          status: d.status, certificateCounted: !!d.certificate_counted,
          predecessorId: d.predecessor_id,
          latestVersionNo: latestVersion ? latestVersion.version_no : null,
          overdue: deliverableAttribution.overdue,
          responsibleParty: deliverableAttribution.responsibleParty,
          missingConfirmations,
          gaps: gapViews,
        });
      }
      result.push(nodeView);
    }

    const responsibilityTally = {};
    const tally = (party) => {
      if (party) responsibilityTally[party] = (responsibilityTally[party] ?? 0) + 1;
    };
    for (const n of result) for (const d of n.deliverables) {
      tally(d.responsibleParty);
      for (const g of d.gaps) if (g.overdue) tally(g.responsibleParty);
    }

    return {
      batchId, batchStatus: batch.status,
      rulesVersion: batch.rules_version,
      nodes: result,
      overdueResponsibility: responsibilityTally,
    };
  };

  // ============================================================
  // 结项档案导出：与“当时规则 + 签署范围”一致的不可变快照
  // ============================================================
  const exportArchive = ({ batchId, actorId }) => {
    const batch = batchById(batchId);
    const actor = userById(actorId);
    if (actor.role !== "admin") throw new DomainError("FORBIDDEN", "仅教务可导出结项档案");

    const nodes = db.prepare("SELECT * FROM nodes WHERE batch_id = ? ORDER BY created_at").all(batchId);
    const nodeData = nodes.map((node) => {
      const deliverables = db.prepare("SELECT * FROM deliverables WHERE node_id = ?").all(node.id);
      return {
        node: {
          id: node.id, code: node.code, title: node.title,
          deadlineAt: node.deadline_at, deadlineTz: node.deadline_tz,
          signingScope: JSON.parse(node.signing_scope),
          rulesVersion: node.rules_version,
          rulesSnapshot: JSON.parse(node.rules_snapshot), // 节点生效时的规则
        },
        deadlineChanges: deadlineHistory(node.id),
        deliverables: deliverables.map((d) => ({
          ...d,
          versions: db.prepare("SELECT * FROM submission_versions WHERE deliverable_id = ? ORDER BY version_no").all(d.id),
          signoffs: db.prepare("SELECT * FROM signoffs WHERE deliverable_id = ? ORDER BY created_at").all(d.id),
          gaps: db.prepare("SELECT * FROM gaps WHERE deliverable_id = ? ORDER BY created_at").all(d.id),
          disputes: db.prepare("SELECT * FROM disputes WHERE deliverable_id = ? ORDER BY created_at").all(d.id),
          revocations: db.prepare("SELECT * FROM revocations WHERE deliverable_id = ? ORDER BY created_at").all(d.id)
            .map((r) => ({
              ...r,
              newDecisions: db.prepare("SELECT * FROM new_decisions WHERE revocation_id = ? ORDER BY created_at").all(r.id),
            })),
          certificates: db.prepare("SELECT * FROM certificate_records WHERE deliverable_id = ? ORDER BY issued_at").all(d.id),
        })),
      };
    });

    const archive = {
      batch: {
        id: batch.id, code: batch.code, title: batch.title,
        statusAtExport: batch.status, closedAt: batch.closed_at,
        rulesVersion: batch.rules_version,
      },
      ruleHistory: db.prepare(
        "SELECT version, rules, enacted_by, effective_at, note FROM batch_rule_versions WHERE batch_id = ? ORDER BY version",
      ).all(batchId).map((r) => ({ ...r, rules: JSON.parse(r.rules) })),
      nodes: nodeData,
      institutionExits: db.prepare(
        "SELECT * FROM institution_exits WHERE batch_id IS NULL OR batch_id = ?",
      ).all(batchId),
      dashboard: dashboard(batchId),
      exportedAt: nowIso(),
    };

    // manifest：逐节点摘要与哈希；content_hash 锚定整体内容。
    const manifest = nodeData.map((nd) => ({
      nodeId: nd.node.id,
      signingScope: nd.node.signingScope,
      rulesVersion: nd.node.rulesVersion,
      deliverableIds: nd.deliverables.map((d) => d.id),
      hash: sha256(JSON.stringify(nd)),
    }));
    const contentHash = sha256(JSON.stringify({ archive, manifest }));

    const id = newId("arc");
    db.prepare(
      `INSERT INTO archive_exports(id, batch_id, batch_status_at_export, rules_version,
         rules_snapshot, manifest, content_hash, exported_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, batchId, batch.status, batch.rules_version, batch.rules,
      JSON.stringify(manifest), contentHash, actorId, archive.exportedAt);

    return { archiveId: id, contentHash, manifest, archive };
  };

  const closeBatch = (batchId, actorId) => {
    const batch = batchById(batchId);
    const actor = userById(actorId);
    if (actor.role !== "admin") throw new DomainError("FORBIDDEN", "仅教务可关闭批次");
    if (batch.status !== "open") throw new DomainError("CONFLICT", "批次已关闭");
    db.prepare("UPDATE batches SET status = 'closed', closed_at = ? WHERE id = ?")
      .run(nowIso(), batchId);
    return batchById(batchId);
  };

  return {
    db,
    createInstitution, createUser, createBatch, updateBatchRules,
    addStaff, createTeam, addTeamMember, createNode, changeDeadline,
    createDeliverable, submitVersion,
    recordSignoff, splitTeamGap, closeGapWithSubmission, resolveDispute,
    exitInstitution,
    certificateEligibility, countCertificate, revokeForCorrection, recordNewDecision,
    dashboard, exportArchive, closeBatch,
    // exposed for tests / advanced use
    attributeOverdue, deadlineHistory,
  };
}
