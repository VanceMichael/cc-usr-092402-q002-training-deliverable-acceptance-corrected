import Koa from "koa";
import { DomainError } from "./util.js";

const STATUS_BY_CODE = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  OUT_OF_SCOPE: 403,
  NOT_ELIGIBLE: 409,
  CONFLICT: 409,
  REVOKED: 409,
  FROZEN: 409,
  CERT_LOCKED: 409,
  INSTITUTION_EXITED: 409,
};

export function createApp(svc) {
  const app = new Koa();

  app.use(async (ctx) => {
    if (ctx.path === "/health") {
      svc.db.prepare("select 1").get();
      ctx.body = { status: "ok" };
      return;
    }
    if (!ctx.path.startsWith("/api/")) return;

    try {
      const body = ["POST", "PUT", "PATCH"].includes(ctx.method)
        ? await parseJson(ctx)
        : {};
      const actor = ctx.headers["x-actor-id"] ?? body.actorId ?? null;
      ctx.body = await route(ctx, body, actor);
      if (ctx.body === undefined) ctx.status = 204;
    } catch (err) {
      if (err instanceof DomainError) {
        ctx.status = STATUS_BY_CODE[err.code] ?? 400;
        const { name, stack, ...rest } = err;
        ctx.body = { error: err.code, message: err.message, ...rest };
      } else if (err instanceof SyntaxError) {
        ctx.status = 400;
        ctx.body = { error: "VALIDATION", message: "请求体不是合法 JSON" };
      } else {
        ctx.status = 500;
        ctx.body = { error: "INTERNAL", message: err.message };
      }
    }
  });

  async function parseJson(ctx) {
    if (!ctx.request.length && !ctx.req.readable) return {};
    const chunks = [];
    for await (const chunk of ctx.req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }

  const needActor = (actor) => {
    if (!actor) throw new DomainError("VALIDATION", "缺少请求头 x-actor-id");
    return actor;
  };

  async function route(ctx, b, actor) {
    const p = ctx.path.split("/").filter(Boolean); // ['api', ...]
    const m = ctx.method;

    // ---- 基础数据 ----
    if (m === "POST" && p[1] === "institutions" && p.length === 2) {
      return svc.createInstitution({ id: b.id, name: b.name });
    }
    if (m === "POST" && p[1] === "users" && p.length === 2) {
      return svc.createUser({
        id: b.id, institutionId: b.institutionId, name: b.name,
        role: b.role, timezone: b.timezone,
      });
    }
    if (m === "POST" && p[1] === "batches" && p.length === 2) {
      return svc.createBatch({ id: b.id, code: b.code, title: b.title, rules: b.rules });
    }
    if (m === "GET" && p[1] === "batches" && p.length === 3) {
      return svc.db.prepare("SELECT * FROM batches WHERE id = ?").get(p[2]);
    }
    if (m === "POST" && eq(p, ["api", "batches", null, "rules"])) {
      return svc.updateBatchRules(p[2], b.rules, b.note, needActor(actor));
    }
    if (m === "POST" && eq(p, ["api", "batches", null, "staff"])) {
      return svc.addStaff({
        batchId: p[2], userId: b.userId, role: b.role,
        canScore: b.canScore, maxScore: b.maxScore, scopeTeamId: b.scopeTeamId,
      });
    }
    if (m === "POST" && p[1] === "teams" && p.length === 2) {
      const team = svc.createTeam({ id: b.id, batchId: b.batchId, name: b.name });
      if (Array.isArray(b.memberIds)) for (const uid of b.memberIds) svc.addTeamMember(team.id, uid);
      return team;
    }
    if (m === "POST" && eq(p, ["api", "teams", null, "members"])) {
      svc.addTeamMember(p[2], b.userId);
      return { ok: true };
    }
    if (m === "POST" && p[1] === "nodes" && p.length === 2) {
      return svc.createNode({
        id: b.id, batchId: b.batchId, code: b.code, title: b.title,
        deadlineAt: b.deadlineAt, deadlineTz: b.deadlineTz, signingScope: b.signingScope,
      });
    }
    if (m === "POST" && eq(p, ["api", "nodes", null, "deadline-changes"])) {
      return svc.changeDeadline({
        nodeId: p[2], newDeadlineAt: b.newDeadlineAt, reason: b.reason,
        responsibleParty: b.responsibleParty, actorId: needActor(actor),
      });
    }

    // ---- 成果与提交 ----
    if (m === "POST" && p[1] === "deliverables" && p.length === 2) {
      return svc.createDeliverable({
        id: b.id, nodeId: b.nodeId, teamId: b.teamId, ownerUserId: b.ownerUserId,
        title: b.title, kind: b.kind,
      });
    }
    if (m === "GET" && eq(p, ["api", "deliverables", null]) && p.length === 3) {
      const id = p[2];
      return {
        deliverable: svc.db.prepare("SELECT * FROM deliverables WHERE id = ?").get(id),
        versions: svc.db.prepare(
          "SELECT * FROM submission_versions WHERE deliverable_id = ? ORDER BY version_no",
        ).all(id),
        signoffs: svc.db.prepare(
          "SELECT * FROM signoffs WHERE deliverable_id = ? ORDER BY created_at",
        ).all(id),
        gaps: svc.db.prepare("SELECT * FROM gaps WHERE deliverable_id = ? ORDER BY created_at").all(id),
      };
    }
    if (m === "POST" && eq(p, ["api", "deliverables", null, "submissions"])) {
      return svc.submitVersion({
        deliverableId: p[2], summary: b.summary, sourceTz: b.sourceTz,
        submittedBy: needActor(actor), clientEventId: b.clientEventId,
        occurredAt: b.occurredAt, isBackfill: b.isBackfill, predecessorId: b.predecessorId,
      });
    }
    if (m === "POST" && eq(p, ["api", "deliverables", null, "signoffs"])) {
      return svc.recordSignoff({
        nodeId: b.nodeId, deliverableId: p[2], signerUserId: needActor(actor),
        party: b.party, decision: b.decision, score: b.score, comment: b.comment,
        receiptKey: b.receiptKey, versionId: b.versionId,
        gaps: b.gaps ?? [], disputeReason: b.disputeReason,
      });
    }
    if (m === "GET" && eq(p, ["api", "deliverables", null, "eligibility"])) {
      return svc.certificateEligibility(p[2]);
    }
    if (m === "POST" && eq(p, ["api", "deliverables", null, "revoke"])) {
      return svc.revokeForCorrection({
        deliverableId: p[2], reason: b.reason, adminUserId: needActor(actor),
      });
    }

    // ---- 缺口 / 争议 ----
    if (m === "POST" && eq(p, ["api", "gaps", null, "split"])) {
      return svc.splitTeamGap({
        gapId: p[2], reviewerUserId: needActor(actor), assignments: b.assignments,
      });
    }
    if (m === "POST" && eq(p, ["api", "gaps", null, "close"])) {
      return svc.closeGapWithSubmission({
        gapId: p[2], studentUserId: needActor(actor), versionId: b.versionId,
      });
    }
    if (m === "POST" && eq(p, ["api", "disputes", null, "resolve"])) {
      return svc.resolveDispute({
        disputeId: p[2], outcome: b.outcome, resolution: b.resolution,
        deciderUserId: needActor(actor),
      });
    }

    // ---- 机构退出 ----
    if (m === "POST" && eq(p, ["api", "institutions", null, "exit"])) {
      return svc.exitInstitution({
        institutionId: p[2], batchId: b.batchId, reason: b.reason,
        effectiveAt: b.effectiveAt, actorId: needActor(actor),
      });
    }

    // ---- 证书与撤销重裁 ----
    if (m === "POST" && p[1] === "certificates" && p.length === 2) {
      return svc.countCertificate({
        batchId: b.batchId, userId: b.userId, deliverableId: b.deliverableId,
        versionId: b.versionId, actorId: needActor(actor),
      });
    }
    if (m === "POST" && eq(p, ["api", "revocations", null, "new-decision"])) {
      return svc.recordNewDecision({
        revocationId: p[2], successorDeliverableId: b.successorDeliverableId,
        deciderUserId: needActor(actor), decision: b.decision, score: b.score,
        comment: b.comment, versionId: b.versionId, gaps: b.gaps ?? [],
      });
    }

    // ---- 看板 / 档案 / 结项 ----
    if (m === "GET" && eq(p, ["api", "batches", null, "dashboard"])) {
      return svc.dashboard(p[2]);
    }
    if (m === "POST" && eq(p, ["api", "batches", null, "archive"])) {
      return svc.exportArchive({ batchId: p[2], actorId: needActor(actor) });
    }
    if (m === "POST" && eq(p, ["api", "batches", null, "close"])) {
      return svc.closeBatch(p[2], needActor(actor));
    }

    ctx.status = 404;
    return { error: "NOT_FOUND", message: "未知接口" };
  }

  return app;
}

function eq(parts, pattern) {
  if (parts.length !== pattern.length) return false;
  return pattern.every((seg, i) => seg === null || seg === parts[i]);
}
