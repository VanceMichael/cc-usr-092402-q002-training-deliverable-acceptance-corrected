import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { createServices } from "../src/domain.js";
import { createApp } from "../src/app.js";
import { standardFixture } from "./helpers.js";

async function withServer(fn) {
  const db = openDb(":memory:");
  const svc = createServices(db);
  const app = createApp(svc);
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const req = async (method, path, body, actorId) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(actorId ? { "x-actor-id": actorId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  };
  try {
    await fn(req, svc);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("HTTP: 健康检查", async () => {
  await withServer(async (req) => {
    const r = await req("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
  });
});

test("HTTP: 建批→成果→双方签收→看板→档案 全链路", async () => {
  await withServer(async (req, svc) => {
    standardFixture(svc);

    let r = await req("POST", "/api/deliverables", {
      id: "dlv1", nodeId: "node1", teamId: "team1", title: "团队报告", kind: "team",
    });
    assert.equal(r.status, 200);

    r = await req("POST", "/api/deliverables/dlv1/submissions",
      { summary: "初稿", sourceTz: "Asia/Shanghai" }, "stuA");
    assert.equal(r.status, 200);
    assert.equal(r.json.version_no, 1);

    // 缺少 actor 头 → 400
    r = await req("POST", "/api/deliverables/dlv1/submissions", { summary: "无主" });
    assert.equal(r.status, 400);

    // 导师附条件通过（评分权限内）
    r = await req("POST", "/api/deliverables/dlv1/signoffs", {
      nodeId: "node1", party: "mentor", decision: "conditional", score: 80,
      receiptKey: "R1", gaps: [{ title: "补数据来源" }],
    }, "mentor");
    assert.equal(r.status, 200);

    // 重复回执：不同 comment，同一 receiptKey → 回放
    r = await req("POST", "/api/deliverables/dlv1/signoffs", {
      nodeId: "node1", party: "mentor", decision: "conditional", score: 80,
      receiptKey: "R1", comment: "重发", gaps: [{ title: "不应再生效" }],
    }, "mentor");
    assert.equal(r.status, 200);
    assert.equal(r.json.replayed, true);

    // 越权评分：企业复核无评分权打分 → 403
    r = await req("POST", "/api/deliverables/dlv1/signoffs", {
      nodeId: "node1", party: "enterprise", decision: "approved", score: 50, receiptKey: "E0",
    }, "reviewer");
    assert.equal(r.status, 403);

    // 企业复核正常通过
    r = await req("POST", "/api/deliverables/dlv1/signoffs", {
      nodeId: "node1", party: "enterprise", decision: "approved", receiptKey: "E1",
    }, "reviewer");
    assert.equal(r.status, 200);

    // 看板：成果仍有一个开放缺口
    r = await req("GET", "/api/batches/batch1/dashboard");
    assert.equal(r.status, 200);
    const d = r.json.nodes[0].deliverables[0];
    assert.equal(d.gaps.filter((g) => g.status === "open").length, 1);
    assert.deepEqual(
      d.missingConfirmations.map((x) => x.party),
      [],
    ); // 两方都已给通过/附条件确认

    // 学员补交关闭缺口
    const v2 = await req("POST", "/api/deliverables/dlv1/submissions",
      { summary: "补：数据来源清单" }, "stuA");
    const gapId = d.gaps.find((g) => g.status === "open").gapId;
    r = await req("POST", `/api/gaps/${gapId}/close`, { versionId: v2.json.id }, "stuA");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "closed");

    // B 不能关闭 A 的个人缺口（此处为团队缺口，A 已关，再关返回回放/409）
    // 档案导出
    r = await req("POST", "/api/batches/batch1/archive", {}, "admin");
    assert.equal(r.status, 200);
    assert.ok(r.json.contentHash);
    assert.equal(r.json.archive.nodes[0].node.rulesVersion, 1);

    // 非教务导档 → 403
    r = await req("POST", "/api/batches/batch1/archive", {}, "mentor");
    assert.equal(r.status, 403);
  });
});

test("HTTP: 未知接口返回 404", async () => {
  await withServer(async (req) => {
    const r = await req("GET", "/api/nope");
    assert.equal(r.status, 404);
  });
});
