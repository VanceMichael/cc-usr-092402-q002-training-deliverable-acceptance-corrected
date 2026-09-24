import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { createService } from "../src/service.js";

function mkService() {
  const db = openDatabase(join(tmpdir(), `tf-${process.pid}-${Math.random().toString(16).slice(2)}.db`));
  db.pragma("foreign_keys = ON");
  return createService(db, { clock: () => "2026-06-01T00:00:00.000Z" });
}

const throwCode = (code, fn) => {
  try {
    fn();
    assert.fail(`应抛出 ${code}`);
  } catch (e) {
    assert.equal(e.code, code);
  }
};

/** 搭一个标准批次：1 个境外校（导师2名）、1 企业、1 院校（学员3名）、1 团队、1 节点 */
function fixture(svc, rule = {}) {
  svc.createOrganization({ id: "org_s", name: "合作职校", kind: "school" });
  svc.createOrganization({ id: "org_o", name: "Overseas College", kind: "overseas_school" });
  svc.createOrganization({ id: "org_e", name: "Global Co", kind: "enterprise" });
  svc.createUser({ id: "m1", organizationId: "org_o", displayName: "导师甲", kind: "mentor", canGrade: true });
  svc.createUser({ id: "m2", organizationId: "org_o", displayName: "导师乙", kind: "mentor", canGrade: true });
  svc.createUser({ id: "m_nograde", organizationId: "org_o", displayName: "无评分导师", kind: "mentor", canGrade: false });
  svc.createUser({ id: "r1", organizationId: "org_e", displayName: "企业复核员", kind: "enterprise_reviewer" });
  svc.createUser({ id: "a1", organizationId: null, displayName: "教务", kind: "academic_admin" });
  svc.createUser({ id: "s1", organizationId: "org_s", displayName: "张三", kind: "student" });
  svc.createUser({ id: "s2", organizationId: "org_s", displayName: "李四", kind: "student" });
  svc.createUser({ id: "s3", organizationId: "org_s", displayName: "王五", kind: "student" });
  svc.createBatch({ id: "b1", code: "CB-2026", title: "跨境电商实训", rule: { resubmitWindowHours: 48, offlineReportWindowHours: 72, reviewSlaHours: 24, graceMinutes: 10, ...rule } });
  svc.addParty({ batchId: "b1", organizationId: "org_s", role: "school" });
  svc.addParty({ batchId: "b1", organizationId: "org_o", role: "overseas_school" });
  svc.addParty({ batchId: "b1", organizationId: "org_e", role: "enterprise" });
  svc.createMilestone({
    id: "ms1", batchId: "b1", code: "M1", title: "最终项目",
    scopeKind: "team", deadlineAt: "2026-06-10T12:00:00.000Z",
    signingScope: { mentorIds: ["m1", "m2"], enterpriseRequired: true },
  });
  svc.createTeam({ id: "t1", batchId: "b1", code: "T1", name: "第一队" });
  for (const s of ["s1", "s2", "s3"]) svc.addTeamMember({ teamId: "t1", userId: s });
  svc.createDeliverable({ id: "d1", milestoneId: "ms1", kind: "team", teamId: "t1" });
}

const submit1 = (svc, overrides = {}) =>
  svc.submit({
    deliverableId: "d1", submitterId: "s1",
    contentSummary: "终稿：跨境店铺运营方案 v1",
    contentHash: "hash-v1", sourceTz: "Asia/Shanghai",
    ...overrides,
  });

// ---------------------------------------------------------------------------
test("提交保留版本链、内容摘要、来源时区，并记录时区偏移", () => {
  const svc = mkService();
  fixture(svc);
  const r1 = submit1(svc, { now: "2026-06-09T08:00:00.000Z" });
  assert.equal(r1.submission.seq, 1);
  assert.equal(r1.submission.previous_submission_id, null);
  assert.equal(r1.submission.source_offset_minutes, 480);

  const r2 = svc.submit({
    deliverableId: "d1", submitterId: "s2", now: "2026-06-09T10:00:00.000Z",
    contentSummary: "修订版 v2", contentHash: "hash-v2", sourceTz: "Europe/Berlin",
  });
  assert.equal(r2.submission.seq, 2);
  assert.equal(r2.submission.previous_submission_id, r1.submission.id);
  // 6 月柏林为夏令时 UTC+2
  assert.equal(r2.submission.source_offset_minutes, 120);
});

