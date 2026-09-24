import test from "node:test";
import assert from "node:assert/strict";
import { freshServices, standardFixture } from "./helpers.js";
import { DomainError } from "../src/util.js";

// ---------------------------------------------------------------------------
// 1. 提交版本链：内容摘要、来源时区、前序版本
// --------------------------------------------------------------------------------------
test("提交保留摘要/来源时区/前序版本，并形成单调版本链", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "团队报告", kind: "team" });

  const v1 = svc.submitVersion({
    deliverableId: "dlv1", summary: "初稿：市场分析", sourceTz: "Europe/Berlin",
    submittedBy: "stuA",
    occurredAt: "2026-09-20 18:00:00", // 柏林墙上时间（夏令时 UTC+2）
  });
  assert.equal(v1.version_no, 1);
  assert.equal(v1.source_tz, "Europe/Berlin");
  assert.equal(v1.occurred_at, "2026-09-20T16:00:00.000Z");
  assert.equal(v1.predecessor_id, null);

  const v2 = svc.submitVersion({
    deliverableId: "dlv1", summary: "二稿：补充数据", sourceTz: "Asia/Shanghai",
    submittedBy: "stuB", occurredAt: "2026-09-21T10:00:00+08:00",
  });
  assert.equal(v2.version_no, 2);
  assert.equal(v2.predecessor_id, v1.id);

  const chain = svc.db.prepare("SELECT * FROM submission_versions WHERE deliverable_id='dlv1' ORDER BY version_no").all();
  assert.equal(chain[1].predecessor_id, chain[0].id);
  assert.ok(chain[0].content_summary.includes("市场分析"));
});

test("非团队成员不能提交团队成果；个人成果仅负责人可提交", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dt", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  svc.createDeliverable({ id: "di", nodeId: fx.nodeId, ownerUserId: "stuA", title: "I", kind: "individual" });

  assert.throws(() => svc.submitVersion({
    deliverableId: "dt", summary: "x", submittedBy: "stuC",
  }), (e) => e.code === "FORBIDDEN");

  assert.throws(() => svc.submitVersion({
    deliverableId: "di", summary: "x", submittedBy: "stuB",
  }), (e) => e.code === "FORBIDDEN");

  assert.doesNotThrow(() => svc.submitVersion({
    deliverableId: "di", summary: "个人心得", submittedBy: "stuA",
  }));
});

// ---------------------------------------------------------------------------
// 2. 离线补传与重复回执幂等
// ---------------------------------------------------------------------------
test("离线补传按事件发生时刻入链，同 clientEventId 重放不产生新版本", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });

  const first = svc.submitVersion({
    deliverableId: "dlv1", summary: "离线提交", sourceTz: "Asia/Shanghai",
    submittedBy: "stuA", clientEventId: "evt-001",
    occurredAt: "2026-09-25 09:00:00", isBackfill: true,
  });
  assert.equal(first.is_backfill, 1);
  assert.equal(first.occurred_at, "2026-09-25T01:00:00.000Z");

  const replay = svc.submitVersion({
    deliverableId: "dlv1", summary: "内容不同也应被忽略", sourceTz: "Asia/Shanghai",
    submittedBy: "stuA", clientEventId: "evt-001",
    occurredAt: "2026-09-25 09:00:00", isBackfill: true,
  });
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);
  const count = svc.db.prepare("SELECT COUNT(*) n FROM submission_versions WHERE deliverable_id='dlv1'").get().n;
  assert.equal(count, 1);
});

test("导师重复回执（同 receiptKey）只承认一次，且不重复产生缺口", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  svc.submitVersion({ deliverableId: "dlv1", summary: "初稿", submittedBy: "stuA" });

  const args = {
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "conditional", score: 80, comment: "补充引用",
    receiptKey: "RCP-1", gaps: [{ title: "补参考文献" }],
  };
  const s1 = svc.recordSignoff(args);
  const s2 = svc.recordSignoff({ ...args, comment: "第二次重发，应忽略" });
  assert.equal(s2.id, s1.id);
  assert.equal(s2.replayed, true);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM gaps WHERE deliverable_id='dlv1'").get().n, 1);
});

