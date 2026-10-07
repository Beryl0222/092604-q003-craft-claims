import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { Clock } from "../src/clock.js";
import { Service } from "../src/service.js";

/** 可控时钟：用于断言回执期限、限制生效时间。 */
class FakeClock extends Clock {
  constructor(start = "2026-09-01T00:00:00.000Z") {
    super();
    this.t = Date.parse(start);
  }
  now() {
    return new Date(this.t).toISOString();
  }
  advanceHours(hours) {
    this.t += hours * 3600_000;
  }
}

function newService() {
  return new Service({ clock: new FakeClock() });
}

function call(service, action, payload) {
  return JSON.parse(handle(JSON.stringify({ action, payload }), service));
}

/** 注册一条带来源版本与公开许可的来源，返回各编号。 */
function seedSourceWithPublicVersion(service, { sourceId, versionId, licenseId, scope = "public" }) {
  service.registerSource({ sourceId, kind: "ancient_text", title: `典籍-${sourceId}` });
  service.addSourceVersion({ sourceId, versionId, contentHash: `hash-${versionId}` });
  service.grantLicense({ licenseId, sourceVersionId: versionId, scope });
}

test("证据不足、缺公开许可的主张只能进入内部草稿，不能公开发布", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, {
    sourceId: "src-internal",
    versionId: "sv-internal",
    licenseId: "lic-internal",
    scope: "internal",
  });
  service.proposeClaim({ claimId: "c1", process: "上釉", statement: "上釉须刷三遍", regions: ["*"] });
  service.addEvidence({
    evidenceId: "e1",
    kind: "ancient_text",
    sourceVersionId: "sv-internal",
    excerpt: "釉凡三上",
  });
  service.attachEvidence({ claimId: "c1", evidenceId: "e1" });

  const denied = call(service, "publishClaim", { claimId: "c1", target: "public", editorId: "ed-1" });
  assert.equal(denied.error.code, "NOT_PUBLISHABLE");
  assert.match(denied.error.message, /NO_PUBLIC_LICENSE/);

  const draft = service.publishClaim({ claimId: "c1", target: "draft", editorId: "ed-1" });
  assert.equal(draft.internalOnly, true);
  assert.equal(draft.target, "draft");
});

test("完整依据链（公开许可＋试做成功＋口述经传承人确认）允许公开发布并记录版本", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-book", versionId: "sv-1", licenseId: "lic-1" });
  service.recordTrial({ trialId: "tr-1", process: "开片", outcome: "success", iterations: 5 });
  service.registerSource({ sourceId: "src-bearer", kind: "bearer_testimony", title: "传承人口述母本" });
  service.addSourceVersion({ sourceId: "src-bearer", versionId: "sv-b1", contentHash: "h-b1" });
  service.grantLicense({ licenseId: "lic-b1", sourceVersionId: "sv-b1", scope: "public" });

  service.proposeClaim({ claimId: "c2", process: "开片", statement: "开片前须静置一炷香", regions: ["*"] });
  service.addEvidence({ evidenceId: "e-book", kind: "ancient_text", sourceVersionId: "sv-1", excerpt: "片前静息" });
  service.addEvidence({ evidenceId: "e-trial", kind: "trial", trialId: "tr-1" });
  service.addEvidence({ evidenceId: "e-bearer", kind: "bearer_testimony", sourceVersionId: "sv-b1", excerpt: "我阿公都是这么教的" });
  for (const id of ["e-book", "e-trial", "e-bearer"]) service.attachEvidence({ claimId: "c2", evidenceId: id });

  // 口述未经传承人确认前不能公开。
  let denied = call(service, "publishClaim", { claimId: "c2", target: "public", editorId: "ed-1" });
  assert.match(denied.error.message, /BEARER_NOT_CONFIRMED/);

  service.confirmByBearer({ evidenceId: "e-bearer", claimId: "c2", bearerId: "bearer-chen" });
  const release = service.publishClaim({ claimId: "c2", target: "public", editorId: "ed-1" });
  assert.equal(release.target, "public");
  assert.equal(release.internalOnly, false);

  const republished = service.publishClaim({ claimId: "c2", target: "public", editorId: "ed-2" });
  assert.equal(republished.claimVersion, 2);
  const explanation = service.explainRelease({ releaseId: republished.releaseId });
  assert.deepEqual(
    explanation.claim.versions.map((v) => v.claimVersion),
    [1, 2]
  );
});

