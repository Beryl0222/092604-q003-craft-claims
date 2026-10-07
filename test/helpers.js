/** 测试用可控时钟：now() 固定起点，advance() 推进小时数。 */
export class FakeClock {
  constructor() {
    this.t = Date.parse("2026-01-01T00:00:00.000Z");
  }

  now() {
    return new Date(this.t).toISOString();
  }

  advance(hours) {
    this.t += hours * 3600_000;
    return this.now();
  }
}

/** 构造一条证据完备的工序主张并发布；可通过 overrides 改变其中任一环节。 */
export async function buildPublishedClaim(service, { claimId = "c-1", overrides = {}, sources } = {}) {
  const sourceDefs =
    sources ?? [
      { sourceId: "s-book", originKey: "book-A", kind: "classic_text" },
      { sourceId: "s-doc", originKey: "doc-B", kind: "documentary" },
    ];
  for (const source of sourceDefs) {
    service.registerSource({
      licenseStatus: "granted",
      regionScope: [],
      ...source,
    });
  }
  service.registerClaim({
    claimId,
    statement: "工序说法",
    kind: "process",
    scope: { kind: "general" },
    ...overrides.claim,
  });
  for (const source of sourceDefs) {
    service.attachEvidence({ claimId, sourceId: source.sourceId });
  }
  service.confirmInheritor({ claimId, inheritorId: "inh-1", name: "李师傅" });
  service.recordTrial({ claimId, trialId: `t-${claimId}`, conditions: "春季、陈料、手工", result: "reproduced" });
  service.setEditorialNote({ claimId, editorialNote: "并列呈现古籍与纪录片说法，以传承人操作为准" });
  if (overrides.carries) {
    for (const disagreementId of overrides.carries) {
      service.carryDisagreement({ claimId, disagreementId });
    }
  }
  service.publishClaim({ claimId, decidedBy: "editor-1", ...overrides.publish });
  return claimId;
}

/** 发布一条含指定片段的下游发布物。 */
export async function releaseWithClip(service, { claimId, clipScope = { kind: "general" }, publicationId = "p-1", channel = "web", eventId = "evt-1", clipId = "clip-1", decidedBy = "editor-1", incorporatesCorrections = [] }) {
  await service.createClip({
    clipId,
    claimId,
    scope: clipScope,
    editingSessionId: "session-1",
    incorporatesCorrections,
  });
  return service.releasePublication({
    eventId,
    publicationId,
    channel,
    clipIds: [clipId],
    decidedBy,
    title: "成片",
  });
}