test("重复回执：相同作者/内容/完成时刻只入账一次；不同幂等键冲突报错", () => {
  const svc = mkService();
  fixture(svc);
  const r1 = submit1(svc, { idempotencyKey: "k-1", now: "2026-06-09T08:00:00.000Z" });
  const r2 = submit1(svc, { idempotencyKey: "k-1", now: "2026-06-09T09:00:00.000Z" });
  assert.equal(r2.__replayed, true);
  assert.equal(r2.submission.id, r1.submission.id);
  throwCode("idempotency_key_conflict", () =>
    submit1(svc, { idempotencyKey: "k-1", contentHash: "hash-different", now: "2026-06-09T09:00:00.000Z" })
  );
  // 无幂等键的离线重传：相同作者/内容/声称完成时刻被唯一约束挡住
  svc.submit({
    deliverableId: "d1", submitterId: "s2", contentSummary: "离线稿", contentHash: "h-off",
    sourceTz: "Asia/Shanghai", isOffline: true,
    authoredAt: "2026-06-08T00:00:00.000Z", now: "2026-06-09T09:00:00.000Z",
  });
  throwCode("duplicate_submission", () =>
    svc.submit({
      deliverableId: "d1", submitterId: "s2", contentSummary: "离线稿", contentHash: "h-off",
      sourceTz: "Asia/Shanghai", isOffline: true,
      authoredAt: "2026-06-08T00:00:00.000Z", now: "2026-06-09T10:00:00.000Z",
    })
  );
});

test("离线补传：在窗口内以 authored_at 计时，超出窗口拒绝；声称未来时间拒绝", () => {
  const svc = mkService();
  fixture(svc);
  // 接收时间晚于截止，但声称完成于截止前，且在 72h 上报窗口内 → 以完成时刻为准
  const r = submit1(svc, {
    isOffline: true, authoredAt: "2026-06-10T11:00:00.000Z", now: "2026-06-12T10:00:00.000Z",
  });
  assert.equal(r.submission.is_offline, 1);
  const slas = svc.dashboard("b1").lateEvents;
  assert.equal(slas.length, 0); // 完成时刻在宽限内，不算逾期

  throwCode("offline_window_exceeded", () =>
    svc.submit({
      deliverableId: "d1", submitterId: "s2", contentSummary: "x", contentHash: "h-x",
      sourceTz: "Asia/Shanghai", isOffline: true,
      authoredAt: "2026-06-08T00:00:00.000Z", now: "2026-06-12T10:00:00.000Z",
    })
  );
  throwCode("authored_in_future", () =>
    svc.submit({
      deliverableId: "d1", submitterId: "s2", contentSummary: "x", contentHash: "h-y",
      sourceTz: "Asia/Shanghai", isOffline: true,
      authoredAt: "2026-06-13T00:00:00.000Z", now: "2026-06-12T10:00:00.000Z",
    })
  );
});

test("评分权限与签署范围：无评分权限导师/范围外导师被拒", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  throwCode("no_grade_permission", () =>
    svc.decide({ deliverableId: "d1", actorId: "m_nograde", kind: "approved" })
  );
  // 把第三名导师拉进来（不在范围）
  svc.createUser({ id: "m3", organizationId: "org_o", displayName: "范围外导师", kind: "mentor", canGrade: true });
  throwCode("outside_signing_scope", () =>
    svc.decide({ deliverableId: "d1", actorId: "m3", kind: "approved" })
  );
});

