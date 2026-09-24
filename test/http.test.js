import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { createService } from "../src/service.js";
import { createApp } from "../src/app.js";

function harness() {
  const db = openDatabase(join(tmpdir(), `tf-http-${process.pid}-${Math.random().toString(16).slice(2)}.db`));
  const svc = createService(db, { clock: () => "2026-06-01T00:00:00.000Z" });
  const app = createApp(svc);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, headers: res.headers };
  }
  const stop = () =>
    new Promise((resolve) => server.close(resolve));
  return { svc, call, stop };
}

async function seed(h) {
  await h.call("POST", "/admin/organizations", { id: "org_o", name: "OC", kind: "overseas_school" });
  await h.call("POST", "/admin/organizations", { id: "org_e", name: "GC", kind: "enterprise" });
  await h.call("POST", "/admin/organizations", { id: "org_s", name: "S", kind: "school" });
  await h.call("POST", "/admin/users", { id: "m1", organizationId: "org_o", displayName: "M", kind: "mentor", canGrade: true });
  await h.call("POST", "/admin/users", { id: "r1", organizationId: "org_e", displayName: "R", kind: "enterprise_reviewer" });
  await h.call("POST", "/admin/users", { id: "a1", displayName: "A", kind: "academic_admin" });
  await h.call("POST", "/admin/users", { id: "s1", organizationId: "org_s", displayName: "S1", kind: "student" });
  await h.call("POST", "/batches", { id: "b1", code: "CB", title: "t", rule: { offlineReportWindowHours: 24, requireAllMentors: true } });
  await h.call("POST", "/batches/b1/parties", { organizationId: "org_o", role: "overseas_school" });
  await h.call("POST", "/batches/b1/parties", { organizationId: "org_e", role: "enterprise" });
  await h.call("POST", "/batches/b1/parties", { organizationId: "org_s", role: "school" });
  await h.call("POST", "/batches/b1/milestones", {
    id: "ms1", code: "M1", title: "m", deadlineAt: "2026-06-10T12:00:00.000Z",
    signingScope: { mentorIds: ["m1"], enterpriseRequired: true },
  });
  await h.call("POST", "/batches/b1/teams", { id: "t1", code: "T1", name: "team" });
  await h.call("POST", "/teams/t1/members", { userId: "s1" });
  await h.call("POST", "/milestones/ms1/deliverables", { id: "d1", kind: "team", teamId: "t1" });
}

test("HTTP: 健康检查", async () => {
  const h = harness();
  const r = await h.call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  await h.stop();
});

test("HTTP: 领域错误映射为状态码与错误体", async () => {
  const h = harness();
  await seed(h);
  // 无评分权限 → 403（尚未提交前其实先撞 no_submission；先提交）
  await h.call("POST", "/deliverables/d1/submissions",
    { contentSummary: "v1", contentHash: "h1", sourceTz: "Asia/Shanghai" },
    { "x-actor-id": "s1" });
  const r = await h.call("POST", "/deliverables/d1/decisions", { kind: "approved" }, { "x-actor-id": "s1" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "decide_role_invalid");
  await h.stop();
});

test("HTTP: Idempotency-Key 头保证重复提交重放同一回执", async () => {
  const h = harness();
  await seed(h);
  const payload = { contentSummary: "v1", contentHash: "h1", sourceTz: "Asia/Shanghai" };
  const r1 = await h.call("POST", "/deliverables/d1/submissions", payload, {
    "x-actor-id": "s1", "idempotency-key": "recv-001",
  });
  assert.equal(r1.status, 201);
  const r2 = await h.call("POST", "/deliverables/d1/submissions", payload, {
    "x-actor-id": "s1", "idempotency-key": "recv-001",
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.__replayed, true);
  assert.equal(r2.body.submission.id, r1.body.submission.id);
  await h.stop();
});

test("HTTP: 端到端签收—证书—结项—导出档案", async () => {
  const h = harness();
  await seed(h);
  await h.call("POST", "/deliverables/d1/submissions",
    { contentSummary: "v1", contentHash: "h1", sourceTz: "Asia/Shanghai" },
    { "x-actor-id": "s1" });
  assert.equal((await h.call("POST", "/deliverables/d1/decisions", { kind: "approved" }, { "x-actor-id": "m1" })).status, 201);
  assert.equal((await h.call("POST", "/deliverables/d1/decisions", { kind: "approved" }, { "x-actor-id": "r1" })).status, 201);

  const state = await h.call("GET", "/deliverables/d1");
  assert.equal(state.body.state, "complete");

  const dash = await h.call("GET", "/batches/b1/dashboard");
  assert.equal(dash.body.readyToClose, true);
  assert.equal(dash.body.missingConfirmations.length, 0);

  assert.equal((await h.call("POST", "/milestones/ms1/certificates", {})).status, 200);
  const closed = await h.call("POST", "/batches/b1/close", {}, { "x-actor-id": "a1" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.verified, true);
  assert.equal(closed.body.manifest.milestones[0].signing_scope_json.includes("m1"), true);

  const arc = await h.call("GET", "/batches/b1/archive");
  assert.equal(arc.body.manifestHash, closed.body.manifestHash);

  // 结项后改规则被冻结
  const frozen = await h.call("POST", "/batches/b1/rules",
    { reason: "x", patch: { graceMinutes: 1 } }, { "x-actor-id": "a1" });
  assert.equal(frozen.status, 409);
  await h.stop();
});