test("地域过度概括：局部依据支持不了普遍主张，限定地域后才可发布", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-local", versionId: "sv-local", licenseId: "lic-local" });
  service.proposeClaim({ claimId: "c3", process: "窨制", statement: "窨花一律用三窨", regions: ["*"] });
  service.addEvidence({
    evidenceId: "e-local",
    kind: "ancient_text",
    sourceVersionId: "sv-local",
    applicableRegions: ["福州"],
    excerpt: "福州窨茶三窨",
  });
  let claim = service.attachEvidence({ claimId: "c3", evidenceId: "e-local" });
  assert.ok(claim.lastEvaluation.violations.some((v) => v.code === "REGION_OVERREACH"));

  let denied = call(service, "publishClaim", { claimId: "c3", target: "public", editorId: "ed-1" });
  assert.match(denied.error.message, /REGION_OVERREACH/);

  // 重新提出限定地域的主张后可发布。
  service.proposeClaim({ claimId: "c3b", process: "窨制", statement: "福州茉莉花茶用三窨", regions: ["福州"] });
  claim = service.attachEvidence({ claimId: "c3b", evidenceId: "e-local" });
  assert.equal(claim.lastEvaluation.eligible, true);
  const release = service.publishClaim({ claimId: "c3b", target: "public", editorId: "ed-1" });
  assert.equal(release.target, "public");
});

test("互相矛盾的来源保留分歧并阻断发布；编辑裁定后可发布，决定留痕可溯", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-a", versionId: "sv-a", licenseId: "lic-a" });
  service.registerSource({ sourceId: "src-b", kind: "documentary", title: "官方纪录片" });
  service.addSourceVersion({ sourceId: "src-b", versionId: "sv-b", contentHash: "h-b" });
  service.grantLicense({ licenseId: "lic-b", sourceVersionId: "sv-b", scope: "public" });

  service.proposeClaim({ claimId: "c4", process: "揉捻", statement: "揉捻沿顺时针", regions: ["*"] });
  service.addEvidence({ evidenceId: "ea", kind: "ancient_text", sourceVersionId: "sv-a", excerpt: "顺而揉之" });
  service.addEvidence({
    evidenceId: "eb",
    kind: "documentary",
    sourceVersionId: "sv-b",
    supports: "contradicts",
    applicableRegions: ["*"],
    excerpt: "片中师傅明确沿逆时针",
  });
  service.attachEvidence({ claimId: "c4", evidenceId: "ea" });
  const blocked = service.attachEvidence({ claimId: "c4", evidenceId: "eb" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.openConflictCount, 1);
  assert.deepEqual(
    blocked.lastEvaluation.conflicts.map((cf) => cf.resolution),
    ["unresolved"]
  );

  const denied = call(service, "publishClaim", { claimId: "c4", target: "public", editorId: "ed-1" });
  assert.match(denied.error.message, /CONFLICTING_SOURCES/);

  // 系统不选边：编辑作出「限定后采用」并写明理由。
  service.resolveConflict({
    claimId: "c4",
    evidenceId: "eb",
    editorId: "editor-liu",
    decision: "qualify",
    qualification: "逆时针为另一流派做法，正片仅陈述顺时针流派",
    reason: "两条来源均一手，按流派分歧并列保留",
  });
  const release = service.publishClaim({ claimId: "c4", target: "public", editorId: "editor-liu" });
  const explanation = service.explainRelease({ releaseId: release.releaseId });
  const conflictEvidence = explanation.evidence.find((e) => e.evidenceId === "eb");
  assert.equal(conflictEvidence.conflictResolution.editorId, "editor-liu");
  assert.equal(conflictEvidence.conflictResolution.decision, "qualify");
});