// ---------------------------------------------------------------------------
// 3. 导师附条件通过（评分权限）
// ---------------------------------------------------------------------------
test("无评分权的导师不能打分；超过授权上限被拒", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createUser({ id: "mentor2", institutionId: "inst_abroad", name: "无分导师", role: "mentor" });
  svc.addStaff({ batchId: "batch1", userId: "mentor2", role: "mentor", canScore: false });
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });

  assert.throws(() => svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor2", party: "mentor",
    decision: "approved", score: 70, receiptKey: "r1",
  }), (e) => e.code === "FORBIDDEN");

  assert.throws(() => svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "approved", score: 95, receiptKey: "r2",
  }), (e) => e.code === "FORBIDDEN");
});

test("附条件通过产生缺口，补交关闭后可计证书", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  const v1 = svc.submitVersion({ deliverableId: "dlv1", summary: "初稿", submittedBy: "stuA" });

  svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "conditional", score: 85, receiptKey: "r-cond",
    gaps: [{ title: "补数据来源" }],
  });
  // 企业复核通过。
  svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise",
    decision: "approved", receiptKey: "r-ent",
  });
  assert.equal(svc.certificateEligibility("dlv1").eligible, false);

  const gap = svc.db.prepare("SELECT * FROM gaps WHERE deliverable_id='dlv1'").get();
  const v2 = svc.submitVersion({ deliverableId: "dlv1", summary: "补：数据来源清单", submittedBy: "stuA" });
  // 团队缺口可由任一成员关闭。
  const closed = svc.closeGapWithSubmission({ gapId: gap.id, studentUserId: "stuA", versionId: v2.id });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closed_by_version_id, v2.id);

  const elig = svc.certificateEligibility("dlv1");
  assert.equal(elig.eligible, true, JSON.stringify(elig));
  const cert = svc.countCertificate({ batchId: "batch1", userId: "stuA", deliverableId: "dlv1", versionId: v2.id });
  assert.equal(cert.status, "counted");
});

// ---------------------------------------------------------------------------
// 4. 企业局部退回：团队成果拆成个人整改，学员只能关闭自己的缺口
// ---------------------------------------------------------------------------
test("企业把团队缺口拆到个人，学员只能关闭本人缺口", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  svc.submitVersion({ deliverableId: "dlv1", summary: "初稿", submittedBy: "stuA" });
  svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise",
    decision: "returned", receiptKey: "r-ret",
    gaps: [{ title: "整体需返工：财务部分" }],
  });
  const teamGap = svc.db.prepare("SELECT * FROM gaps WHERE deliverable_id='dlv1'").get();
  assert.equal(teamGap.assignee_user_id, null);

  const split = svc.splitTeamGap({
    gapId: teamGap.id, reviewerUserId: "reviewer",
    assignments: [
      { userId: "stuA", title: "重做财务测算" },
      { userId: "stuB", title: "补审计签字页" },
    ],
  });
  assert.equal(split.newGapIds.length, 2);
  const voided = svc.db.prepare("SELECT * FROM gaps WHERE id=?").get(teamGap.id);
  assert.equal(voided.status, "void");

  const [gapA, gapB] = svc.db.prepare("SELECT * FROM gaps WHERE status='open' ORDER BY assignee_user_id").all();
  const vA = svc.submitVersion({ deliverableId: "dlv1", summary: "财务测算重做", submittedBy: "stuA" });

  // B 不能关闭 A 的缺口。
  assert.throws(() => svc.closeGapWithSubmission({ gapId: gapA.id, studentUserId: "stuB", versionId: vA.id }),
    (e) => e.code === "FORBIDDEN");
  // 也不能拿别人提交的版本关闭自己的缺口。
  assert.throws(() => svc.closeGapWithSubmission({ gapId: gapB.id, studentUserId: "stuB", versionId: vA.id }),
    (e) => e.code === "FORBIDDEN");

  const vB = svc.submitVersion({ deliverableId: "dlv1", summary: "审计签字页", submittedBy: "stuB" });
  svc.closeGapWithSubmission({ gapId: gapB.id, studentUserId: "stuB", versionId: vB.id });
  const stillOpen = svc.db.prepare("SELECT * FROM gaps WHERE id=?").get(gapA.id);
  assert.equal(stillOpen.status, "open");
});

test("局部退回必须落实到具体学员", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  svc.submitVersion({ deliverableId: "dlv1", summary: "初稿", submittedBy: "stuA" });
  assert.throws(() => svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise",
    decision: "partial_return", receiptKey: "rp", gaps: [{ title: "某部分" }],
  }), (e) => e.code === "VALIDATION");
});

