import Koa from "koa";
import { DomainError } from "./errors.js";

/**
 * HTTP 适配层。
 * 鉴权为演示用：调用方通过 X-Actor-Id 表明身份；写请求可用 Idempotency-Key 获得确定性重放。
 */
export function createApp(service) {
  const app = new Koa();

  app.use(async (ctx) => {
    try {
      await route(ctx, service);
    } catch (e) {
      if (e instanceof DomainError) {
        ctx.status = e.status;
        ctx.body = { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
        return;
      }
      if (e instanceof SyntaxError) {
        ctx.status = 400;
        ctx.body = { error: { code: "bad_json", message: "请求体不是合法 JSON" } };
        return;
      }
      ctx.status = 500;
      ctx.body = { error: { code: "internal", message: e.message } };
      ctx.app.emit("error", e, ctx);
    }
  });

  return app;
}

async function route(ctx, svc) {
  const p = ctx.path.replace(/\/+$/, "") || "/";
  const m = ctx.method;

  if (m === "GET" && p === "/health") {
    ctx.body = { status: "ok" };
    return;
  }

  const actor = ctx.request.headers["x-actor-id"] ?? null;
  const idem = ctx.request.headers["idempotency-key"] ?? null;
  const body = m === "GET" ? {} : await readJson(ctx);

  const match = (method, pattern, handler) => {
    if (m !== method) return false;
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => `(?<${k}>[^/]+)`)}$`);
    const r = re.exec(p);
    if (!r) return false;
    handler({ ...r.groups, ...body, ...(actor ? { actorId: actor } : {}) }, { idem, ctx });
    return true;
  };

  const routes = [
    ["POST", "/admin/organizations", (q) => ok(ctx, svc.createOrganization(q))],
    ["POST", "/admin/users", (q) => ok(ctx, svc.createUser(q))],
    ["POST", "/batches", (q) => ok(ctx, svc.createBatch(q), 201)],
    ["POST", "/batches/:batchId/parties", (q) => ok(ctx, svc.addParty(q))],
    ["POST", "/batches/:batchId/rules", (q) =>
      ok(ctx, svc.changeRule({ batchId: q.batchId, by: actor ?? q.by, reason: q.reason, patch: q.patch, now: q.now }))],
    ["GET", "/batches/:batchId/dashboard", (q) => ok(ctx, svc.dashboard(q.batchId))],
    ["POST", "/batches/:batchId/close", (q) =>
      ok(ctx, svc.closeBatch({ batchId: q.batchId, by: actor ?? q.by, now: q.now }))],
    ["GET", "/batches/:batchId/archive", (q) => ok(ctx, svc.exportArchive(q.batchId))],
    ["POST", "/batches/:batchId/teams", (q) =>
      ok(ctx, svc.createTeam({ id: q.id, batchId: q.batchId, code: q.code, name: q.name }), 201)],
    ["POST", "/teams/:teamId/members", (q) => ok(ctx, svc.addTeamMember({ teamId: q.teamId, userId: q.userId, role: q.role }))],
    ["POST", "/batches/:batchId/milestones", (q) =>
      ok(ctx, svc.createMilestone({
        id: q.id, batchId: q.batchId, code: q.code, title: q.title,
        scopeKind: q.scopeKind, deadlineAt: q.deadlineAt, signingScope: q.signingScope, now: q.now,
      }), 201)],
    ["POST", "/milestones/:milestoneId/deadline", (q) =>
      ok(ctx, svc.changeDeadline({
        milestoneId: q.milestoneId, deadlineAt: q.deadlineAt, by: actor ?? q.by, notice: q.notice, now: q.now,
      }))],
    ["POST", "/milestones/:milestoneId/deliverables", (q) =>
      ok(ctx, svc.createDeliverable({
        id: q.id, milestoneId: q.milestoneId, kind: q.kind, teamId: q.teamId, ownerUserId: q.ownerUserId,
      }), 201)],
    ["POST", "/milestones/:milestoneId/certificates", (q) =>
      ok(ctx, svc.issueCertificates({ milestoneId: q.milestoneId, now: q.now }))],
    ["POST", "/organizations/:organizationId/withdraw", (q) =>
      ok(ctx, svc.withdrawOrganization({
        organizationId: q.organizationId, effectiveAt: q.effectiveAt, reason: q.reason, now: q.now,
      }))],
    ["POST", "/deliverables/:deliverableId/submissions", (q) =>
      ok(ctx, svc.submit({
        deliverableId: q.deliverableId, submitterId: actor ?? q.submitterId,
        contentSummary: q.contentSummary, contentHash: q.contentHash, sourceTz: q.sourceTz,
        authoredAt: q.authoredAt, isOffline: !!q.isOffline, closesGapIds: q.closesGapIds ?? [],
        storageRef: q.storageRef, idempotencyKey: idem, now: q.now,
      }), 201)],
    ["POST", "/deliverables/:deliverableId/decisions", (q) =>
      ok(ctx, svc.decide({
        deliverableId: q.deliverableId, actorId: actor ?? q.actorId, kind: q.kind, comment: q.comment,
        basedOnSubmissionId: q.basedOnSubmissionId, gaps: q.gaps ?? [], idempotencyKey: idem, now: q.now,
      }), 201)],
    ["GET", "/deliverables/:deliverableId", (q) => ok(ctx, svc.evaluate(q.deliverableId))],
    ["POST", "/disputes/:disputeId/resolve", (q) =>
      ok(ctx, svc.resolveDispute({
        disputeId: q.disputeId, adminId: actor ?? q.adminId, outcome: q.outcome,
        note: q.note, gaps: q.gaps ?? [], now: q.now,
      }))],
    ["POST", "/certificates/:certificateId/revoke", (q) =>
      ok(ctx, svc.revokeCertificate({
        certificateId: q.certificateId, by: actor ?? q.by, reason: q.reason, correction: q.correction, now: q.now,
      }))],
  ];

  for (const [method, pattern, handler] of routes) {
    if (match(method, pattern, handler)) return;
  }
  ctx.status = 404;
  ctx.body = { error: { code: "not_found", message: `无此路由：${m} ${p}` } };
}

function ok(ctx, value, status = 200) {
  ctx.status = status;
  ctx.body = value;
}

async function readJson(ctx) {
  if (ctx.method === "GET" || ctx.method === "HEAD") return {};
  const chunks = [];
  for await (const chunk of ctx.req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}