test("并行剪辑：后提交者撞版本被拒；撤回处置生效后任何新剪辑不得公开", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-clip", versionId: "sv-clip", licenseId: "lic-clip" });
  service.proposeClaim({ claimId: "c5", process: "拉坯", statement: "拉坯取泥二斤", regions: ["*"] });
  service.addEvidence({ evidenceId: "ec", kind: "ancient_text", sourceVersionId: "sv-clip", excerpt: "泥二斤" });
  service.attachEvidence({ claimId: "c5", evidenceId: "ec" });
  const release = service.publishClaim({ claimId: "c5", target: "public", editorId: "ed-1" });
  service.registerSnippet({ snippetId: "sn-1", releaseId: release.releaseId, title: "拉坯正片", editorId: "ed-1" });

  const a = service.checkoutSnippet({ snippetId: "sn-1", editorId: "editor-a" });
  const b = service.checkoutSnippet({ snippetId: "sn-1", editorId: "editor-b" });
  assert.equal(a.clipVersion, 1);
  assert.equal(b.clipVersion, 1);

  const committed = service.commitSnippet({
    snippetId: "sn-1",
    checkoutId: a.checkout.checkoutId,
    expectedClipVersion: 1,
    target: "public",
    editorId: "editor-a",
  });
  assert.equal(committed.clipVersion, 2);

  const stale = call(service, "commitSnippet", {
    snippetId: "sn-1",
    checkoutId: b.checkout.checkoutId,
    expectedClipVersion: 1,
    target: "public",
    editorId: "editor-b",
  });
  assert.equal(stale.error.code, "CLIP_VERSION_CONFLICT");

  // 撤回处置对片段生效 block。
  service.imposeRestriction({
    restrictionId: "rs-block",
    snippetId: "sn-1",
    type: "block",
    reason: "来源说法已被撤回",
    issuedBy: "compliance",
  });
  const b2 = service.checkoutSnippet({ snippetId: "sn-1", editorId: "editor-b" });
  const blocked = call(service, "commitSnippet", {
    snippetId: "sn-1",
    checkoutId: b2.checkout.checkoutId,
    expectedClipVersion: 2,
    target: "public",
    editorId: "editor-b",
  });
  assert.equal(blocked.error.code, "SNIPPET_BLOCKED");
});

test("地域限定更正：旧视频、字幕切片、品牌稿全部判为追加说明并生成处置单", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-q", versionId: "sv-q", licenseId: "lic-q" });
  service.proposeClaim({ claimId: "c6", process: "发酵", statement: "发酵统一覆盖湿布", regions: ["*"] });
  service.addEvidence({ evidenceId: "eq", kind: "ancient_text", sourceVersionId: "sv-q", excerpt: "覆之以酵" });
  service.attachEvidence({ claimId: "c6", evidenceId: "eq" });
  const release = service.publishClaim({ claimId: "c6", target: "public", editorId: "ed-1" });

  service.registerChannel({ channelId: "ch-video", name: "视频号" });
  service.registerChannel({ channelId: "ch-sub", name: "字幕切片渠道" });
  service.registerChannel({ channelId: "ch-brand", name: "品牌合作方" });
  service.registerSnippet({ snippetId: "sn-q", releaseId: release.releaseId, title: "发酵片段" });
  service.registerUsage({ usageId: "u-video", snippetId: "sn-q", channelId: "ch-video", kind: "video" });
  service.registerUsage({ usageId: "u-sub", snippetId: "sn-q", channelId: "ch-sub", kind: "subtitle" });
  service.registerUsage({ usageId: "u-brand", snippetId: "sn-q", channelId: "ch-brand", kind: "brand_post" });

  service.recordCorrection({
    correctionId: "cor-q",
    sourceVersionId: "sv-q",
    correctionType: "qualify",
    regionsScopedTo: ["闽南"],
    note: "新地方志证明覆布仅为闽南做法",
    decidedBy: "chief-editor",
  });
  const { summary, impacts } = service.analyzeCorrectionImpact({ correctionId: "cor-q" });
  assert.equal(summary.annotate, 3);
  assert.equal(summary.withdraw, 0);
  assert.ok(impacts.every((i) => i.severity === "annotate"));

  const issued = service.issueDispositionTickets({ correctionId: "cor-q" });
  assert.equal(issued.tickets.length, 3);
  assert.equal(issued.replayed, false);

  // 片段被要求追加说明：新剪辑不带注解不得公开。
  const co = service.checkoutSnippet({ snippetId: "sn-q", editorId: "ed-9" });
  const noAnnotation = call(service, "commitSnippet", {
    snippetId: "sn-q",
    checkoutId: co.checkout.checkoutId,
    expectedClipVersion: 1,
    target: "public",
    editorId: "ed-9",
  });
  assert.equal(noAnnotation.error.code, "ANNOTATION_REQUIRED");
});