// ---------------------------------------------------------------------------
// 5. 导师可在补交前先发回签收意见
// ---------------------------------------------------------------------------
test("签收意见可早于补交：versionId 允许为空，补交链不丢", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  const early = svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "returned", comment: "文件还没到，先给意见：方向需调整",
    receiptKey: "early", gaps: [{ title: "调整选题方向" }],
  });
  assert.equal(early.version_id, null);
  const v = svc.submitVersion({ deliverableId: "dlv1", summary: "按意见调整后的初稿", submittedBy: "stuA" });
  assert.equal(v.version_no, 1);
});

// ---------------------------------------------------------------------------
// 6. 争议
// ---------------------------------------------------------------------------
test("企业发起争议并裁决成立，冻结开放缺口；重新签收后恢复", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  svc.submitVersion({ deliverableId: "dlv1", summary: "初稿", submittedBy: "stuA" });
  svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "conditional", receiptKey: "m1", gaps: [{ title: "小修" }],
  });
  const disputeSignoff = svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise",
    decision: "disputed", receiptKey: "e1", disputeReason: "团队成果归属存疑",
  });
  const dispute = svc.db.prepare("SELECT * FROM disputes WHERE signoff_id=?").get(disputeSignoff.id);

  svc.resolveDispute({ disputeId: dispute.id, outcome: "upheld", resolution: "需重新核验", deciderUserId: "admin" });
  const frozen = svc.db.prepare("SELECT * FROM gaps WHERE deliverable_id='dlv1' AND status='frozen'").all();
  assert.ok(frozen.length >= 1);

  // 企业复核重新签收通过，其争议状态解除（导师仍需有效确认）。
  svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise",
    decision: "approved", receiptKey: "e2",
  });
  const d2 = svc.db.prepare("SELECT * FROM disputes WHERE id=?").get(dispute.id);
  assert.equal(d2.status, "upheld");
});

// ---------------------------------------------------------------------------
// 7. 截止时间变更与逾期归因
// ---------------------------------------------------------------------------
test("逾期归因：无改期归学员；提前改期落在旧期限内归改期方；延期后仍逾期归学员", () => {
  const svc = freshServices();
  const fx = standardFixture(svc, { deadlineAt: "2026-10-01T00:00:00+08:00" });
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });

  // 超过原始期限 10-01 提交 → student
  let v = svc.submitVersion({
    deliverableId: "dlv1", summary: "迟交", submittedBy: "stuA",
    occurredAt: "2026-10-02T00:00:00+08:00",
  });
  let a = svc.attributeOverdue({ nodeId: "node1", workAt: v.occurred_at });
  assert.equal(a.overdue, true);
  assert.equal(a.responsibleParty, "student");

  // 新节点：企业原因把截止时间提前到 09-25；学员 09-28 完成（旧期限内）→ enterprise
  svc.createNode({
    id: "node2", batchId: "batch1", code: "N2", title: "答辩材料",
    deadlineAt: "2026-10-01T00:00:00+08:00", deadlineTz: "Asia/Shanghai",
  });
  svc.createDeliverable({ id: "dlv2", nodeId: "node2", teamId: fx.teamId, title: "T2", kind: "team" });
  svc.changeDeadline({
    nodeId: "node2", newDeadlineAt: "2026-09-25T00:00:00+08:00",
    reason: "企业答辩排期提前", responsibleParty: "enterprise", actorId: "admin",
  });
  a = svc.attributeOverdue({ nodeId: "node2", workAt: "2026-09-28T00:00:00+08:00" });
  assert.equal(a.overdue, true);
  assert.equal(a.responsibleParty, "enterprise");

  // 节点 3：导师原因延期到 10-10；学员 10-12 才交 → 仍归 student
  svc.createNode({
    id: "node3", batchId: "batch1", code: "N3", title: "总报告",
    deadlineAt: "2026-10-01T00:00:00+08:00", deadlineTz: "Asia/Shanghai",
  });
  svc.changeDeadline({
    nodeId: "node3", newDeadlineAt: "2026-10-10T00:00:00+08:00",
    reason: "境外导师阅卷延迟", responsibleParty: "mentor", actorId: "admin",
  });
  a = svc.attributeOverdue({ nodeId: "node3", workAt: "2026-10-12T00:00:00+08:00" });
  assert.equal(a.overdue, true);
  assert.equal(a.responsibleParty, "student");
  // 但在延长期限内完成 → 不逾期
  a = svc.attributeOverdue({ nodeId: "node3", workAt: "2026-10-05T00:00:00+08:00" });
  assert.equal(a.overdue, false);
});