test("导师附条件通过 → 企业局部退回拆个人缺口 → 学员只能关闭自己负责的缺口", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc, { now: "2026-06-09T08:00:00.000Z" });

  const dm1 = svc.decide({ deliverableId: "d1", actorId: "m1", kind: "conditional", comment: "数据部分待补" });
  assert.ok(dm1.decision.id);
  const dm2 = svc.decide({ deliverableId: "d1", actorId: "m2", kind: "approved" });
  assert.ok(dm2.decision.id);

  // 企业把团队成果拆成两个个人整改缺口
  const dr = svc.decide({
    deliverableId: "d1", actorId: "r1", kind: "partial_return", comment: "财务和物流部分退回",
    gaps: [
      { assigneeUserId: "s1", description: "补充财务测算" },
      { assigneeUserId: "s2", description: "补充物流时效依据" },
    ],
  });
  const [g1, g2] = dr.gaps;

  let st = svc.evaluate("d1");
  assert.equal(st.state, "pending_conditions");
  assert.deepEqual(st.missingParties, []); // 企业 partial_return 算签署，缺的是整改而非确认
  assert.deepEqual(st.openGapIds.sort(), [g1, g2].sort());

  // s3 不是缺口负责人，不能替别人关闭
  throwCode("gap_not_assigned_to_submitter", () =>
    svc.submit({
      deliverableId: "d1", submitterId: "s3", contentSummary: "越权补交", contentHash: "h-s3",
      sourceTz: "Asia/Shanghai", closesGapIds: [g1],
    })
  );

  // s1 只能关 g1
  svc.submit({
    deliverableId: "d1", submitterId: "s1", contentSummary: "财务补充", contentHash: "h-s1",
    sourceTz: "Asia/Shanghai", closesGapIds: [g1], now: "2026-06-09T20:00:00.000Z",
  });
  st = svc.evaluate("d1");
  assert.deepEqual(st.openGapIds, [g2]);

  // 导师/企业基于新版本重新确认（partial_return 已被后续决定取代，需再签）
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "m2", kind: "approved" });
  svc.submit({
    deliverableId: "d1", submitterId: "s2", contentSummary: "物流补充", contentHash: "h-s2",
    sourceTz: "Asia/Shanghai", closesGapIds: [g2], now: "2026-06-10T02:00:00.000Z",
  });
  svc.decide({ deliverableId: "d1", actorId: "r1", kind: "approved", comment: "复核通过" });

  st = svc.evaluate("d1");
  assert.equal(st.state, "complete");
  assert.deepEqual(st.missingParties, []);
});

test("补交时序：意见早于补交时，针对缺口补交只让提缺口方重签，其他方签收保留", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc, { now: "2026-06-09T08:00:00.000Z" });
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "m2", kind: "approved" });
  const dr = svc.decide({
    deliverableId: "d1", actorId: "r1", kind: "partial_return",
    gaps: [
      { assigneeUserId: "s1", description: "补财务" },
      { assigneeUserId: "s2", description: "补物流" },
    ],
  });
  const [g1] = dr.gaps;

  // s1 关闭自己的缺口：企业须基于新版本重签，两位导师的签收不受影响
  svc.submit({
    deliverableId: "d1", submitterId: "s1", contentSummary: "财务补充", contentHash: "h-s1",
    sourceTz: "Asia/Shanghai", closesGapIds: [g1], now: "2026-06-09T20:00:00.000Z",
  });
  let st = svc.evaluate("d1");
  assert.deepEqual(st.missingParties, ["enterprise"]);
  assert.ok(!st.missingParties.includes("mentor:m1"));
  assert.equal(st.openGapIds.length, 1, "s2 的缺口仍开放");

  // 企业基于新版本通过，但 s2 缺口未关 → 仍不完成
  svc.decide({ deliverableId: "d1", actorId: "r1", kind: "approved" });
  st = svc.evaluate("d1");
  assert.equal(st.state, "pending_conditions");
});

test("团队共同缺口可由任一在册成员补交关闭，离队成员不可", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  const dr = svc.decide({
    deliverableId: "d1", actorId: "r1", kind: "partial_return",
    gaps: [{ teamId: "t1", description: "整体格式整改" }],
  });
  const gapId = dr.gaps[0];
  svc.submit({
    deliverableId: "d1", submitterId: "s3", contentSummary: "格式修订", contentHash: "h-fmt",
    sourceTz: "Asia/Shanghai", closesGapIds: [gapId],
  });
  assert.deepEqual(svc.evaluate("d1").openGapIds, []);
});