test("撤回更正且无替代依据时判为撤回，处置单立即冻结片段并撤回发布物", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-r", versionId: "sv-r", licenseId: "lic-r" });
  service.proposeClaim({ claimId: "c7", process: "晾晒", statement: "晾晒须满七日", regions: ["*"] });
  service.addEvidence({ evidenceId: "er", kind: "ancient_text", sourceVersionId: "sv-r", excerpt: "七日而燥" });
  service.attachEvidence({ claimId: "c7", evidenceId: "er" });
  const release = service.publishClaim({ claimId: "c7", target: "public", editorId: "ed-1" });
  service.registerChannel({ channelId: "ch-1", name: "视频号" });
  service.registerSnippet({ snippetId: "sn-r", releaseId: release.releaseId, title: "晾晒片段" });
  service.registerUsage({ usageId: "u-1", snippetId: "sn-r", channelId: "ch-1", kind: "video" });

  service.recordCorrection({
    correctionId: "cor-r",
    sourceVersionId: "sv-r",
    correctionType: "retract",
    note: "原版本系误录，馆藏撤回该页",
    decidedBy: "archive",
  });
  const { summary } = service.analyzeCorrectionImpact({ correctionId: "cor-r" });
  assert.equal(summary.withdraw, 1);

  const issued = service.issueDispositionTickets({ correctionId: "cor-r" });
  assert.equal(issued.tickets[0].action, "withdraw");

  // block 限制已随处置单生效。
  const co = service.checkoutSnippet({ snippetId: "sn-r", editorId: "ed-2" });
  const blocked = call(service, "commitSnippet", {
    snippetId: "sn-r",
    checkoutId: co.checkout.checkoutId,
    expectedClipVersion: 1,
    target: "public",
    editorId: "ed-2",
  });
  assert.equal(blocked.error.code, "SNIPPET_BLOCKED");

  service.acknowledgeTicket({ ticketId: issued.tickets[0].ticketId, channelId: "ch-1", status: "done" });
  const usage = service.store.get("usages", "u-1");
  assert.equal(usage.status, "withdrawn");

  const after = service.explainRelease({ releaseId: release.releaseId });
  assert.equal(after.release.currentStanding.stillHolds, false);
  assert.deepEqual(after.release.currentStanding.activeCorrectionIds, ["cor-r"]);
});

test("合作方回调重放不重复生成处置单", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-cb", versionId: "sv-cb", licenseId: "lic-cb" });
  service.proposeClaim({ claimId: "c8", process: "选料", statement: "选料取芯料", regions: ["*"] });
  service.addEvidence({ evidenceId: "ecb", kind: "ancient_text", sourceVersionId: "sv-cb", excerpt: "取芯" });
  service.attachEvidence({ claimId: "c8", evidenceId: "ecb" });
  const release = service.publishClaim({ claimId: "c8", target: "public", editorId: "ed-1" });
  service.registerChannel({ channelId: "ch-cb", name: "合作渠道" });
  service.registerSnippet({ snippetId: "sn-cb", releaseId: release.releaseId });
  service.registerUsage({ usageId: "u-cb", snippetId: "sn-cb", channelId: "ch-cb" });
  service.recordCorrection({ correctionId: "cor-cb", sourceVersionId: "sv-cb", correctionType: "erratum", decidedBy: "editor-x" });

  const first = service.receivePublishCallback({ callbackId: "cb-001", correctionId: "cor-cb", partnerId: "p-1" });
  assert.equal(first.replayed, false);
  assert.equal(first.ticketIds.length, 1);

  const replay = service.receivePublishCallback({ callbackId: "cb-001", correctionId: "cor-cb", partnerId: "p-1" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.ticketIds, first.ticketIds);
  assert.equal(service.store.list("tickets").length, 1);

  // 不带回调编号的再次请求同样幂等。
  const again = service.issueDispositionTickets({ correctionId: "cor-cb" });
  assert.equal(again.replayed, true);
  assert.equal(again.tickets.length, 1);
});

test("渠道在期限内完成回执则全部按时；逾期未回执被标记 overdue", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-dl", versionId: "sv-dl", licenseId: "lic-dl" });
  service.proposeClaim({ claimId: "c9", process: "打磨", statement: "打磨八百转", regions: ["*"] });
  service.addEvidence({ evidenceId: "edl", kind: "ancient_text", sourceVersionId: "sv-dl", excerpt: "八百转" });
  service.attachEvidence({ claimId: "c9", evidenceId: "edl" });
  const release = service.publishClaim({ claimId: "c9", target: "public", editorId: "ed-1" });
  service.registerChannel({ channelId: "fast", name: "快速渠道", receiptDeadlineHours: 72 });
  service.registerChannel({ channelId: "slow", name: "迟缓渠道", receiptDeadlineHours: 24 });
  service.registerSnippet({ snippetId: "sn-dl", releaseId: release.releaseId });
  service.registerUsage({ usageId: "u-fast", snippetId: "sn-dl", channelId: "fast" });
  service.registerUsage({ usageId: "u-slow", snippetId: "sn-dl", channelId: "slow" });
  service.recordCorrection({ correctionId: "cor-dl", sourceVersionId: "sv-dl", correctionType: "erratum", decidedBy: "editor-x" });
  service.analyzeCorrectionImpact({ correctionId: "cor-dl" });
  const issued = service.issueDispositionTickets({ correctionId: "cor-dl" });
  const fastTicket = issued.tickets.find((t) => t.channelId === "fast");
  const slowTicket = issued.tickets.find((t) => t.channelId === "slow");

  // 10 小时后快速渠道完成，仍在 72 小时期限内。
  service.clock.advanceHours(10);
  service.acknowledgeTicket({ ticketId: fastTicket.ticketId, channelId: "fast", status: "done" });

  // 再过 20 小时（共 30h），迟缓渠道 24h 期限已过。
  service.clock.advanceHours(20);
  const overdue = service.markOverdueTickets();
  assert.deepEqual(overdue.map((t) => t.ticketId), [slowTicket.ticketId]);

  const status = service.correctionStatus({ correctionId: "cor-dl" });
  assert.equal(status.allDone, false);
  const fastRow = status.channels.find((c) => c.channelId === "fast");
  assert.equal(fastRow.allReceiptedInTime, true);
  const slowRow = status.channels.find((c) => c.channelId === "slow");
  assert.equal(slowRow.allReceiptedInTime, false);

  const explanation = service.explainRelease({ releaseId: release.releaseId });
  const fastTrace = explanation.downstream.find((d) => d.channelId === "fast");
  assert.equal(fastTrace.tickets[0].withinDeadline, true);
});

