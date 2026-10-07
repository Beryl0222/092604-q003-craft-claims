import assert from "node:assert/strict";
import test from "node:test";

import { Service } from "../src/service.js";
import { FakeClock, buildPublishedClaim, releaseWithClip } from "./helpers.js";

function makeService() {
  return new Service({ clock: new FakeClock() });
}

test("合作方重放发布回调不重复生成处置单、不重复发布", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", eventId: "evt-1" });

  await service.correctSource({
    sourceId: "s-book", correctionId: "corr-1", type: "withdraw", decidedBy: "chief",
  });
  const ordersBefore = service.orders.list().length;

  // 重放同一发布回调（同 eventId）：返回原发布物，且不再产生处置单
  const replay = await service.releasePublication({
    eventId: "evt-1", publicationId: "p-1", channel: "web", clipIds: ["clip-1"], decidedBy: "editor-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.publication.publicationId, "p-1");
  assert.equal(service.orders.list().length, ordersBefore);

  // 用新 eventId 试图把同一片段再发一次：被拒绝，不能借重放开新单
  await assert.rejects(
    () => service.releasePublication({
      eventId: "evt-2", publicationId: "p-2", channel: "web", clipIds: ["clip-1"], decidedBy: "editor-1",
    }),
    (error) => error.code === "conflict",
  );
});

test("来源更正回调重放不重复施加限制、不重复开单", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", eventId: "evt-1" });

  const first = await service.correctSource({
    sourceId: "s-book", correctionId: "corr-1", type: "withdraw", decidedBy: "chief",
  });
  const second = await service.correctSource({
    sourceId: "s-book", correctionId: "corr-1", type: "withdraw", decidedBy: "chief",
  });
  assert.equal(second.disposition.retract.length, first.disposition.retract.length);
  assert.equal(service.orders.list().length, 1);
  assert.equal(service.restrictions.list().length, 1);
});

test("回执重放幂等，且回执类型必须与处置动作相符", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await releaseWithClip(service, { claimId: "c-1", publicationId: "p-1", eventId: "evt-1" });
  await service.correctSource({
    sourceId: "s-book", correctionId: "corr-1", type: "withdraw", decidedBy: "chief",
  });
  const orderId = "ord-corr-1-c-1-p-1";
  assert.throws(
    () => service.recordOrderReceipt({ eventId: "evt-r0", orderId, receiptKind: "annotate" }),
    (error) => error.code === "invalid_request",
  );
  const first = service.recordOrderReceipt({ eventId: "evt-r", orderId, receiptKind: "retract" });
  assert.equal(first.replayed, false);
  const replay = service.recordOrderReceipt({ eventId: "evt-r", orderId, receiptKind: "retract" });
  assert.equal(replay.replayed, true);
  assert.throws(
    () => service.recordOrderReceipt({ eventId: "evt-r2", orderId, receiptKind: "retract" }),
    (error) => error.code === "conflict",
  );
});

test("同一片段的并行剪辑：限制先生效时，并发剪辑不得绕过", async () => {
  const service = makeService();
  await buildPublishedClaim(service);

  // 让 createClip 的临界区排队，期间插入来源撤回；两个剪辑都必须看到已生效的撤回限制。
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let entered = 0;
  const original = service.locks.withLock.bind(service.locks);
  // 门控必须发生在取得锁之后的临界区内，才能保证后续操作按入队顺序等待同一把锁。
  service.locks.withLock = (key, fn) => {
    if (key === "claim:c-1") {
      entered += 1;
      const order = entered;
      return original(key, async () => {
        if (order === 1) await gate; // 第一个剪辑持锁等待
        return fn();
      });
    }
    return original(key, fn);
  };

  const clip1 = service.createClip({ clipId: "clip-a", claimId: "c-1", scope: { kind: "general" } });
  // 等第一个剪辑真正进入临界区后：先让"撤回"排队（成为第二持有者），再让第二个剪辑排队。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const correction = service.correctSource({
    sourceId: "s-book", correctionId: "corr-1", type: "withdraw", decidedBy: "chief",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const clip2 = service.createClip({ clipId: "clip-b", claimId: "c-1", scope: { kind: "general" } });

  releaseGate();

  const results = await Promise.allSettled([clip1, correction, clip2]);
  // 第一个剪辑发生在撤回生效之前：成功；撤回随后生效；排在其后的第二个剪辑必须被拒绝。
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "rejected");
  assert.equal(results[2].reason.code, "restriction_active");
});

test("并行发布回调在锁内复检：同一片段不能被两个发布物同时拿走", async () => {
  const service = makeService();
  await buildPublishedClaim(service);
  await service.createClip({ clipId: "clip-1", claimId: "c-1", scope: { kind: "general" } });

  const [r1, r2] = await Promise.all([
    service.releasePublication({ eventId: "e1", publicationId: "p-1", channel: "web", clipIds: ["clip-1"], decidedBy: "editor-1" }),
    service.releasePublication({ eventId: "e2", publicationId: "p-2", channel: "app", clipIds: ["clip-1"], decidedBy: "editor-1" }),
  ].map((p) => p.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason }))));

  const outcomes = [r1, r2];
  const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
  const rejected = outcomes.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "conflict");
});

test("草稿主张不能进入公开发布物", async () => {
  const service = makeService();
  service.registerSource({ sourceId: "s-1", kind: "classic_text", originKey: "o1", licenseStatus: "granted" });
  service.registerClaim({ claimId: "c-draft", kind: "other", scope: { kind: "general" } });
  service.attachEvidence({ claimId: "c-draft", sourceId: "s-1" });
  await service.createClip({ clipId: "clip-1", claimId: "c-draft", scope: { kind: "general" } });
  await assert.rejects(
    () => service.releasePublication({ eventId: "e1", publicationId: "p-1", channel: "web", clipIds: ["clip-1"], decidedBy: "editor-1" }),
    (error) => error.code === "insufficient_evidence",
  );
});
