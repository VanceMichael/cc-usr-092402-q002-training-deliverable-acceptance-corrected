import { openDb } from "../src/db.js";
import { createServices } from "../src/domain.js";

// 每个用例一份全新内存库。
export function freshServices() {
  const db = openDb(":memory:");
  return createServices(db);
}

// 标准布景：一个批次、一个节点、导师 M（有评分权，上限 90）、企业复核 E、
// 学员 A/B 同属团队 T、学员 C 在另一机构。
export function standardFixture(svc, opts = {}) {
  svc.createInstitution({ id: "inst_school", name: "境内职校" });
  svc.createInstitution({ id: "inst_abroad", name: "境外机构" });
  svc.createUser({ id: "admin", name: "教务", role: "admin", timezone: "Asia/Shanghai" });
  svc.createUser({ id: "mentor", institutionId: "inst_abroad", name: "境外导师", role: "mentor", timezone: "Europe/Berlin" });
  svc.createUser({ id: "reviewer", institutionId: "inst_school", name: "企业复核", role: "reviewer", timezone: "Asia/Shanghai" });
  svc.createUser({ id: "stuA", institutionId: "inst_school", name: "学员甲", role: "student", timezone: "Asia/Shanghai" });
  svc.createUser({ id: "stuB", institutionId: "inst_school", name: "学员乙", role: "student", timezone: "Asia/Shanghai" });
  svc.createUser({ id: "stuC", institutionId: "inst_abroad", name: "学员丙", role: "student", timezone: "Europe/Berlin" });

  svc.createBatch({
    id: "batch1", code: "CB-2026", title: "跨境实训批次",
    rules: { version: 1, requireBothParties: true, resubmitWindowHours: 72 },
  });
  svc.addStaff({ batchId: "batch1", userId: "mentor", role: "mentor", canScore: true, maxScore: 90 });
  svc.addStaff({ batchId: "batch1", userId: "reviewer", role: "reviewer", canScore: false });

  svc.createTeam({ id: "team1", batchId: "batch1", name: "第一队" });
  svc.addTeamMember("team1", "stuA");
  svc.addTeamMember("team1", "stuB");

  svc.createNode({
    id: "node1", batchId: "batch1", code: "N1", title: "结项成果",
    deadlineAt: opts.deadlineAt ?? "2026-10-01T00:00:00",
    deadlineTz: "Asia/Shanghai",
    signingScope: { parties: ["mentor", "enterprise"] },
  });
  return { batchId: "batch1", nodeId: "node1", teamId: "team1" };
}
