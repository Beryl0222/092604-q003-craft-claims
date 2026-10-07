import assert from "node:assert/strict";
import test from "node:test";

import { Service } from "../src/service.js";
import { FakeClock, buildPublishedClaim, releaseWithClip } from "./helpers.js";

function makeService() {
  return new Service({ clock: new FakeClock() });
}

test("来源撤回：主张转为撤回，通说发布物开撤回处置单并带期限", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", channel: "web", eventId: "evt-1" });

  const impact = await service.correctSource({
    sourceId: "s-book",
    correctionId: "corr-1",
    type: "withdraw",
    note: "古籍版本被证伪",
    decidedBy: "chief-editor",
  });

  assert.deepEqual(impact.affectedClaimIds, ["c-1"]);
  assert.deepEqual(impact.disposition.retract, ["ord-corr-1-c-1-p-1"]);
  assert.deepEqual(impact.disposition.annotate, []);
  const channel = impact.channels[0];
  assert.equal(channel.action, "retract");
  assert.equal(channel.receiptState, "pending");
  assert.ok(channel.deadline > service.clock.now());

  // 主张撤回后，任何新剪辑都被拒绝
  await assert.rejects(
    () => service.createClip({ clipId: "clip-new", claimId: "c-1", scope: { kind: "general" } }),
    (error) => error.code === "restriction_active",
  );
  assert.equal(service.explainClaim("c-1").allowance.public, false);
});

test("地域收窄：通说发布物追加说明；地域内发布物无需处理；越界发布物撤回", async () => {
  const service = makeService();
  await buildPublishedClaim(service);

  // 渠道一：通说成片
  await releaseWithClip(service, {
    claimId: "c-1", clipId: "clip-general", publicationId: "p-general", channel: "web", eventId: "evt-gen",
    clipScope: { kind: "general" },
  });
  // 渠道二：已经限定在 A 地区的字幕切片
  await releaseWithClip(service, {
    claimId: "c-1", clipId: "clip-a", publicationId: "p-a", channel: "subtitle", eventId: "evt-a",
    clipScope: { kind: "region", regions: ["A地区"] },
  });
  // 渠道三：声称覆盖 B 地区的品牌合作稿
  await releaseWithClip(service, {
    claimId: "c-1", clipId: "clip-b", publicationId: "p-b", channel: "brand", eventId: "evt-b",
    clipScope: { kind: "region", regions: ["B地区"] },
  });

  const impact = await service.correctSource({
    sourceId: "s-book",
    correctionId: "corr-region",
    type: "narrow_scope",
    regions: ["A地区"],
    note: "该工序经核实只在 A 地区成立",
    decidedBy: "chief-editor",
  });

  assert.deepEqual(impact.disposition.retract, ["ord-corr-region-c-1-p-b"]);
  assert.deepEqual(impact.disposition.annotate, ["ord-corr-region-c-1-p-general"]);
  assert.deepEqual(impact.disposition.noAction, ["ord-corr-region-c-1-p-a"]);

  // 生效后并行剪辑不得绕过：通说新片段被拒；A 地区片段允许；带越界地域被拒
  await assert.rejects(
    () => service.createClip({ clipId: "clip-new-gen", claimId: "c-1", scope: { kind: "general" } }),
    (error) => error.code === "restriction_active",
  );
  await assert.rejects(
    () => service.createClip({ clipId: "clip-new-b", claimId: "c-1", scope: { kind: "region", regions: ["B地区"] } }),
    (error) => error.code === "restriction_active",
  );
  const allowed = await service.createClip({ clipId: "clip-new-a", claimId: "c-1", scope: { kind: "region", regions: ["A地区"] } });
  assert.equal(allowed.clipId, "clip-new-a");
});

test("编辑可把主张收窄到适用地域后重新发布；旧发布物的处置单不变", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", eventId: "evt-1" });
  await service.correctSource({
    sourceId: "s-doc", correctionId: "corr-1", type: "narrow_scope", regions: ["A地区"], decidedBy: "chief",
  });

  // 通说重发布仍被限制挡住
  assert.throws(
    () => service.publishClaim({ claimId: "c-1", decidedBy: "e" }),
    (error) => error.code === "restriction_active",
  );
  // 收窄为地域型（须在来源覆盖范围内）后可发布，并留下新版本与决定人
  service.reviseClaimScope({ claimId: "c-1", scope: { kind: "region", regions: ["A地区"] }, decidedBy: "editor-2" });
  service.publishClaim({ claimId: "c-1", decidedBy: "editor-2" });
  const explanation = service.explainClaim("c-1");
  assert.equal(explanation.claim.scope.kind, "region");
  assert.ok(explanation.versions.some((v) => v.createdBy === "editor-2"));
  // 旧通说发布物仍须追加说明
  const impact = service.correctionImpact("corr-1");
  assert.deepEqual(impact.disposition.annotate, ["ord-corr-1-c-1-p-1"]);
});

test("细节更正：发布物须追加说明，已追加后不再开单", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", eventId: "evt-1" });

  const impact = await service.correctSource({
    sourceId: "s-doc", correctionId: "corr-detail", type: "correct_detail", note: "配比由三份改为两份", decidedBy: "chief",
  });
  assert.deepEqual(impact.disposition.annotate, ["ord-corr-detail-c-1-p-1"]);

  // 新剪辑必须声明吸收更正
  await assert.rejects(
    () => service.createClip({ clipId: "clip-x", claimId: "c-1", scope: { kind: "general" } }),
    (error) => error.code === "restriction_active",
  );
  await service.createClip({
    clipId: "clip-y", claimId: "c-1", scope: { kind: "general" }, incorporatesCorrections: ["corr-detail"],
  });

  // 渠道回执"已追加说明"：期限内 -> receipted
  const receipt = service.recordOrderReceipt({
    eventId: "evt-receipt-1", orderId: "ord-corr-detail-c-1-p-1", receiptKind: "annotate",
  });
  assert.equal(receipt.order.receiptState, "receipted");
  assert.equal(receipt.order.receipt.withinDeadline, true);

  // 即使后续再有更正影响计算，已追加说明的发布物对本次更正为"无需处理"
  const report = service.correctionImpact("corr-detail");
  assert.equal(report.receiptSummary.receipted, 1);
  assert.equal(report.receiptSummary.allReceiptedInTime, true);
});

test("超过期限未回执的处置单显示逾期；撤回回执把发布物置为已撤回", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", eventId: "evt-1" });
  await service.correctSource({
    sourceId: "s-book", correctionId: "corr-1", type: "withdraw", decidedBy: "chief",
  });
  service.clock.advance(100); // 默认撤回期限 72 小时
  const impact = service.correctionImpact("corr-1");
  assert.equal(impact.channels[0].receiptState, "overdue");
  assert.equal(impact.receiptSummary.overdue, 1);

  const receipt = service.recordOrderReceipt({
    eventId: "evt-r", orderId: "ord-corr-1-c-1-p-1", receiptKind: "retract",
  });
  assert.equal(receipt.order.receipt.withinDeadline, false);
  assert.equal(service.explainPublication("p-1").publication.status, "retracted");
});
