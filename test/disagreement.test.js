import assert from "node:assert/strict";
import test from "node:test";

import { Service } from "../src/service.js";
import { FakeClock, buildPublishedClaim } from "./helpers.js";

function makeService() {
  return new Service({ clock: new FakeClock() });
}

test("分歧必须来自不同来源，且立场不足两个时拒绝", () => {
  const service = makeService();
  service.registerSource({ sourceId: "s-1", kind: "classic_text", originKey: "o1", licenseStatus: "granted" });
  service.registerSource({ sourceId: "s-2", kind: "documentary", originKey: "o2", licenseStatus: "granted" });
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });

  assert.throws(
    () => service.openDisagreement({ claimId: "c-1", disagreementId: "d-1", openedBy: "e", positions: [{ sourceId: "s-1" }] }),
    /至少需要两个对立立场/,
  );
  assert.throws(
    () => service.openDisagreement({ claimId: "c-1", disagreementId: "d-1", openedBy: "e", positions: [{ sourceId: "s-1" }, { sourceId: "s-1" }] }),
    /不同来源/,
  );
});

test("未携带的开放分歧阻止公开；系统不自动选边", () => {
  const service = makeService();
  // 只用一条来源建主张，随后补两条对立来源
  service.registerSource({ sourceId: "s-1", kind: "classic_text", originKey: "o1", licenseStatus: "granted" });
  service.registerSource({ sourceId: "s-2", kind: "documentary", originKey: "o2", licenseStatus: "granted" });
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-1" });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-2" });
  service.confirmInheritor({ claimId: "c-1", inheritorId: "i" });
  service.recordTrial({ claimId: "c-1", trialId: "t", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-1", editorialNote: "n" });

  service.openDisagreement({
    claimId: "c-1",
    disagreementId: "d-1",
    openedBy: "editor-1",
    summary: "火候说：一炷香 vs 三沸",
    positions: [{ sourceId: "s-1", note: "一炷香" }, { sourceId: "s-2", note: "三沸" }],
  });

  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "editor-1" }),
    (error) => error.code === "insufficient_evidence" && error.extra.reasons.includes("unresolved_disagreement"),
  );

  // 编辑显式携带分歧（承诺并列呈现两种说法）后才能公开；两种立场都仍保留。
  service.carryDisagreement({ claimId: "c-1", disagreementId: "d-1" });
  service.publishClaim({ claimId: "c-1", decidedBy: "editor-1" });
  const explanation = service.explainClaim("c-1");
  assert.equal(explanation.disagreements[0].positions.length, 2);
  assert.equal(explanation.disagreements[0].status, "open");
  assert.deepEqual(explanation.claim.carriedDisagreements, ["d-1"]);
});

test("关闭分歧不自动改写已发布主张，只留决定痕迹", () => {
  const service = makeService();
  // 先在无分歧状态下发布
  buildPublishedClaimHarness(service);
  service.registerSource({ sourceId: "s-3", kind: "inheritor_testimony", originKey: "o3", licenseStatus: "granted" });
  service.openDisagreement({
    claimId: "c-1",
    disagreementId: "d-late",
    openedBy: "editor-2",
    positions: [{ sourceId: "s-book", note: "甲" }, { sourceId: "s-3", note: "乙" }],
  });
  service.closeDisagreement({ disagreementId: "d-late", decidedBy: "chief-editor", resolutionNote: "新证据支持甲说" });
  const disagreement = service.explainClaim("c-1").disagreements.find((item) => item.disagreementId === "d-late");
  assert.equal(disagreement.status, "closed");
  assert.equal(disagreement.closedBy, "chief-editor");
  // 主张仍公开；关闭动作进决定痕迹
  const trail = service.explainClaim("c-1").decisions;
  assert.ok(trail.some((item) => item.type === "correction") === false);
  assert.equal(service.explainClaim("c-1").allowance.public, true);
});

function buildPublishedClaimHarness(service) {
  // buildPublishedClaim 是 async，但内部无 await，直接调用亦可；保持简单直接构造。
  service.registerSource({ sourceId: "s-book", kind: "classic_text", originKey: "book-A", licenseStatus: "granted" });
  service.registerSource({ sourceId: "s-doc", kind: "documentary", originKey: "doc-B", licenseStatus: "granted" });
  service.registerClaim({ claimId: "c-1", kind: "process", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-book" });
  service.attachEvidence({ claimId: "c-1", sourceId: "s-doc" });
  service.confirmInheritor({ claimId: "c-1", inheritorId: "i" });
  service.recordTrial({ claimId: "c-1", trialId: "t", conditions: "x", result: "reproduced" });
  service.setEditorialNote({ claimId: "c-1", editorialNote: "n" });
  service.publishClaim({ claimId: "c-1", decidedBy: "editor-1" });
}