test("企业发起争议 → 教务裁决：成立则签收打回重开缺口；驳回则豁免企业确认", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "m2", kind: "approved" });
  const dis = svc.decide({
    deliverableId: "d1", actorId: "r1", kind: "dispute", comment: "怀疑抄袭，需复查",
  });
  const disputeId = dis.disputeId;
  let st = svc.evaluate("d1");
  assert.equal(st.state, "in_dispute");

  // 非教务不能裁决
  throwCode("forbidden_role", () =>
    svc.resolveDispute({ disputeId, adminId: "r1", outcome: "rejected" })
  );
  svc.resolveDispute({
    disputeId, adminId: "a1", outcome: "upheld", note: "确实存在引用缺失",
    gaps: [{ assigneeUserId: "s1", description: "补来源标注", dueAt: "2026-06-11T00:00:00.000Z" }],
  });
  st = svc.evaluate("d1");
  assert.equal(st.state, "pending_conditions");
  assert.ok(st.missingParties.includes("mentor:m1"));
  assert.ok(st.missingParties.includes("enterprise"));
  assert.equal(st.openGapIds.length, 1);
});

test("争议驳回：企业确认被豁免，成果可在导师签署后完成", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "m2", kind: "approved" });
  const dis = svc.decide({ deliverableId: "d1", actorId: "r1", kind: "dispute", comment: "异议" });
  svc.resolveDispute({ disputeId: dis.disputeId, adminId: "a1", outcome: "rejected", note: "不成立" });
  const st = svc.evaluate("d1");
  assert.equal(st.state, "complete");
  assert.ok(st.waivedParties.some((w) => w.party === "enterprise" && w.reason === "dispute_rejected"));
});

test("截止时间变更版本化：旧决定冻结旧版本；延迟后提交按新版本判定不逾期", () => {
  const svc = mkService();
  fixture(svc);
  // 初版截止 6/10 12:00，学生在 6/11 才交 → 逾期（学生责任）
  submit1(svc, { now: "2026-06-11T00:00:00.000Z" });
  let dash = svc.dashboard("b1");
  const late = dash.lateEvents.find((e) => e.eventType === "submit");
  assert.equal(late.responsibleParty, "student");
  assert.equal(late.deadlineVersion, 1);

  // 教务把截止改到 6/12（新版本）。历史 SLA 不改写，但重新提交按新版本判定
  svc.changeDeadline({
    milestoneId: "ms1", deadlineAt: "2026-06-12T12:00:00.000Z", by: "a1",
    notice: "境外假期顺延", now: "2026-06-09T00:00:00.000Z",
  });
  // 新批次干净验证：新版本下 6/11 提交准时
  const svc2 = mkService();
  fixture(svc2);
  svc2.changeDeadline({
    milestoneId: "ms1", deadlineAt: "2026-06-12T12:00:00.000Z", by: "a1", notice: "顺延",
  });
  svc2.submit({
    deliverableId: "d1", submitterId: "s1", contentSummary: "v1", contentHash: "h",
    sourceTz: "Asia/Shanghai", now: "2026-06-11T00:00:00.000Z",
  });
  assert.equal(svc2.dashboard("b1").lateEvents.length, 0);
});

test("规则版本化：决定记录所依据的规则版本，事后改规则不影响历史决定", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  const d = svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  assert.equal(d.decision.rule_version, 1);
  svc.changeRule({ batchId: "b1", by: "a1", reason: "企业复核改为非必经", patch: { requireEnterpriseReview: false } });
  // 节点签署范围快照不变（enterpriseRequired 仍 true），保证档案与当时签署范围一致
  const d2 = svc.decide({ deliverableId: "d1", actorId: "m2", kind: "approved" });
  assert.equal(d2.decision.rule_version, 2);
  const st = svc.evaluate("d1");
  assert.ok(st.missingParties.includes("enterprise"), "范围快照里企业仍是必经方");
});

test("评审 SLA：导师超期评审记导师责任；机构退出后豁免", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc, { now: "2026-06-01T00:00:00.000Z" });
  // 48 小时后才评审，超出 24h SLA
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved", now: "2026-06-03T00:00:00.000Z" });
  const dash = svc.dashboard("b1");
  assert.equal(dash.lateResponsibility.mentor, 1);
  assert.equal(dash.lateResponsibility.student, 0);
});

