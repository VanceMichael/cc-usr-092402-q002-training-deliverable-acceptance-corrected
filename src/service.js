import {
  newId,
  nowIso,
  epoch,
  assertIso,
  addHours,
  tzOffsetMinutes,
  canonicalJson,
  hashJson,
  serial,
} from "./util.js";
import { badRequest, forbidden, notFound, conflict, rethrowUnique } from "./errors.js";

/**
 * 成果签收协同领域服务。
 * 所有写操作都是只追加 + 同事务状态流转；时间取 UTC，来源时区只做记录与换算。
 */
export function createService(db, { clock = nowIso } = {}) {
  const time = (opt) => opt?.now ?? clock();

  // ---------- 基础读取 ----------
  const getUser = (id) => {
    const u = db.prepare("select * from users where id = ?").get(id);
    if (!u) throw notFound("用户", id);
    return u;
  };
  const getOrg = (id) => {
    const o = db.prepare("select * from organizations where id = ?").get(id);
    if (!o) throw notFound("机构", id);
    return o;
  };
  const getBatch = (id) => {
    const b = db.prepare("select * from batches where id = ?").get(id);
    if (!b) throw notFound("批次", id);
    return b;
  };
  const requireOpenBatch = (batch) => {
    if (batch.status !== "open") throw conflict("batch_closed", `批次 ${batch.code} 已结项冻结，不能再做该操作`);
  };
  const requireNotArchived = (batch) => {
    if (batch.status === "archived") throw conflict("batch_archived", `批次 ${batch.code} 已归档，不能再做该操作`);
  };
  const getRule = (batchId, version = null) =>
    version
      ? db.prepare("select * from batch_rules where batch_id=? and version=?").get(batchId, version)
      : db
          .prepare("select * from batch_rules where batch_id=? order by version desc limit 1")
          .get(batchId);
  const getMilestone = (id) => {
    const m = db.prepare("select * from milestones where id = ?").get(id);
    if (!m) throw notFound("节点", id);
    return m;
  };
  const getDeadline = (milestoneId, version = null) =>
    version
      ? db.prepare("select * from milestone_deadlines where milestone_id=? and version=?").get(milestoneId, version)
      : db
          .prepare("select * from milestone_deadlines where milestone_id=? order by version desc limit 1")
          .get(milestoneId);
  const getDeliverable = (id) => {
    const d = db.prepare("select * from deliverables where id = ?").get(id);
    if (!d) throw notFound("成果", id);
    return d;
  };
  const getDispute = (id) => {
    const r = db.prepare("select * from disputes where id = ?").get(id);
    if (!r) throw notFound("争议", id);
    return r;
  };

  const requireActorKind = (id, kinds) => {
    const u = getUser(id);
    if (!kinds.includes(u.kind)) throw forbidden("forbidden_role", `该操作不允许 ${u.kind} 执行`);
    return u;
  };

  // ---------- 幂等 ----------
  function withIdempotency(key, fingerprint, fn) {
    if (!key) return fn();
    const existing = db.prepare("select * from idempotent_ops where idempotency_key=?").get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw conflict("idempotency_key_conflict", "同一幂等键对应了不同请求");
      }
      return { ...JSON.parse(existing.response_json), __replayed: true };
    }
    const result = fn();
    db.prepare(
      "insert into idempotent_ops (idempotency_key, fingerprint, response_json) values (?,?,?)"
    ).run(key, fingerprint, JSON.stringify(result));
    return result;
  }

  // ---------- 机构 / 用户 ----------
  const createOrganization = ({ id, name, kind }) => {
    db.prepare("insert into organizations (id,name,kind) values (?,?,?)").run(id, name, kind);
    return getOrg(id);
  };

  const createUser = ({ id, organizationId, displayName, kind, canGrade = false }) => {
    db.prepare(
      "insert into users (id,organization_id,display_name,kind,can_grade) values (?,?,?,?,?)"
    ).run(id, organizationId ?? null, displayName, kind, canGrade ? 1 : 0);
    return getUser(id);
  };

  // ---------- 批次与规则版本 ----------
  const createBatch = ({ id, code, title, rule = {}, now = null }) => {
    const ts = time({ now });
    const snapshot = ruleSnapshot(rule, 1);
    const tx = db.transaction(() => {
      db.prepare("insert into batches (id,code,title,current_rule_version,created_at) values (?,?,?,1,?)").run(
        id,
        code,
        title,
        ts
      );
      insertRule(id, 1, snapshot, ts, null, "批次建立");
    });
    tx();
    return { batch: getBatch(id), rule: getRule(id, 1) };
  };

  function ruleSnapshot(rule = {}, version = 1) {
    return {
      version,
      requireAllMentors: rule.requireAllMentors ?? true,
      requireEnterpriseReview: rule.requireEnterpriseReview ?? true,
      resubmitWindowHours: rule.resubmitWindowHours ?? null,
      graceMinutes: rule.graceMinutes ?? 0,
      offlineReportWindowHours: rule.offlineReportWindowHours ?? 0,
      reviewSlaHours: rule.reviewSlaHours ?? null,
    };
  }

  function insertRule(batchId, version, snap, changedAt, changedBy, reason) {
    db.prepare(
      `insert into batch_rules
       (batch_id,version,changed_at,changed_by,change_reason,require_all_mentors,require_enterprise_review,
        resubmit_window_hours,grace_minutes,offline_report_window_hours,review_sla_hours,rule_json)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      batchId,
      version,
      changedAt,
      changedBy,
      reason,
      snap.requireAllMentors ? 1 : 0,
      snap.requireEnterpriseReview ? 1 : 0,
      snap.resubmitWindowHours,
      snap.graceMinutes,
      snap.offlineReportWindowHours,
      snap.reviewSlaHours,
      canonicalJson(snap)
    );
  }

  const changeRule = ({ batchId, by, reason, patch, now = null }) => {
    const batch = getBatch(batchId);
    requireOpenBatch(batch);
    getUser(by);
    const ts = time({ now });
    const current = getRule(batchId);
    const nextVersion = current.version + 1;
    const snap = ruleSnapshot(
      {
        requireAllMentors: !!current.require_all_mentors,
        requireEnterpriseReview: !!current.require_enterprise_review,
        resubmitWindowHours: current.resubmit_window_hours,
        graceMinutes: current.grace_minutes,
        offlineReportWindowHours: current.offline_report_window_hours,
        reviewSlaHours: current.review_sla_hours,
        ...patch,
      },
      nextVersion
    );
    insertRule(batchId, nextVersion, snap, ts, by, reason ?? "规则变更");
    db.prepare("update batches set current_rule_version=? where id=?").run(nextVersion, batchId);
    return getRule(batchId, nextVersion);
  };

  const addParty = ({ batchId, organizationId, role }) => {
    const batch = getBatch(batchId);
    requireOpenBatch(batch);
    getOrg(organizationId);
    try {
      db.prepare("insert into batch_parties (batch_id,organization_id,role) values (?,?,?)").run(
        batchId,
        organizationId,
        role
      );
    } catch (e) {
      rethrowUnique(e, "party_exists", "该机构已在此批次中");
    }
    return db.prepare("select * from batch_parties where batch_id=? and organization_id=?").get(batchId, organizationId);
  };

  // ---------- 节点 / 截止时间版本 / 签署范围 ----------
  const createMilestone = ({ id, batchId, code, title, scopeKind = "team", deadlineAt, signingScope, now = null }) => {
    const batch = getBatch(batchId);
    requireOpenBatch(batch);
    assertIso(deadlineAt, "deadlineAt");
    const scope = normalizeScope(batchId, signingScope ?? {});
    const ts = time({ now });
    const tx = db.transaction(() => {
      db.prepare(
        `insert into milestones (id,batch_id,code,title,scope_kind,signing_scope_json,current_deadline_version,created_at)
         values (?,?,?,?,?,?,1,?)`
      ).run(id, batchId, code, title, scopeKind, canonicalJson(scope), ts);
      db.prepare(
        "insert into milestone_deadlines (milestone_id,version,deadline_at,changed_at,changed_by,notice_text) values (?,1,?,?,?,?)"
      ).run(id, deadlineAt, ts, null, "节点建立");
      for (const mentorId of scope.mentorIds) {
        db.prepare("insert or ignore into grading_grants (milestone_id,mentor_id,granted_at) values (?,?,?)").run(
          id,
          mentorId,
          ts
        );
      }
    });
    tx();
    return getMilestone(id);
  };

  function normalizeScope(batchId, scope) {
    const mentorIds = [...new Set(scope.mentorIds ?? [])];
    for (const mid of mentorIds) {
      const m = getUser(mid);
      if (m.kind !== "mentor" || !m.can_grade) {
        throw badRequest("scope_mentor_invalid", `导师 ${mid} 不具备评分权限，不能进入签署范围`);
      }
    }
    if (mentorIds.length === 0) throw badRequest("scope_empty", "签署范围至少需要一名评分导师");
    return { mentorIds, enterpriseRequired: scope.enterpriseRequired ?? true };
  }

  const changeDeadline = ({ milestoneId, deadlineAt, by, notice, now = null }) => {
    const m = getMilestone(milestoneId);
    const batch = getBatch(m.batch_id);
    requireOpenBatch(batch);
    assertIso(deadlineAt, "deadlineAt");
    getUser(by);
    const ts = time({ now });
    const nextVersion = m.current_deadline_version + 1;
    db.prepare(
      `insert into milestone_deadlines (milestone_id,version,deadline_at,changed_at,changed_by,notice_text)
       values (?,?,?,?,?,?)`
    ).run(m.id, nextVersion, deadlineAt, ts, by, notice ?? null);
    db.prepare("update milestones set current_deadline_version=? where id=?").run(nextVersion, m.id);
    return getDeadline(m.id, nextVersion);
  };

  // ---------- 团队 ----------
  const createTeam = ({ id, batchId, code, name }) => {
    const batch = getBatch(batchId);
    requireOpenBatch(batch);
    try {
      db.prepare("insert into teams (id,batch_id,code,name) values (?,?,?,?)").run(id, batchId, code, name);
    } catch (e) {
      rethrowUnique(e, "team_exists", "团队编号已存在");
    }
    return db.prepare("select * from teams where id=?").get(id);
  };

  const addTeamMember = ({ teamId, userId, role = "member" }) => {
    const team = db.prepare("select * from teams where id=?").get(teamId);
    if (!team) throw notFound("团队", teamId);
    requireOpenBatch(getBatch(team.batch_id));
    const u = getUser(userId);
    if (u.kind !== "student") throw badRequest("not_student", "团队成员必须是学员");
    db.prepare("insert or ignore into team_members (team_id,user_id,role) values (?,?,?)").run(teamId, userId, role);
    return db.prepare("select * from team_members where team_id=? and user_id=?").get(teamId, userId);
  };

  const isTeamMember = (teamId, userId) =>
    !!db
      .prepare("select 1 from team_members where team_id=? and user_id=? and left_at is null")
      .get(teamId, userId);

  // ---------- 成果 ----------
  const createDeliverable = ({ id, milestoneId, kind, teamId = null, ownerUserId = null }) => {
    const m = getMilestone(milestoneId);
    requireOpenBatch(getBatch(m.batch_id));
    if (kind === "team") {
      if (!teamId) throw badRequest("team_required", "团队成果必须指定团队");
      if (!db.prepare("select 1 from teams where id=? and batch_id=?").get(teamId, m.batch_id))
        throw badRequest("team_batch_mismatch", "团队不属于该批次");
    } else if (kind === "individual") {
      if (!ownerUserId) throw badRequest("owner_required", "个人成果必须指定学员");
      const u = getUser(ownerUserId);
      if (u.kind !== "student") throw badRequest("not_student", "个人成果负责人必须是学员");
    } else throw badRequest("kind_invalid", "kind 必须是 team 或 individual");
    try {
      db.prepare(
        "insert into deliverables (id,milestone_id,kind,team_id,owner_user_id) values (?,?,?,?,?)"
      ).run(id, milestoneId, kind, teamId, ownerUserId);
    } catch (e) {
      rethrowUnique(e, "deliverable_exists", "该节点下成果已存在（同一团队/学员唯一）");
    }
    return getDeliverable(id);
  };

  // ---------- 机构退出（确定处理：豁免留痕 + 成员离队） ----------
  const withdrawOrganization = ({ organizationId, effectiveAt, reason, now = null }) => {
    const org = getOrg(organizationId);
    if (org.status === "withdrawn") throw conflict("org_withdrawn", "机构已退出");
    const ts = time({ now });
    const eff = effectiveAt ?? ts;
    assertIso(eff, "effectiveAt");
    if (epoch(eff) > epoch(ts) + 60_000) throw badRequest("withdrawal_future", "退出生效时间不能晚于当前");

    const tx = db.transaction(() => {
      db.prepare("update organizations set status='withdrawn' where id=?").run(org.id);
      const withdrawalId = newId("wd");
      db.prepare(
        "insert into organization_withdrawals (id,organization_id,effective_at,reason,created_at) values (?,?,?,?,?)"
      ).run(withdrawalId, org.id, eff, reason, ts);

      // 成员离队
      db.prepare(
        "update team_members set left_at=? where user_id in (select id from users where organization_id=?) and left_at is null"
      ).run(eff, org.id);

      const parties = db.prepare("select * from batch_parties where organization_id=?").all(org.id);
      for (const party of parties) {
        const deliverables = openDeliverablesOfBatch(party.batch_id);
        if (party.role === "overseas_school") {
          const mentors = db
            .prepare("select id from users where organization_id=? and kind='mentor'")
            .all(org.id);
          for (const d of deliverables) {
            const scope = JSON.parse(d.signing_scope_json);
            for (const mentor of mentors) {
              if (scope.mentorIds.includes(mentor.id) && !partySatisfied(d, `mentor:${mentor.id}`)) {
                addWaiver(d.id, `mentor:${mentor.id}`, "org_withdrawal", withdrawalId, null);
              }
            }
          }
        } else if (party.role === "enterprise") {
          for (const d of deliverables) {
            const scope = JSON.parse(d.signing_scope_json);
            if (scope.enterpriseRequired && !partySatisfied(d, "enterprise")) {
              addWaiver(d.id, "enterprise", "org_withdrawal", withdrawalId, null);
            }
          }
        } else if (party.role === "school") {
          // 学员个人成果整体豁免；其在团队成果上的个人缺口豁免；整队无人则团队成果豁免
          for (const d of deliverables) {
            if (d.kind === "individual" && d.owner_org_id === org.id) {
              addWaiver(d.id, "deliverable", "org_withdrawal", withdrawalId, null);
            }
          }
          db.prepare(
            `update gaps set status='waived'
             where status='open'
               and assignee_user_id in (select id from users where organization_id=?)
               and deliverable_id in (
                 select d.id from deliverables d join milestones m on m.id=d.milestone_id
                 join batches b on b.id=m.batch_id where b.status='open')`
          ).run(org.id);
          for (const d of deliverables) {
            if (d.kind !== "team") continue;
            const remaining = db
              .prepare("select count(*) as c from team_members where team_id=? and left_at is null")
              .get(d.team_id).c;
            if (remaining === 0) addWaiver(d.id, "deliverable", "org_withdrawal", withdrawalId, null);
          }
        }
      }
      return db.prepare("select * from organization_withdrawals where organization_id=? order by effective_at desc limit 1").get(org.id);
    });
    return tx();
  };

  function openDeliverablesOfBatch(batchId) {
    return db
      .prepare(
        `select d.*, m.signing_scope_json, u.organization_id as owner_org_id
         from deliverables d
         join milestones m on m.id = d.milestone_id
         join batches b on b.id = m.batch_id
         left join users u on u.id = d.owner_user_id
         where m.batch_id=? and b.status='open'
           and not exists (select 1 from signoff_waivers w where w.deliverable_id=d.id and w.party='deliverable')`
      )
      .all(batchId);
  }

  function addWaiver(deliverableId, party, reason, refId = null, createdBy = null) {
    db.prepare(
      `insert or ignore into signoff_waivers (id,deliverable_id,party,reason,ref_id,created_by)
       values (?,?,?,?,?,?)`
    ).run(newId("wv"), deliverableId, party, reason, refId, createdBy);
  }

  // ---------- 提交版本链 / 离线补传 ----------
  const submit = ({
    deliverableId,
    submitterId,
    contentSummary,
    contentHash,
    sourceTz,
    authoredAt = null,
    isOffline = false,
    closesGapIds = [],
    storageRef = null,
    idempotencyKey = null,
    now = null,
  }) => {
    if (!contentSummary || !contentHash || !sourceTz) {
      throw badRequest("submit_fields_missing", "contentSummary/contentHash/sourceTz 必填");
    }
    const d = getDeliverable(deliverableId);
    const m = getMilestone(d.milestone_id);
    const batch = getBatch(m.batch_id);
    requireNotArchived(batch);
    const submitter = getUser(submitterId);
    if (submitter.kind !== "student") throw forbidden("submitter_must_be_student", "只有学员能提交成果");
    if (d.kind === "team") {
      if (!isTeamMember(d.team_id, submitterId))
        throw forbidden("not_team_member", "非该团队在册学员不能提交团队成果");
    } else if (d.owner_user_id !== submitterId) {
      throw forbidden("not_owner", "个人成果只能由负责人本人提交");
    }

    const rule = getRule(m.batch_id, batch.current_rule_version);
    const deadline = getDeadline(m.id, m.current_deadline_version);
    const receivedAt = time({ now });

    let effectiveAt = receivedAt;
    if (isOffline || authoredAt) {
      if (!rule.offline_report_window_hours)
        throw badRequest("offline_not_allowed", "当前批次规则不允许离线补传");
      assertIso(authoredAt, "authoredAt");
      if (epoch(authoredAt) > epoch(receivedAt) + 60_000)
        throw badRequest("authored_in_future", "离线完成时间不能晚于接收时间");
      const delayHours = (epoch(receivedAt) - epoch(authoredAt)) / 3_600_000;
      if (delayHours > rule.offline_report_window_hours)
        throw badRequest(
          "offline_window_exceeded",
          `超过离线补传上报窗口 ${rule.offline_report_window_hours} 小时`,
          { delayHours, windowHours: rule.offline_report_window_hours }
        );
      effectiveAt = authoredAt;
    }
    const offset = tzOffsetMinutes(sourceTz, effectiveAt);

    // 关闭缺口：只能关闭“自己负责”的开放缺口
    const gaps = [];
    for (const gapId of [...new Set(closesGapIds)]) {
      const g = db.prepare("select * from gaps where id=?").get(gapId);
      if (!g || g.deliverable_id !== d.id) throw badRequest("gap_not_found", `缺口 ${gapId} 不属于本成果`);
      if (g.status !== "open") throw conflict("gap_not_open", `缺口 ${gapId} 已处于 ${g.status}`);
      if (g.assignee_user_id !== submitterId && !(g.assignee_team_id && isTeamMember(g.assignee_team_id, submitterId)))
        throw forbidden("gap_not_assigned_to_submitter", "学员补交只能关闭自己（或所在团队）负责的缺口", {
          gapId,
          assignee: g.assignee_user_id,
          assigneeTeam: g.assignee_team_id,
        });
      gaps.push(g);
    }

    // 指纹只取请求方声明的内容；服务器接收时刻不参与，否则同请求重放会被误判冲突
    const fingerprint = hashJson({
      op: "submit",
      deliverableId,
      submitterId,
      contentHash,
      sourceTz,
      authoredAt: isOffline || authoredAt ? authoredAt : null,
      closesGapIds: [...closesGapIds].sort(),
    });

    return withIdempotency(idempotencyKey, fingerprint, () => {
      const tx = db.transaction(() => {
        const last = db
          .prepare("select * from submissions where deliverable_id=? order by seq desc limit 1")
          .get(d.id);
        const seq = (last?.seq ?? 0) + 1;
        const submissionId = newId("sub");
        try {
          db.prepare(
            `insert into submissions
             (id,deliverable_id,seq,previous_submission_id,content_summary,content_hash,storage_ref,
              source_tz,source_offset_minutes,authored_at,submitted_at,is_offline,submitter_id,closes_gap_ids_json)
             values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            submissionId,
            d.id,
            seq,
            last?.id ?? null,
            contentSummary,
            contentHash,
            storageRef,
            sourceTz,
            offset,
            effectiveAt,
            receivedAt,
            isOffline ? 1 : 0,
            submitterId,
            canonicalJson([...new Set(closesGapIds)].sort())
          );
        } catch (e) {
          rethrowUnique(e, "duplicate_submission", "重复回执：相同内容与完成时刻的提交已入账");
        }

        // 缺口关闭 + 各自的补交 SLA
        for (const g of gaps) {
          db.prepare(
            "update gaps set status='closed',closed_by_submission_id=?,closed_at=? where id=? and status='open'"
          ).run(submissionId, effectiveAt, g.id);
          if (g.due_at) {
            recordSla({
              batchId: m.batch_id,
              milestoneId: m.id,
              deliverableId: d.id,
              eventType: "gap_close",
              actor: submitter,
              dueAt: g.due_at,
              effectiveAt,
              receivedAt,
              rule,
              deadlineVersion: null,
            });
          }
        }

        // 补交后签收失效规则（解决“意见早于补交”的时序）：
        //  - 针对缺口补交：只让提出这些缺口的一方基于新版本重签；
        //  - 无缺口目标的通用新版本：所有既有签收/驳回基于旧内容，一律失效待重签。
        // 争议决定不在此处理，仍由教务裁决收口。
        const resignKinds = "('approved','conditional','partial_return','rejected')";
        if (seq > 1) {
          if (gaps.length > 0) {
            const raiserActors = [
              ...new Set(
                gaps.map((g) =>
                  db.prepare("select actor_id, actor_role from decisions where id=?").get(g.raised_by_decision_id)
                )
              ),
            ];
            for (const ra of raiserActors) {
              if (!ra) continue;
              if (ra.actor_role === "enterprise_reviewer") {
                db.prepare(
                  `update decisions set is_effective=0, superseded_by=?
                   where deliverable_id=? and is_effective=1 and actor_role='enterprise_reviewer'
                     and kind in ${resignKinds}`
                ).run(submissionId, d.id);
              } else {
                db.prepare(
                  `update decisions set is_effective=0, superseded_by=?
                   where deliverable_id=? and is_effective=1 and actor_id=? and kind in ${resignKinds}`
                ).run(submissionId, d.id, ra.actor_id);
              }
            }
          } else {
            db.prepare(
              `update decisions set is_effective=0, superseded_by=?
               where deliverable_id=? and is_effective=1 and actor_role in ('mentor','enterprise_reviewer')
                 and kind in ${resignKinds}`
            ).run(submissionId, d.id);
          }
        }

        // 提交/补交 SLA：首交对节点截止时间；补交若关闭具体缺口则只记各缺口时限，
        // 没有缺口目标的一般补交仍对节点截止时间（截止时间变更按当前版本）
        if (seq === 1 || gaps.length === 0) {
          recordSla({
            batchId: m.batch_id,
            milestoneId: m.id,
            deliverableId: d.id,
            eventType: seq === 1 ? "submit" : "resubmit",
            actor: submitter,
            dueAt: deadline.deadline_at,
            effectiveAt,
            receivedAt,
            rule,
            deadlineVersion: deadline.version,
          });
        }

        if (batch.status === "closed") {
          const closure = db.prepare("select * from batch_closures where batch_id=?").get(batch.id);
          appendAddendum(closure, "post_closure_submission", {
            submissionId,
            deliverableId: d.id,
            seq,
            previousSubmissionId: last?.id ?? null,
            sourceTz,
            authoredAt: effectiveAt,
            isOffline: !!isOffline,
            closedGapIds: gaps.map((g) => g.id),
          }, submitterId, receivedAt);
        }

        return { submission: db.prepare("select * from submissions where id=?").get(submissionId), closedGaps: gaps.map((g) => g.id) };
      });
      return tx();
    });
  };

  function orgWithdrawalExemption(actor, atIso) {
    if (!actor?.organization_id) return null;
    const w = db
      .prepare(
        "select * from organization_withdrawals where organization_id=? and effective_at<=? order by effective_at desc limit 1"
      )
      .get(actor.organization_id, atIso);
    return w ? "org_withdrawal" : null;
  }

  function recordSla({
    batchId,
    milestoneId,
    deliverableId,
    eventType,
    actor,
    dueAt,
    effectiveAt,
    receivedAt,
    rule,
    deadlineVersion,
  }) {
    if (!dueAt) return;
    const graceMs = (rule.grace_minutes ?? 0) * 60_000;
    const lateMs = epoch(effectiveAt) + graceMs - epoch(dueAt);
    const lateMinutes = Math.round(lateMs / 60_000);
    let responsible = null;
    let exemptReason = null;
    if (lateMs > 0) {
      responsible = eventType === "review" ? actor.kind === "mentor" ? "mentor" : "enterprise" : "student";
      exemptReason = orgWithdrawalExemption(actor, effectiveAt);
      if (exemptReason) responsible = null;
    }
    db.prepare(
      `insert into sla_events
       (id,batch_id,milestone_id,deliverable_id,event_type,actor_user_id,actor_org_id,party,due_at,
        deadline_version,rule_version,effective_event_at,recorded_at,late_minutes,responsible_party,exempt_reason)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      newId("sla"),
      batchId,
      milestoneId,
      deliverableId,
      eventType,
      actor.id,
      actor.organization_id ?? null,
      eventType === "review" ? (actor.kind === "mentor" ? "mentor" : "enterprise") : "student",
      dueAt,
      deadlineVersion,
      rule.version,
      effectiveAt,
      receivedAt,
      lateMinutes,
      responsible,
      exemptReason
    );
  }

  // ---------- 签收决定 ----------
  const MENTOR_KINDS = new Set(["approved", "conditional", "rejected", "reopened_after_issue"]);
  const ENTERPRISE_KINDS = new Set([
    "approved",
    "conditional",
    "partial_return",
    "rejected",
    "dispute",
    "reopened_after_issue",
  ]);
  const SIGN_KINDS = new Set(["approved", "conditional", "partial_return"]);

  const decide = ({
    deliverableId,
    actorId,
    kind,
    comment = null,
    basedOnSubmissionId = null,
    gaps = [],
    idempotencyKey = null,
    now = null,
  }) => {
    const d = getDeliverable(deliverableId);
    const m = getMilestone(d.milestone_id);
    const batch = getBatch(m.batch_id);
    requireNotArchived(batch);
    const actor = getUser(actorId);
    const scope = JSON.parse(m.signing_scope_json);

    let party;
    if (actor.kind === "mentor") {
      if (!actor.can_grade) throw forbidden("no_grade_permission", "导师没有评分权限");
      if (!scope.mentorIds.includes(actor.id))
        throw forbidden("outside_signing_scope", "导师不在该节点的签署范围内");
      if (!MENTOR_KINDS.has(kind)) throw badRequest("kind_not_allowed", `导师不能给出 ${kind} 决定`);
      party = `mentor:${actor.id}`;
    } else if (actor.kind === "enterprise_reviewer") {
      if (!ENTERPRISE_KINDS.has(kind)) throw badRequest("kind_not_allowed", `企业复核不能给出 ${kind} 决定`);
      const isParty = db
        .prepare(
          `select 1 from batch_parties bp join organizations o on o.id=bp.organization_id
           where bp.batch_id=? and bp.role='enterprise' and o.id=?`
        )
        .get(m.batch_id, actor.organization_id);
      if (!isParty) throw forbidden("enterprise_not_party", "该企业不是本批次复核方");
      party = "enterprise";
    } else {
      throw forbidden("decide_role_invalid", "只有评分导师或企业复核能给签收决定");
    }

    const latestSub = db
      .prepare("select * from submissions where deliverable_id=? order by seq desc limit 1")
      .get(d.id);
    if (!latestSub) throw conflict("no_submission", "成果尚未提交，不能签收");
    const basedOn = basedOnSubmissionId
      ? db.prepare("select * from submissions where id=? and deliverable_id=?").get(basedOnSubmissionId, d.id)
      : latestSub;
    if (!basedOn) throw badRequest("based_on_not_found", "指定的前序提交不存在或不属于本成果");

    for (const g of gaps) {
      if (!g.description) throw badRequest("gap_description_required", "缺口必须含描述");
      if (!g.assigneeUserId && !g.teamId) throw badRequest("gap_assignee_required", "缺口必须指定学员或团队");
      if (g.assigneeUserId) {
        const u = getUser(g.assigneeUserId);
        if (u.kind !== "student") throw badRequest("gap_assignee_not_student", "缺口负责人必须是学员");
      }
      if (g.teamId && !db.prepare("select 1 from teams where id=?").get(g.teamId))
        throw badRequest("gap_team_not_found", "缺口团队不存在");
      if (g.dueAt) assertIso(g.dueAt, "gap.dueAt");
    }
    if (kind === "dispute" && gaps.length === 0 && !comment)
      throw badRequest("dispute_requires_reason", "争议必须附理由或具体缺口");

    const rule = getRule(m.batch_id, batch.current_rule_version);
    const fingerprint = hashJson({ op: "decide", deliverableId, actorId, kind, basedOnSubmissionId: basedOn.id, comment, gaps });

    return withIdempotency(idempotencyKey, fingerprint, () => {
      const tx = db.transaction(() => {
        const ts = time({ now });
        const decisionId = newId("dec");
        db.prepare(
          `insert into decisions
           (id,deliverable_id,actor_id,actor_role,kind,comment,based_on_submission_id,rule_version,created_at)
           values (?,?,?,?,?,?,?,?,?)`
        ).run(decisionId, d.id, actor.id, actor.kind, kind, comment, basedOn.id, rule.version, ts);

        // 同方旧决定失效（行保留）：导师按人各自签署；企业复核以角色为一方，整体取代
        if (actor.kind === "mentor") {
          db.prepare(
            `update decisions set is_effective=0, superseded_by=?
             where deliverable_id=? and is_effective=1 and actor_id=? and id<>?`
          ).run(decisionId, d.id, actor.id, decisionId);
        } else {
          db.prepare(
            `update decisions set is_effective=0, superseded_by=?
             where deliverable_id=? and is_effective=1 and actor_role='enterprise_reviewer' and id<>?`
          ).run(decisionId, d.id, decisionId);
        }

        // 评审 SLA：相对所基于的提交
        if (rule.review_sla_hours != null) {
          recordSla({
            batchId: m.batch_id,
            milestoneId: m.id,
            deliverableId: d.id,
            eventType: "review",
            actor,
            dueAt: addHours(basedOn.authored_at, rule.review_sla_hours),
            effectiveAt: ts,
            receivedAt: ts,
            rule,
            deadlineVersion: null,
          });
        }

        // 缺口（团队成果可拆到个人）；未显式给时限时，按当前规则的补交窗口计时
        const gapIds = [];
        if (["conditional", "partial_return", "rejected", "reopened_after_issue", "dispute"].includes(kind)) {
          for (const g of gaps) {
            const gapId = newId("gap");
            const dueAt = g.dueAt ?? (rule.resubmit_window_hours != null ? addHours(ts, rule.resubmit_window_hours) : null);
            db.prepare(
              `insert into gaps (id,deliverable_id,raised_by_decision_id,assignee_user_id,assignee_team_id,description,due_at)
               values (?,?,?,?,?,?,?)`
            ).run(gapId, d.id, decisionId, g.assigneeUserId ?? null, g.teamId ?? null, g.description, dueAt);
            gapIds.push(gapId);
          }
        }

        let disputeId = null;
        if (kind === "dispute") {
          disputeId = newId("dsp");
          db.prepare(
            `insert into disputes (id,deliverable_id,gap_id,raised_by,reason,status,decision_id)
             values (?,?,?,?,?, 'open', ?)`
          ).run(disputeId, d.id, gaps[0] ? gapIds[0] : null, actor.id, comment ?? gaps.map((g) => g.description).join("; "), decisionId);
        }

        if (batch.status === "closed") {
          const closure = db.prepare("select * from batch_closures where batch_id=?").get(batch.id);
          appendAddendum(closure, "post_closure_decision", {
            decisionId,
            deliverableId: d.id,
            actorId: actor.id,
            actorRole: actor.kind,
            kind,
            basedOnSubmissionId: basedOn.id,
            gaps: gapIds,
            disputeId,
          }, actor.id, ts);
        }

        return {
          decision: db.prepare("select * from decisions where id=?").get(decisionId),
          gaps: gapIds,
          disputeId,
        };
      });
      return tx();
    });
  };

  // ---------- 争议裁决（教务） ----------
  const resolveDispute = ({ disputeId, adminId, outcome, note = null, gaps = [], now = null }) => {
    requireActorKind(adminId, ["academic_admin"]);
    if (!["upheld", "rejected"].includes(outcome)) throw badRequest("outcome_invalid", "outcome 必须是 upheld/rejected");
    const dispute = getDispute(disputeId);
    if (dispute.status !== "open") throw conflict("dispute_closed", "争议已有裁决");
    const d = getDeliverable(dispute.deliverable_id);
    const m = getMilestone(d.milestone_id);
    const batch = getBatch(m.batch_id);
    requireNotArchived(batch);
    const rule = getRule(batch.id, batch.current_rule_version);

    const tx = db.transaction(() => {
      const ts = time({ now });
      const decisionId = newId("dec");
      const kind = outcome === "upheld" ? "dispute_upheld" : "dispute_rejected";
      db.prepare(
        `insert into decisions
         (id,deliverable_id,actor_id,actor_role,kind,comment,based_on_submission_id,rule_version,created_at)
         values (?,?,?,?,?,?,?,?,?)`
      ).run(
        decisionId,
        d.id,
        adminId,
        "academic_admin",
        kind,
        note,
        latestSubmissionId(d.id),
        rule.version,
        ts
      );

      if (outcome === "upheld") {
        // 争议成立：企业争议决定与既有导师/企业签收全部回到待处理，按裁决意见重开缺口
        db.prepare(
          `update decisions set is_effective=0, superseded_by=?
           where deliverable_id=? and is_effective=1 and actor_role in ('mentor','enterprise_reviewer')`
        ).run(decisionId, d.id);
        for (const g of gaps) {
          const dueAt = g.dueAt ?? (rule.resubmit_window_hours != null ? addHours(ts, rule.resubmit_window_hours) : null);
          db.prepare(
            `insert into gaps (id,deliverable_id,raised_by_decision_id,assignee_user_id,assignee_team_id,description,due_at)
             values (?,?,?,?,?,?,?)`
          ).run(newId("gap"), d.id, decisionId, g.assigneeUserId ?? null, g.teamId ?? null, g.description, dueAt);
        }
      } else {
        // 争议驳回：企业争议决定失效，缺的企业确认以裁决豁免补齐
        db.prepare("update decisions set is_effective=0, superseded_by=? where id=?").run(decisionId, dispute.decision_id);
        addWaiver(d.id, "enterprise", "dispute_rejected", disputeId, adminId);
      }

      db.prepare(
        "update disputes set status=?, resolved_by=?, resolution_note=?, resolved_at=? where id=?"
      ).run(outcome, adminId, note, ts, disputeId);
      return { decision: db.prepare("select * from decisions where id=?").get(decisionId) };
    });
    return tx();
  };

  function latestSubmissionId(deliverableId) {
    return db.prepare("select id from submissions where deliverable_id=? order by seq desc limit 1").get(deliverableId)?.id ?? null;
  }

  // ---------- 状态评估 ----------
  function effectiveDecisions(deliverableId) {
    return db
      .prepare("select * from decisions where deliverable_id=? and is_effective=1 order by created_at")
      .all(deliverableId);
  }

  function waiverParty(deliverableId, party) {
    return db
      .prepare("select * from signoff_waivers where deliverable_id=? and party=?")
      .get(deliverableId, party);
  }

  function partySatisfied(d, party) {
    if (waiverParty(d.id, party)) return true;
    const dec = db
      .prepare(
        "select * from decisions where deliverable_id=? and is_effective=1 and actor_id=? order by created_at desc limit 1"
      )
      .get(d.id, party.startsWith("mentor:") ? party.slice(7) : null);
    if (party.startsWith("mentor:")) return !!dec && SIGN_KINDS.has(dec.kind);
    if (party === "enterprise") {
      const e = db
        .prepare(
          "select * from decisions where deliverable_id=? and is_effective=1 and actor_role='enterprise_reviewer' order by created_at desc limit 1"
        )
        .get(d.id);
      return !!e && SIGN_KINDS.has(e.kind);
    }
    return false;
  }

  function requiredParties(m) {
    const scope = JSON.parse(m.signing_scope_json);
    const parties = scope.mentorIds.map((id) => `mentor:${id}`);
    if (scope.enterpriseRequired) parties.push("enterprise");
    return parties;
  }

  function evaluate(deliverableId) {
    const d = getDeliverable(deliverableId);
    const m = getMilestone(d.milestone_id);
    const subCount = db.prepare("select count(*) as c from submissions where deliverable_id=?").get(d.id).c;
    const decs = effectiveDecisions(d.id);
    const openGaps = db.prepare("select * from gaps where deliverable_id=? and status='open'").all(d.id);
    const openDispute = db
      .prepare("select * from disputes where deliverable_id=? and status='open' order by created_at desc limit 1")
      .get(d.id);
    const missing = requiredParties(m).filter((p) => !partySatisfied(d, p));
    const waived = db
      .prepare("select party,reason from signoff_waivers where deliverable_id=? and party<>'deliverable'")
      .all(d.id);
    const rejectedBy = decs.filter((x) => x.kind === "rejected").map((x) => x.actor_id);

    let state;
    if (waiverParty(d.id, "deliverable")) state = "waived";
    else if (openDispute) state = "in_dispute";
    else if (subCount === 0) state = "not_submitted";
    else if (rejectedBy.length) state = "rejected";
    else if (missing.length || openGaps.length) state = missing.length && !decs.length ? "pending_review" : "pending_conditions";
    else state = "complete";

    return {
      deliverableId: d.id,
      kind: d.kind,
      teamId: d.team_id,
      ownerUserId: d.owner_user_id,
      milestoneId: m.id,
      state,
      submissionCount: subCount,
      missingParties: missing,
      waivedParties: waived,
      openGapIds: openGaps.map((g) => g.id),
      openDisputeId: openDispute?.id ?? null,
      complete: state === "complete",
    };
  }

  // ---------- 证书：签发 + 只能撤销+新决定纠正 ----------
  function entitledUsers(d) {
    if (d.kind === "team") {
      return db
        .prepare("select user_id as id from team_members where team_id=? and left_at is null")
        .all(d.team_id)
        .map((x) => x.id);
    }
    return [d.owner_user_id];
  }

  const issueCertificates = ({ milestoneId, now = null }) => {
    const m = getMilestone(milestoneId);
    const batch = getBatch(m.batch_id);
    if (batch.status === "archived") throw conflict("batch_archived", "批次已归档，不能再签发证书");
    const ts = time({ now });
    const issued = [];
    const deliverables = db.prepare("select * from deliverables where milestone_id=?").all(m.id);
    const closure = db.prepare("select * from batch_closures where batch_id=?").get(batch.id);
    const tx = db.transaction(() => {
      for (const d of deliverables) {
        const st = evaluate(d.id);
        if (!st.complete) continue;
        for (const userId of entitledUsers(d)) {
          const exists = db
            .prepare(
              "select 1 from certificates where batch_id=? and milestone_id=? and user_id=? and state='valid'"
            )
            .get(batch.id, m.id, userId);
          if (exists) continue;
          const id = newId("cert");
          db.prepare(
            `insert into certificates
             (id,serial,batch_id,milestone_id,deliverable_id,user_id,team_id,issued_at,rule_version_at_issue,deadline_version_at_issue)
             values (?,?,?,?,?,?,?,?,?,?)`
          ).run(
            id,
            serial(),
            batch.id,
            m.id,
            d.id,
            userId,
            d.team_id,
            ts,
            batch.current_rule_version,
            m.current_deadline_version
          );
          issued.push(id);
          if (closure) {
            appendAddendum(closure, "certificate_issued", {
              certificateId: id,
              milestoneId: m.id,
              deliverableId: d.id,
              userId,
              teamId: d.team_id,
              ruleVersion: batch.current_rule_version,
              deadlineVersion: m.current_deadline_version,
            }, null, ts);
          }
        }
      }
    });
    tx();
    return { issuedCertificateIds: issued };
  };

  const revokeCertificate = ({ certificateId, by, reason, correction, now = null }) => {
    const admin = requireActorKind(by, ["academic_admin"]);
    const cert = db.prepare("select * from certificates where id=?").get(certificateId);
    if (!cert) throw notFound("证书", certificateId);
    if (cert.state !== "valid") throw conflict("cert_not_valid", "证书已被撤销");
    if (!correction || !["rejected", "reopened_after_issue"].includes(correction.kind))
      throw badRequest("correction_required", "撤销证书必须同时附上新决定（rejected/reopened_after_issue）");
    const d = getDeliverable(cert.deliverable_id);
    const m = getMilestone(d.milestone_id);
    const batch = getBatch(m.batch_id);
    const rule = getRule(batch.id, batch.current_rule_version);
    const corrector = getUser(correction.actorId ?? by);
    if (!["mentor", "enterprise_reviewer", "academic_admin"].includes(corrector.kind))
      throw forbidden("corrector_invalid", "新决定必须由导师、企业复核或教务作出");
    const ts = time({ now });

    const tx = db.transaction(() => {
      const decisionId = newId("dec");
      db.prepare(
        `insert into decisions
         (id,deliverable_id,actor_id,actor_role,kind,comment,based_on_submission_id,rule_version,created_at)
       values (?,?,?,?,?,?,?,?,?)`
      ).run(
        decisionId,
        d.id,
        corrector.id,
        corrector.kind,
        correction.kind,
        correction.comment ?? reason,
        latestSubmissionId(d.id),
        rule.version,
        ts
      );
      // 纠正把旧签收全部打回（含本决定之外的有效签收），证书依据不再成立
      db.prepare(
        `update decisions set is_effective=0, superseded_by=?
         where deliverable_id=? and is_effective=1 and id<>?`
      ).run(decisionId, d.id, decisionId);

      // 成果依据被推翻时，该成果下全部有效证书均须撤销（团队成果即全队证书）
      const certsToRevoke = db
        .prepare("select * from certificates where deliverable_id=? and state='valid' order by issued_at,id")
        .all(d.id);
      const revokedIds = [];
      for (const c of certsToRevoke) {
        db.prepare("update certificates set state='revoked' where id=?").run(c.id);
        db.prepare(
          `insert into certificate_revocations (id,certificate_id,revoked_by,reason,correction_decision_id,created_at)
           values (?,?,?,?,?,?)`
        ).run(newId("rev"), c.id, by, reason, decisionId, ts);
        revokedIds.push(c.id);
      }

      const closure = db.prepare("select * from batch_closures where batch_id=?").get(batch.id);
      if (closure) {
        appendAddendum(closure, "certificate_revocation", {
          certificateIds: revokedIds,
          anchorCertificateId: cert.id,
          reason,
          correctionDecisionId: decisionId,
          correctionKind: correction.kind,
          correctorId: corrector.id,
        }, by, ts);
      }
      return { revocation: { certificateId: cert.id, revokedCertificateIds: revokedIds, decisionId } };
    });
    return tx();
  };

  // ---------- 教务看板 ----------
  const dashboard = (batchId) => {
    const batch = getBatch(batchId);
    const milestones = db.prepare("select * from milestones where batch_id=? order by code").all(batchId);
    const orgs = Object.fromEntries(
      db
        .prepare(
          `select o.* from organizations o join batch_parties bp on bp.organization_id=o.id where bp.batch_id=?`
        )
        .all(batchId)
        .map((o) => [o.id, { id: o.id, name: o.name, kind: o.kind, status: o.status }])
    );
    const userName = (uid) => db.prepare("select display_name,organization_id from users where id=?").get(uid);

    const partyLabel = (party) => {
      if (party === "enterprise") return { type: "enterprise", name: "企业复核方" };
      if (party.startsWith("mentor:")) {
        const u = userName(party.slice(7));
        return { type: "mentor", userId: party.slice(7), name: u?.display_name ?? party.slice(7), organizationId: u?.organization_id ?? null };
      }
      return { type: party, name: party };
    };

    const result = {
      batchId,
      code: batch.code,
      status: batch.status,
      currentRuleVersion: batch.current_rule_version,
      milestones: [],
      missingConfirmations: [],
      openDisputes: [],
      lateResponsibility: { student: 0, mentor: 0, enterprise: 0, exempt: 0 },
      waivers: [],
      certificates: { valid: 0, revoked: 0 },
    };

    for (const m of milestones) {
      const deadline = getDeadline(m.id, m.current_deadline_version);
      const deliverables = db.prepare("select * from deliverables where milestone_id=?").all(m.id);
      const mView = {
        milestoneId: m.id,
        code: m.code,
        title: m.title,
        scopeKind: m.scope_kind,
        currentDeadline: deadline.deadline_at,
        deadlineVersion: deadline.version,
        deliverables: [],
      };
      for (const d of deliverables) {
        const st = evaluate(d.id);
        const gaps = db
          .prepare(
            `select g.*, u.display_name as assignee_name from gaps g
             left join users u on u.id=g.assignee_user_id where g.deliverable_id=?`
          )
          .all(d.id);
        mView.deliverables.push({ ...st, gaps });
        for (const p of st.missingParties) {
          const row = { milestoneCode: m.code, deliverableId: d.id, party: p, ...partyLabel(p) };
          result.missingConfirmations.push(row);
        }
        for (const g of gaps.filter((x) => x.status === "open")) {
          result.missingConfirmations.push({
            milestoneCode: m.code,
            deliverableId: d.id,
            party: "gap",
            gapId: g.id,
            name: g.assignee_name ?? g.description,
            dueAt: g.due_at,
            overdue: g.due_at ? epoch(g.due_at) < epoch(time()) : false,
          });
        }
        for (const w of st.waivedParties) {
          result.waivers.push({ milestoneCode: m.code, deliverableId: d.id, ...w, ...partyLabel(w.party) });
        }
      }
      result.milestones.push(mView);
    }

    const disputes = db
      .prepare(
        `select dp.* from disputes dp join deliverables d on d.id=dp.deliverable_id
         join milestones m on m.id=d.milestone_id where m.batch_id=? and dp.status='open'`
      )
      .all(batchId);
    result.openDisputes = disputes;

    const slas = db.prepare("select * from sla_events where batch_id=?").all(batchId);
    for (const s of slas) {
      if (s.exempt_reason) result.lateResponsibility.exempt++;
      else if (s.responsible_party) result.lateResponsibility[s.responsible_party]++;
    }
    result.lateEvents = slas
      .filter((s) => s.responsible_party || s.exempt_reason)
      .map((s) => ({
        milestoneId: s.milestone_id,
        deliverableId: s.deliverable_id,
        eventType: s.event_type,
        lateMinutes: s.late_minutes,
        responsibleParty: s.responsible_party,
        exemptReason: s.exempt_reason,
        dueAt: s.due_at,
        deadlineVersion: s.deadline_version,
        ruleVersion: s.rule_version,
      }));

    const certs = db
      .prepare("select state, count(*) as c from certificates where batch_id=? group by state")
      .all(batchId);
    for (const c of certs) result.certificates[c.state] = c.c;

    const blockers = [];
    for (const mv of result.milestones)
      for (const d of mv.deliverables)
        if (!["complete", "waived"].includes(d.state)) blockers.push({ deliverableId: d.deliverableId, state: d.state });
    result.readyToClose = blockers.length === 0 && result.openDisputes.length === 0;
    result.closureBlockers = blockers;
    result.organizations = orgs;
    return result;
  };

  // ---------- 结项档案 ----------
  const closeBatch = ({ batchId, by, now = null }) => {
    requireActorKind(by, ["academic_admin"]);
    const batch = getBatch(batchId);
    requireOpenBatch(batch);
    const view = dashboard(batchId);
    if (!view.readyToClose) {
      throw conflict("batch_not_ready", "仍有未完成成果或未裁决争议，不能结项", {
        blockers: view.closureBlockers,
        disputes: view.openDisputes.map((d) => d.id),
      });
    }
    const ts = time({ now });
    const manifest = buildManifest(batchId, ts, by);
    const manifestHash = hashJson(manifest);
    const tx = db.transaction(() => {
      db.prepare(
        "insert into batch_closures (id,batch_id,closed_at,closed_by,manifest_json,manifest_hash) values (?,?,?,?,?,?)"
      ).run(newId("cls"), batchId, ts, by, canonicalJson(manifest), manifestHash);
      db.prepare("update batches set status='closed' where id=?").run(batchId);
    });
    tx();
    return exportArchive(batchId);
  };

  function buildManifest(batchId, closedAt, closedBy) {
    const batch = getBatch(batchId);
    const pick = (rows, fields) => rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    return {
      format: "training-signoff-archive/1",
      batch: { id: batch.id, code: batch.code, title: batch.title, status: "closed", closedAt, closedBy },
      organizations: db
        .prepare(
          `select o.id,o.name,o.kind,o.status from organizations o
           join batch_parties bp on bp.organization_id=o.id where bp.batch_id=?`
        )
        .all(batchId),
      users: db
        .prepare(
          `select u.id,u.organization_id,u.display_name,u.kind,u.can_grade from users u
           where u.organization_id in (select organization_id from batch_parties where batch_id=?)
              or u.id in (select owner_user_id from deliverables d join milestones m on m.id=d.milestone_id where m.batch_id=?)`
        )
        .all(batchId, batchId),
      ruleVersions: db
        .prepare("select version,changed_at,changed_by,change_reason,rule_json from batch_rules where batch_id=? order by version")
        .all(batchId),
      milestones: db
        .prepare("select id,code,title,scope_kind,signing_scope_json,current_deadline_version from milestones where batch_id=? order by code")
        .all(batchId),
      deadlineVersions: db
        .prepare(
          `select md.* from milestone_deadlines md join milestones m on m.id=md.milestone_id
           where m.batch_id=? order by m.code, md.version`
        )
        .all(batchId),
      teams: pick(db.prepare("select * from teams where batch_id=?").all(batchId), ["id", "code", "name"]),
      teamMembers: db
        .prepare(
          `select tm.team_id,tm.user_id,tm.role,tm.left_at from team_members tm
           join teams t on t.id=tm.team_id where t.batch_id=?`
        )
        .all(batchId),
      withdrawals: db
        .prepare(
          `select w.* from organization_withdrawals w
           where w.organization_id in (select organization_id from batch_parties where batch_id=?)`
        )
        .all(batchId),
      deliverables: db
        .prepare("select d.id,d.milestone_id,d.kind,d.team_id,d.owner_user_id from deliverables d join milestones m on m.id=d.milestone_id where m.batch_id=?")
        .all(batchId),
      submissions: db
        .prepare(
          `select s.* from submissions s join deliverables d on d.id=s.deliverable_id
           join milestones m on m.id=d.milestone_id where m.batch_id=? order by s.deliverable_id,s.seq`
        )
        .all(batchId),
      decisions: db
        .prepare(
          `select dc.* from decisions dc join deliverables d on d.id=dc.deliverable_id
           join milestones m on m.id=d.milestone_id where m.batch_id=? order by dc.created_at`
        )
        .all(batchId),
      gaps: db
        .prepare(
          `select g.* from gaps g join deliverables d on d.id=g.deliverable_id
           join milestones m on m.id=d.milestone_id where m.batch_id=?`
        )
        .all(batchId),
      disputes: db
        .prepare(
          `select dp.* from disputes dp join deliverables d on d.id=dp.deliverable_id
           join milestones m on m.id=d.milestone_id where m.batch_id=?`
        )
        .all(batchId),
      waivers: db
        .prepare(
          `select w.* from signoff_waivers w join deliverables d on d.id=w.deliverable_id
           join milestones m on m.id=d.milestone_id where m.batch_id=?`
        )
        .all(batchId),
      slaEvents: db.prepare("select * from sla_events where batch_id=?").all(batchId),
      certificates: db.prepare("select * from certificates where batch_id=?").all(batchId),
      revocations: db
        .prepare(
          `select r.* from certificate_revocations r join certificates c on c.id=r.certificate_id where c.batch_id=?`
        )
        .all(batchId),
    };
  }

  function appendAddendum(closure, kind, payload, createdBy, createdAt = time()) {
    const last = db
      .prepare("select hash from closure_addenda where closure_id=? order by seq desc limit 1")
      .get(closure.id);
    const seqRow = db.prepare("select coalesce(max(seq),0)+1 as s from closure_addenda where closure_id=?").get(closure.id);
    const seq = seqRow.s;
    const prevHash = last?.hash ?? closure.manifest_hash;
    const body = { seq, kind, payload, createdAt, createdBy, prevHash };
    const hash = hashJson(body);
    db.prepare(
      `insert into closure_addenda (id,closure_id,seq,kind,payload_json,created_at,created_by,prev_hash,hash)
       values (?,?,?,?,?,?,?,?,?)`
    ).run(newId("add"), closure.id, seq, kind, canonicalJson(payload), createdAt, createdBy, prevHash, hash);
    return { seq, kind, payload, createdAt, createdBy, prevHash, hash };
  };

  const exportArchive = (batchId) => {
    const batch = getBatch(batchId);
    const closure = db.prepare("select * from batch_closures where batch_id=?").get(batchId);
    if (!closure) throw conflict("batch_not_closed", "批次尚未结项，无档案可导出");
    const manifest = JSON.parse(closure.manifest_json);
    const addenda = db
      .prepare("select seq,kind,payload_json,created_at,created_by,prev_hash,hash from closure_addenda where closure_id=? order by seq")
      .all(closure.id)
      .map((a) => ({ ...a, payload: JSON.parse(a.payload_json), payload_json: undefined }));
    const recomputed = hashJson(manifest);
    let chainOk = recomputed === closure.manifest_hash;
    let prev = closure.manifest_hash;
    for (const a of addenda) {
      if (a.prev_hash !== prev) chainOk = false;
      prev = a.hash;
    }
    return {
      format: "training-signoff-archive/1",
      batchId,
      closedAt: closure.closed_at,
      closedBy: closure.closed_by,
      manifestHash: closure.manifest_hash,
      manifest,
      addenda,
      verified: chainOk,
    };
  };

  return {
    // setup
    createOrganization,
    createUser,
    createBatch,
    changeRule,
    addParty,
    createMilestone,
    changeDeadline,
    createTeam,
    addTeamMember,
    createDeliverable,
    withdrawOrganization,
    // flow
    submit,
    decide,
    resolveDispute,
    evaluate,
    dashboard,
    issueCertificates,
    revokeCertificate,
    closeBatch,
    exportArchive,
    // helpers
    getBatch,
    getMilestone,
    getDeliverable,
  };
}
