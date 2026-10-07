import assert from "node:assert/strict";
import test from "node:test";

import { Service } from "../src/service.js";
import { FakeClock, buildPublishedClaim } from "./helpers.js";

function makeService() {
  return new Service({ clock: new FakeClock() });
}

/** 仅注册两条已授权、通用、独立出处的来源。 */
function seedSources(service) {
  service.registerSource({ sourceId: "s-book", kind: "classic_text", originKey: "book-A", licenseStatus: "granted" });
  service.registerSource({ sourceId: "s-doc", kind: "documentary", originKey: "doc-B", licenseStatus: "granted" });
}

/** 走到"只差一步即可发布"，由各用例删除其中一个条件。 */
function fullyEvidencedClaim(service, claimId = "c-1", claimOverrides = {}) {
  seedSources(service);
  service.registerClaim({ claimId, statement: "说法", kind: "process", scope: { kind: "general" }, ...claimOverrides });
  service.attachEvidence({ claimId, sourceId: "s-book" });
  service.attachEvidence({ claimId, sourceId: "s-doc" });
  service.confirmInheritor({ claimId, inheritorId: "inh-1" });
  service.recordTrial({ claimId, trialId: "t-1", conditions: "春料、手工", result: "reproduced" });
  service.setEditorialNote({ claimId, editorialNote: "两种说法并列呈现" });
}

test("证据不足的主张只能停留内部草稿：无依据直接发布被拒绝", () => {
  const service = makeService();
  seedSources(service);
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "editor-1" }),
    (error) => error.code === "insufficient_evidence" && error.extra.reasons.includes("no_evidence"),
  );
  assert.equal(service.explainClaim("c-1").claim.status, "draft");
});

test("只有一条独立来源不能公开", () => {
  const service = makeService();
  seedSources(service);
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-book" });
  service.confirmInheritor({ claimId: "c-1", inheritorId: "inh-1" });
  service.recordTrial({ claimId: "c-1", trialId: "t-1", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-1", editorialNote: "n" });
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "e" }),
    (error) => error.code === "insufficient_evidence" && error.extra.reasons.includes("insufficient_independent_sources"),
  );
});

test("同一出处的不同版本只算一处独立来源", () => {
  const service = makeService();
  service.registerSource({ sourceId: "s-doc-v1", kind: "documentary", originKey: "same-origin", versionLabel: "v1", licenseStatus: "granted" });
  service.registerSource({ sourceId: "s-doc-v2", kind: "documentary", originKey: "same-origin", versionLabel: "v2", licenseStatus: "granted" });
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-doc-v1" });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-doc-v2" });
  service.confirmInheritor({ claimId: "c-1", inheritorId: "i" });
  service.recordTrial({ claimId: "c-1", trialId: "t-1", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-1", editorialNote: "n" });
  const evaluation = service.explainClaim("c-1").allowance.evaluation;
  assert.equal(evaluation.independentSources, 1);
  assert.throws(() => service.publishClaim({ claimId: "c-1", decidedBy: "e" }), /证据/);
});

test("使用许可未授权的来源不能支撑公开", () => {
  const service = makeService();
  service.registerSource({ sourceId: "s-1", kind: "documentary", originKey: "o1", licenseStatus: "unknown" });
  service.registerSource({ sourceId: "s-2", kind: "classic_text", originKey: "o2", licenseStatus: "denied" });
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-1" });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-2" });
  service.confirmInheritor({ claimId: "c-1", inheritorId: "i" });
  service.recordTrial({ claimId: "c-1", trialId: "t", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-1", editorialNote: "n" });
  assert.throws(() => service.publishClaim({ claimId: "c-1", decidedBy: "e" }), /证据/);
  assert.equal(service.explainClaim("c-1").allowance.evaluation.independentSources, 0);
});

test("缺少传承人确认不能公开", () => {
  const service = makeService();
  fullyEvidencedClaim(service, "c-1");
  const claim = service.explainClaim("c-1").claim;
  claim.inheritorConfirmation = null;
  service.claims.put(claim);
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "e" }),
    (error) => error.extra.reasons.includes("inheritor_confirmation_missing"),
  );
});

test("没有在记录条件下复现成功的试做不能公开", () => {
  const service = makeService();
  fullyEvidencedClaim(service, "c-1");
  const claim = service.explainClaim("c-1").claim;
  claim.trials = [{ trialId: "t-1", conditions: "雨季、新料", result: "failed" }];
  service.claims.put(claim);
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "e" }),
    (error) => error.extra.reasons.includes("reproduced_trial_missing"),
  );
});

test("缺少编辑取舍说明不能公开", () => {
  const service = makeService();
  fullyEvidencedClaim(service, "c-1");
  const claim = service.explainClaim("c-1").claim;
  claim.editorialNote = "  ";
  service.claims.put(claim);
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "e" }),
    (error) => error.extra.reasons.includes("editorial_note_missing"),
  );
});

test("地方性来源不能被概括成通说发布", () => {
  const service = makeService();
  service.registerSource({ sourceId: "s-1", kind: "inheritor_testimony", originKey: "o1", licenseStatus: "granted", regionScope: ["A地区"] });
  service.registerSource({ sourceId: "s-2", kind: "classic_text", originKey: "o2", licenseStatus: "granted", regionScope: ["A地区"] });
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-1" });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-2" });
  service.confirmInheritor({ claimId: "c-1", inheritorId: "i" });
  service.recordTrial({ claimId: "c-1", trialId: "t", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-1", editorialNote: "n" });
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "e" }),
    (error) => error.extra.reasons.includes("scope_overreach"),
  );
});

test("限定在来源覆盖地域内的地域型主张可以公开；声称未覆盖地域则被拒绝", () => {
  const service = makeService();
  service.registerSource({ sourceId: "s-1", kind: "inheritor_testimony", originKey: "o1", licenseStatus: "granted", regionScope: ["A地区", "B地区"] });
  service.registerSource({ sourceId: "s-2", kind: "classic_text", originKey: "o2", licenseStatus: "granted", regionScope: ["A地区"] });
  service.registerClaim({ claimId: "c-bad", kind: "process", scope: { kind: "region", regions: ["C地区"] } });
  for (const sourceId of ["s-1", "s-2"]) service.attachEvidence({ claimId: "c-bad", sourceId });
  service.confirmInheritor({ claimId: "c-bad", inheritorId: "i" });
  service.recordTrial({ claimId: "c-bad", trialId: "t", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-bad", editorialNote: "n" });
  assert.throws(
    () => service.publishClaim({ claimId: "c-bad", decidedBy: "e" }),
    (error) => error.extra.reasons.includes("scope_not_supported"),
  );

  service.registerClaim({ claimId: "c-good", kind: "process", scope: { kind: "region", regions: ["A地区"] } });
  for (const sourceId of ["s-1", "s-2"]) service.attachEvidence({ claimId: "c-good", sourceId });
  service.confirmInheritor({ claimId: "c-good", inheritorId: "i" });
  service.recordTrial({ claimId: "c-good", trialId: "t2", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-good", editorialNote: "n" });
  service.publishClaim({ claimId: "c-good", decidedBy: "editor-1" });
  assert.equal(service.explainClaim("c-good").allowance.public, true);
});

test("证据齐备时可以公开发布，解释接口说明为何被允许", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  const explanation = service.explainClaim("c-1");
  assert.equal(explanation.allowance.public, true);
  assert.equal(explanation.allowance.status, "published");
  assert.deepEqual(explanation.allowance.evaluation.reasons, []);
  assert.equal(explanation.evidence.length, 2);
  assert.equal(explanation.evidence[0].license.status, "granted");
});