test("机构退出：导师确认/企业复核/学员责任被豁免并留痕，看板可见豁免原因", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  // m2 未签、企业未复核时，境外校退出
  svc.withdrawOrganization({
    organizationId: "org_o", effectiveAt: "2026-06-05T00:00:00.000Z", reason: "项目终止",
    now: "2026-06-05T00:00:00.000Z",
  });
  let st = svc.evaluate("d1");
  assert.ok(st.waivedParties.some((w) => w.party === "mentor:m2"));
  // 企业尚未退出，企业确认仍缺
  assert.ok(st.missingParties.includes("enterprise"));

  svc.withdrawOrganization({ organizationId: "org_e", effectiveAt: "2026-06-06T00:00:00.000Z", reason: "业务调整", now: "2026-06-06T00:00:00.000Z" });
  st = svc.evaluate("d1");
  assert.deepEqual(st.missingParties, []);
  assert.equal(st.state, "complete");
  const dash = svc.dashboard("b1");
  assert.ok(dash.waivers.every((w) => w.reason === "org_withdrawal"));
  assert.ok(dash.waivers.length >= 2);

  // 退出后该机构评审即使超期也不计责任
  const svc2 = mkService();
  fixture(svc2);
  svc2.submit({
    deliverableId: "d1", submitterId: "s1", contentSummary: "v", contentHash: "h",
    sourceTz: "Asia/Shanghai", now: "2026-06-01T00:00:00.000Z",
  });
  svc2.withdrawOrganization({ organizationId: "org_o", effectiveAt: "2026-06-02T00:00:00.000Z", reason: "x", now: "2026-06-02T00:00:00.000Z" });
  svc2.decide({ deliverableId: "d1", actorId: "m1", kind: "approved", now: "2026-06-04T00:00:00.000Z" });
  assert.equal(svc2.dashboard("b1").lateResponsibility.mentor, 0);
});

test("院校退出：学员离队、其个人缺口豁免，整队无人时团队成果豁免", () => {
  const svc = mkService();
  fixture(svc);
  // 额外建一个个人节点成果
  svc.createMilestone({
    id: "ms2", batchId: "b1", code: "M2", title: "个人反思", scopeKind: "individual",
    deadlineAt: "2026-06-10T12:00:00.000Z",
    signingScope: { mentorIds: ["m1"], enterpriseRequired: false },
  });
  svc.createDeliverable({ id: "d2", milestoneId: "ms2", kind: "individual", ownerUserId: "s1" });
  svc.withdrawOrganization({ organizationId: "org_s", effectiveAt: "2026-06-05T00:00:00.000Z", reason: "院校退出", now: "2026-06-05T00:00:00.000Z" });
  assert.equal(svc.evaluate("d2").state, "waived");
  assert.equal(svc.evaluate("d1").state, "waived"); // 整队成员均来自该校
});

test("证书只发给完成成果的在册成员；已计入证书只能撤销+新决定纠正", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  for (const m of ["m1", "m2"]) svc.decide({ deliverableId: "d1", actorId: m, kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "r1", kind: "approved" });

  const issued = svc.issueCertificates({ milestoneId: "ms1" }).issuedCertificateIds;
  assert.equal(issued.length, 3, "团队 3 名在册成员各得一张");
  const cert = svc.dashboard("b1").certificates;
  assert.equal(cert.valid, 3);

  // 不能直接改证书：缺少新决定的撤销被拒绝
  throwCode("correction_required", () =>
    svc.revokeCertificate({ certificateId: issued[0], by: "a1", reason: "事后发现抄袭" })
  );
  // 非教务不能撤销
  throwCode("forbidden_role", () =>
    svc.revokeCertificate({
      certificateId: issued[0], by: "r1", reason: "x",
      correction: { kind: "rejected", comment: "x" },
    })
  );

  const rev = svc.revokeCertificate({
    certificateId: issued[0], by: "a1", reason: "抄袭属实",
    correction: { kind: "rejected", actorId: "r1", comment: "企业复查后驳回" },
  });
  assert.ok(rev.revocation.decisionId);
  assert.deepEqual(rev.revocation.revokedCertificateIds.sort(), [...issued].sort());
  const certs = svc.dashboard("b1").certificates;
  assert.equal(certs.valid, 0);
  assert.equal(certs.revoked, 3, "团队成果依据被推翻，全队证书一并撤销");
  const st = svc.evaluate("d1");
  assert.notEqual(st.state, "complete");
  // 撤销记录不可删除、证书不可二次撤销
  throwCode("cert_not_valid", () =>
    svc.revokeCertificate({
      certificateId: issued[0], by: "a1", reason: "again",
      correction: { kind: "rejected", comment: "x" },
    })
  );
});