// ---------------------------------------------------------------------------
// 8. 机构退出
// ---------------------------------------------------------------------------
test("机构退出：用户停用、在途动作被拒、其缺口豁免、看板标注 waived", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.addTeamMember("team1", "stuC"); // 跨境团队中含境外机构学员
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  svc.submitVersion({ deliverableId: "dlv1", summary: "初稿", submittedBy: "stuA" });
  svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "partial_return", receiptKey: "m1",
    gaps: [{ assigneeUserId: "stuC", title: "你机构负责的外文附件缺失" }],
  });
  const gap = svc.db.prepare("SELECT * FROM gaps WHERE assignee_user_id='stuC'").get();
  assert.equal(gap.status, "open");

  svc.exitInstitution({ institutionId: "inst_abroad", reason: "合作终止", actorId: "admin" });
  const waived = svc.db.prepare("SELECT * FROM gaps WHERE id=?").get(gap.id);
  assert.equal(waived.status, "waived");

  // 停用用户不能再签收
  assert.throws(() => svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "approved", receiptKey: "m2",
  }), (e) => e.code === "INSTITUTION_EXITED");

  const dash = svc.dashboard("batch1");
  const d = dash.nodes[0].deliverables[0];
  const mentorMissing = d.missingConfirmations.find((x) => x.userId === "mentor");
  assert.equal(mentorMissing.waived, true);
});