test("溯源接口能说明公开表述为何被允许、出现在哪些版本、由谁裁定、渠道是否按时回执", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-ex", versionId: "sv-ex", licenseId: "lic-ex" });
  service.proposeClaim({ claimId: "c10", process: "装窑", statement: "装窑留三指缝", regions: ["*"] });
  service.addEvidence({ evidenceId: "e-ex", kind: "ancient_text", sourceVersionId: "sv-ex", excerpt: "三指之隙" });
  service.attachEvidence({ claimId: "c10", evidenceId: "e-ex" });
  const r1 = service.publishClaim({ claimId: "c10", target: "public", editorId: "ed-main" });
  service.registerChannel({ channelId: "ch-ex", name: "自有号" });
  service.registerSnippet({ snippetId: "sn-ex", releaseId: r1.releaseId });
  service.registerUsage({ usageId: "u-ex", snippetId: "sn-ex", channelId: "ch-ex" });

  const explanation = service.explainRelease({ releaseId: r1.releaseId });
  assert.ok(explanation.release.allowedBecause.some((r) => r.includes("EVIDENCE_SUFFICIENT")));
  assert.ok(explanation.release.allowedBecause.some((r) => r.includes("PUBLIC_LICENSE")));
  assert.equal(explanation.release.editorId, "ed-main");
  assert.equal(explanation.evidence[0].sourceVersion.versionId, "sv-ex");
  assert.equal(explanation.evidence[0].license.scope, "public");
  assert.equal(explanation.downstream[0].channelId, "ch-ex");
  assert.equal(explanation.evidence[0].activeCorrection, null);
});

test("只存在于内部草稿的主张遇更正时分级为无需处理", () => {
  const service = newService();
  seedSourceWithPublicVersion(service, { sourceId: "src-d", versionId: "sv-d", licenseId: "lic-d" });
  service.proposeClaim({ claimId: "c11", process: "调釉", statement: "釉料比例七比三", regions: ["*"] });
  service.addEvidence({ evidenceId: "ed", kind: "ancient_text", sourceVersionId: "sv-d", excerpt: "七三之配" });
  service.attachEvidence({ claimId: "c11", evidenceId: "ed" });
  service.publishClaim({ claimId: "c11", target: "draft", editorId: "ed-1" });

  service.recordCorrection({ correctionId: "cor-d", sourceVersionId: "sv-d", correctionType: "retract", decidedBy: "archive" });
  const { summary, impacts } = service.analyzeCorrectionImpact({ correctionId: "cor-d" });
  assert.equal(summary.none, 1);
  assert.equal(impacts[0].severity, "none");
  const issued = service.issueDispositionTickets({ correctionId: "cor-d" });
  assert.equal(issued.tickets.length, 0);
});

test("接口层对非法动作与领域错误返回错误信封，不抛出", () => {
  const badAction = JSON.parse(handle('{"action":"nope"}', newService()));
  assert.equal(badAction.error.code, "UNSUPPORTED_ACTION");
  const badJson = JSON.parse(handle("not-json", newService()));
  assert.equal(badJson.error.code, "BAD_JSON");
  const notFound = call(newService(), "explainRelease", { releaseId: "missing" });
  assert.equal(notFound.error.code, "NOT_FOUND");
});