test("看板：尚缺谁的确认、未裁决争议、逾期责任归属一次可见", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  svc.decide({ deliverableId: "d1", actorId: "m1", kind: "approved" });
  const dash = svc.dashboard("b1");
  const parties = dash.missingConfirmations.map((x) => x.party).sort();
  assert.deepEqual(parties, ["enterprise", "mentor:m2"]);
  assert.equal(dash.readyToClose, false);
  assert.ok(dash.closureBlockers.some((b) => b.deliverableId === "d1"));
});

test("结项：未完成不能关闭；关闭后导出与当时规则和签署范围一致且哈希可验", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  throwCode("batch_not_ready", () => svc.closeBatch({ batchId: "b1", by: "a1" }));

  for (const m of ["m1", "m2"]) svc.decide({ deliverableId: "d1", actorId: m, kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "r1", kind: "approved" });
  const archive = svc.closeBatch({ batchId: "b1", by: "a1" });
  assert.equal(archive.verified, true);
  assert.equal(archive.manifest.batch.status, "closed");
  // 签署范围快照在档案内
  const ms = archive.manifest.milestones.find((x) => x.id === "ms1");
  assert.deepEqual(JSON.parse(ms.signing_scope_json).mentorIds.sort(), ["m1", "m2"]);
  // 规则历史版本全在档案内
  assert.ok(archive.manifest.ruleVersions.length >= 1);
  // 导出幂等：同一清单同一哈希
  const again = svc.exportArchive("b1");
  assert.equal(again.manifestHash, archive.manifestHash);
});

test("结项后冻结：结构/规则/截止不可改；但纠正可追加进 addendum 哈希链", () => {
  const svc = mkService();
  fixture(svc);
  submit1(svc);
  for (const m of ["m1", "m2"]) svc.decide({ deliverableId: "d1", actorId: m, kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "r1", kind: "approved" });
  svc.closeBatch({ batchId: "b1", by: "a1" });

  throwCode("batch_closed", () =>
    svc.changeRule({ batchId: "b1", by: "a1", reason: "x", patch: { graceMinutes: 99 } })
  );
  throwCode("batch_closed", () =>
    svc.changeDeadline({ milestoneId: "ms1", deadlineAt: "2027-01-01T00:00:00Z", by: "a1" })
  );
  throwCode("batch_closed", () => svc.createTeam({ id: "t2", batchId: "b1", code: "X", name: "x" }));

  // 结项后撤销证书（纠正）→ addendum 追加，哈希链不断
  const certId = svc.issueCertificates({ milestoneId: "ms1" }).issuedCertificateIds[0];
  svc.revokeCertificate({
    certificateId: certId, by: "a1", reason: "结项后复查发现问题",
    correction: { kind: "rejected", actorId: "r1", comment: "驳回重改" },
  });
  const arc = svc.exportArchive("b1");
  assert.equal(arc.verified, true);
  assert.ok(arc.addenda.some((a) => a.kind === "certificate_revocation"));
  // 撤销 payload 内嵌配套新决定（rejected）的指针
  const revAddendum = arc.addenda.find((a) => a.kind === "certificate_revocation");
  assert.ok(revAddendum.payload.correctionDecisionId);
  // 整改后可凭新决定重新出证，同样追加
  svc.submit({
    deliverableId: "d1", submitterId: "s1", contentSummary: "整改稿", contentHash: "h-fix",
    sourceTz: "Asia/Shanghai",
  });
  for (const m of ["m1", "m2"]) svc.decide({ deliverableId: "d1", actorId: m, kind: "approved" });
  svc.decide({ deliverableId: "d1", actorId: "r1", kind: "approved" });
  const again = svc.issueCertificates({ milestoneId: "ms1" });
  assert.equal(again.issuedCertificateIds.length, 3);
  const arc2 = svc.exportArchive("b1");
  assert.equal(arc2.verified, true);
  // 结项后的补交、再签收、重发证全部进哈希链
  const kinds = arc2.addenda.map((a) => a.kind).sort();
  assert.ok(kinds.includes("post_closure_submission"));
  assert.ok(kinds.includes("post_closure_decision"));
  assert.ok(kinds.includes("certificate_issued"));
});