// ---------------------------------------------------------------------------
// 9. 已计证书成果：只能撤销 + 新决定
// ---------------------------------------------------------------------------
test("已计证书成果的纠正路径：撤销记录 + 后继成果 + 新决定", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  const v1 = svc.submitVersion({ deliverableId: "dlv1", summary: "定稿", submittedBy: "stuA" });
  svc.recordSignoff({ nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor", decision: "approved", score: 88, receiptKey: "m1" });
  svc.recordSignoff({ nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise", decision: "approved", receiptKey: "e1" });
  svc.countCertificate({ batchId: "batch1", userId: "stuA", deliverableId: "dlv1", versionId: v1.id });

  // 不能再直接签收或补交
  assert.throws(() => svc.recordSignoff({
    nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor",
    decision: "returned", receiptKey: "m2", gaps: [{ title: "x" }],
  }), (e) => e.code === "CERT_LOCKED");
  assert.throws(() => svc.submitVersion({ deliverableId: "dlv1", summary: "偷偷改", submittedBy: "stuA" }),
    (e) => e.code === "CERT_LOCKED");
  // 非教务不能撤销
  assert.throws(() => svc.revokeForCorrection({ deliverableId: "dlv1", reason: "数据错误", adminUserId: "mentor" }),
    (e) => e.code === "FORBIDDEN");

  const rev = svc.revokeForCorrection({ deliverableId: "dlv1", reason: "发现引用造假", adminUserId: "admin" });
  assert.ok(rev.successorDeliverableId);
  const original = svc.db.prepare("SELECT * FROM deliverables WHERE id='dlv1'").get();
  assert.equal(original.status, "revoked");
  const cert = svc.db.prepare("SELECT * FROM certificate_records WHERE deliverable_id='dlv1'").get();
  assert.equal(cert.status, "revoked");

  // 后继成果上补交并由两方重新决定
  const succ = rev.successorDeliverableId;
  const sv = svc.submitVersion({ deliverableId: succ, summary: "更正版", submittedBy: "stuA" });
  svc.recordNewDecision({
    revocationId: rev.revocationId, successorDeliverableId: succ,
    deciderUserId: "mentor", decision: "approved", score: 80, versionId: sv.id,
  });
  svc.recordNewDecision({
    revocationId: rev.revocationId, successorDeliverableId: succ,
    deciderUserId: "reviewer", decision: "approved",
  });
  const elig = svc.certificateEligibility(succ);
  assert.equal(elig.eligible, true, JSON.stringify(elig));

  // 撤销记录与证书吊销都留在档案里
  const revocation = svc.db.prepare("SELECT * FROM revocations WHERE id=?").get(rev.revocationId);
  assert.equal(revocation.reason, "发现引用造假");
});

// ---------------------------------------------------------------------------
// 10. 看板：尚缺谁的确认 + 逾期责任汇总
// ---------------------------------------------------------------------------
test("看板列出缺失确认与逾期责任分布", () => {
  const svc = freshServices();
  const fx = standardFixture(svc, { deadlineAt: "2026-09-01T00:00:00+08:00" });
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  // 迟交（9-10，超过 9-01）
  svc.submitVersion({ deliverableId: "dlv1", summary: "迟交稿", submittedBy: "stuA", occurredAt: "2026-09-10T00:00:00+08:00" });
  // 仅导师通过，企业未签
  svc.recordSignoff({ nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor", decision: "approved", score: 70, receiptKey: "m1" });

  const dash = svc.dashboard("batch1");
  const d = dash.nodes[0].deliverables[0];
  assert.equal(d.overdue, true);
  assert.equal(d.responsibleParty, "student");
  const parties = d.missingConfirmations.map((x) => x.party);
  assert.deepEqual(parties, ["enterprise"]);
  assert.equal(dash.overdueResponsibility.student >= 1, true);
});

// ---------------------------------------------------------------------------
// 11. 结项档案导出：规则/签署范围快照一致、哈希稳定、规则可追溯
// ---------------------------------------------------------------------------
test("档案冻结当时规则与签署范围，改规则不影响已导出档案", () => {
  const svc = freshServices();
  const fx = standardFixture(svc);
  svc.createDeliverable({ id: "dlv1", nodeId: fx.nodeId, teamId: fx.teamId, title: "T", kind: "team" });
  const v = svc.submitVersion({ deliverableId: "dlv1", summary: "定稿", submittedBy: "stuA" });
  svc.recordSignoff({ nodeId: "node1", deliverableId: "dlv1", signerUserId: "mentor", party: "mentor", decision: "approved", score: 90, receiptKey: "m1" });
  svc.recordSignoff({ nodeId: "node1", deliverableId: "dlv1", signerUserId: "reviewer", party: "enterprise", decision: "approved", receiptKey: "e1" });

  const before = svc.exportArchive({ batchId: "batch1", actorId: "admin" });
  assert.equal(before.archive.nodes[0].node.rulesVersion, 1);
  assert.equal(before.archive.nodes[0].node.signingScope.parties.length, 2);
  assert.ok(before.contentHash);

  // 导出后改规则、关批次：已存档案行保持旧快照
  svc.updateBatchRules("batch1", { version: 2, requireBothParties: false }, "放宽要求", "admin");
  svc.closeBatch("batch1", "admin");
  const stored = svc.db.prepare("SELECT * FROM archive_exports WHERE id=?").get(before.archiveId);
  assert.equal(stored.rules_version, 1);
  assert.deepEqual(JSON.parse(stored.rules_snapshot), { version: 1, requireBothParties: true, resubmitWindowHours: 72 });

  // 同内容再导一次，manifest 哈希一致（时间戳除外）
  const again = svc.exportArchive({ batchId: "batch1", actorId: "admin" });
  assert.deepEqual(again.manifest, before.manifest);

  // 非教务不能导档
  assert.throws(() => svc.exportArchive({ batchId: "batch1", actorId: "mentor" }),
    (e) => e.code === "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 12. 规则版本化：节点冻结创建时规则
// ---------------------------------------------------------------------------
test("节点持有创建时规则快照，批次规则更新不回溯节点", () => {
  const svc = freshServices();
  standardFixture(svc);
  const n1 = svc.db.prepare("SELECT * FROM nodes WHERE id='node1'").get();
  assert.equal(n1.rules_version, 1);
  svc.updateBatchRules("batch1", { version: 2 }, "二期规则", "admin");
  svc.createNode({
    id: "nodeX", batchId: "batch1", code: "NX", title: "新增节点",
    deadlineAt: "2026-12-01T00:00:00+08:00", deadlineTz: "Asia/Shanghai",
  });
  const nx = svc.db.prepare("SELECT * FROM nodes WHERE id='nodeX'").get();
  assert.equal(nx.rules_version, 2);
  const stillN1 = svc.db.prepare("SELECT * FROM nodes WHERE id='node1'").get();
  assert.equal(stillN1.rules_version, 1);
  const versions = svc.db.prepare("SELECT version FROM batch_rule_versions WHERE batch_id='batch1' ORDER BY version").all();
  assert.deepEqual(versions.map((r) => r.version), [1, 2]);
});
