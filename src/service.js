/**
 * 传统技艺内容依据管理应用服务。
 *
 * 线索组织：
 *   来源 source → 来源版本 sourceVersion → 依据片段 evidence → 主张 claim
 *   主张经评估后进入 release（public / draft），release 由 snippet 使用记录组成，
 *   snippet 出现在下游 channel 的发布物中。来源更正后沿这条链计算影响面。
 *
 * 关键保证：
 * - 证据不足的主张只能进内部草稿（publishClaim 的闸门）。
 * - 矛盾来源以 conflict 记录保留，发布被阻止，但不自动选边。
 * - 片段限制生效后，剪辑提交必须通过限制闸门（含并行剪辑的乐观并发控制）。
 * - 合作方回调按 callbackId 幂等，重放不会重复生成处置单。
 * - 更正按 withdraw / annotate / none 分级，处置单跟踪各渠道在期限内的回执。
 */
import { Clock } from "./clock.js";
import { DomainError } from "./errors.js";
import { evaluateClaim, classifyCorrectionImpact, restrictionGate } from "./policy.js";
import { Store } from "./store.js";

export class Service {
  constructor({ store = new Store(), clock = new Clock() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  get now() {
    return this.clock.now();
  }

  _need(collection, id, label = "记录") {
    const value = this.store.get(collection, id);
    if (!value) throw new DomainError("NOT_FOUND", `${label}不存在：${id}`);
    return value;
  }

  health() {
    return { service: "craft_claims", status: "ok" };
  }

  register(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.now };
    this.store.add(record);
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get(recordId);
  }

  // ───────────────────────── 来源、版本与许可 ─────────────────────────

  /** 登记一条来源（古籍 / 纪录片 / 传承人口述母本 / 试做母本）。 */
  registerSource({ sourceId, kind, title, custodian, locator = null }) {
    if (this.store.has("sources", sourceId)) throw new DomainError("ALREADY_EXISTS", `来源已存在：${sourceId}`);
    const source = {
      sourceId,
      kind,
      title,
      custodian: custodian ?? null,
      locator,
      createdAt: this.now,
      currentVersionId: null,
    };
    this.store.add("sources", sourceId, source);
    return source;
  }

  /**
   * 为来源追加版本。版本只追加、不改写；supersedesVersionId 标出被替代的旧版本。
   * status: current | superseded | retracted
   */
  addSourceVersion({ sourceId, versionId, contentHash, issuedAt = null, note = "" }) {
    const source = this._need("sources", sourceId, "来源");
    if (this.store.has("sourceVersions", versionId)) {
      throw new DomainError("ALREADY_EXISTS", `来源版本已存在：${versionId}`);
    }
    const previousVersionId = source.currentVersionId;
    const version = {
      sourceId,
      versionId,
      contentHash,
      issuedAt: issuedAt ?? this.now,
      note,
      supersedesVersionId: previousVersionId,
      status: "current",
      createdAt: this.now,
    };
    this.store.add("sourceVersions", versionId, version);
    this.store.update("sources", sourceId, (s) => {
      if (s.currentVersionId) {
        const old = this.store.get("sourceVersions", s.currentVersionId);
        this.store.put("sourceVersions", s.currentVersionId, { ...old, status: "superseded" });
      }
      s.currentVersionId = versionId;
      return s;
    });
    return this.store.get("sourceVersions", versionId);
  }

  /** 记录某来源版本的使用许可。 */
  grantLicense({ licenseId, sourceVersionId, scope = "internal", validFrom = null, validUntil = null, grantedBy = null }) {
    this._need("sourceVersions", sourceVersionId, "来源版本");
    if (this.store.has("licenses", licenseId)) throw new DomainError("ALREADY_EXISTS", `许可已存在：${licenseId}`);
    const license = {
      licenseId,
      sourceVersionId,
      scope, // internal | public
      validFrom,
      validUntil,
      grantedBy,
      grantedAt: this.now,
      revoked: false,
    };
    this.store.add("licenses", licenseId, license);
    return license;
  }

  revokeLicense({ licenseId }) {
    return this.store.update("licenses", licenseId, (l) => {
      l.revoked = true;
      l.revokedAt = this.now;
      return l;
    });
  }

  _licenseForVersion(sourceVersionId) {
    const all = this.store
      .list("licenses")
      .filter((l) => l.sourceVersionId === sourceVersionId && !l.revoked)
      .sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
    return all[0] ?? null;
  }

  // ───────────────────────── 试做记录 ─────────────────────────

  /**
   * 记录一次试做。conditions 记录原料、气候、器具等条件；
   * outcome: success | failed | inconclusive。
   */
  recordTrial({ trialId, process, conditions = {}, outcome, iterations = 1, note = "", conductorId = null }) {
    if (this.store.has("trials", trialId)) throw new DomainError("ALREADY_EXISTS", `试做已存在：${trialId}`);
    const trial = {
      trialId,
      process,
      conditions,
      outcome,
      iterations,
      note,
      conductorId,
      recordedAt: this.now,
    };
    this.store.add("trials", trialId, trial);
    return trial;
  }

  // ───────────────────────── 依据片段 ─────────────────────────

  /**
   * 把一个可核查的引用拆到具体片段。
   * kind: ancient_text | documentary | bearer_testimony | trial
   * supports: supports | contradicts
   * applicableRegions: [] 或 ["*"] 表示不限地域；["闽南"] 表示仅该地。
   */
  addEvidence({
    evidenceId,
    kind,
    sourceVersionId = null,
    trialId = null,
    excerpt = "",
    locator = "",
    supports = "supports",
    applicableRegions = ["*"],
    note = "",
    recordedBy = null,
  }) {
    if (this.store.has("evidence", evidenceId)) throw new DomainError("ALREADY_EXISTS", `依据片段已存在：${evidenceId}`);
    if (sourceVersionId) this._need("sourceVersions", sourceVersionId, "来源版本");
    if (trialId) this._need("trials", trialId, "试做记录");
    if (kind === "trial" && !trialId) throw new DomainError("INVALID_INPUT", "试做类依据必须关联试做记录");
    const evidence = {
      evidenceId,
      kind,
      sourceVersionId,
      trialId,
      excerpt,
      locator,
      supports,
      applicableRegions,
      note,
      recordedBy,
      createdAt: this.now,
    };
    this.store.add("evidence", evidenceId, evidence);
    return evidence;
  }

  /** 传承人对「口述依据支撑某主张」作出确认。 */
  confirmByBearer({ evidenceId, claimId, bearerId, note = "" }) {
    this._need("evidence", evidenceId, "依据片段");
    const confirmationId = `${evidenceId}:${claimId}`;
    if (this.store.has("confirmations", confirmationId)) {
      throw new DomainError("ALREADY_CONFIRMED", "该口述依据对此主张已确认");
    }
    const confirmation = {
      confirmationId,
      evidenceId,
      claimId,
      bearerId,
      note,
      confirmedAt: this.now,
    };
    this.store.add("confirmations", confirmationId, confirmation);
    return confirmation;
  }

  // ───────────────────────── 主张与编辑取舍 ─────────────────────────

  /** 提出一条可核查主张（例如「某工序通用做法为 X」）。 */
  proposeClaim({ claimId, process, statement, regions = ["*"], proposedBy = null }) {
    if (this.store.has("claims", claimId)) throw new DomainError("ALREADY_EXISTS", `主张已存在：${claimId}`);
    const claim = {
      claimId,
      process,
      statement,
      regions,
      proposedBy,
      evidenceIds: [],
      status: "proposed", // proposed | publishable | blocked | published | withdrawn
      versions: [],
      createdAt: this.now,
      updatedAt: this.now,
    };
    this.store.add("claims", claimId, claim);
    return claim;
  }

  /** 把依据片段关联到主张，并重新评估。 */
  attachEvidence({ claimId, evidenceId }) {
    this._need("claims", claimId, "主张");
    this._need("evidence", evidenceId, "依据片段");
    this.store.update("claims", claimId, (c) => {
      if (!c.evidenceIds.includes(evidenceId)) c.evidenceIds.push(evidenceId);
      return c;
    });
    return this.reevaluateClaim({ claimId });
  }

  detachEvidence({ claimId, evidenceId }) {
    this._need("claims", claimId, "主张");
    this.store.update("claims", claimId, (c) => {
      c.evidenceIds = c.evidenceIds.filter((id) => id !== evidenceId);
      return c;
    });
    return this.reevaluateClaim({ claimId });
  }

  _evaluationContext() {
    return {
      licenseFor: (svid) => this._licenseForVersion(svid),
      trialFor: (tid) => this.store.get("trials", tid),
      isConfirmedByBearer: (evidenceId, claimId) =>
        this.store.has("confirmations", `${evidenceId}:${claimId}`),
    };
  }

  _resolvedConflictsFor(claim) {
    const reviewIds = claim.reviews || [];
    const byEvidence = new Map();
    for (const id of reviewIds) {
      const review = this.store.get("reviews", id);
      if (review && (!byEvidence.has(review.evidenceId) || review.decidedAt > byEvidence.get(review.evidenceId).decidedAt)) {
        byEvidence.set(review.evidenceId, review);
      }
    }
    return [...byEvidence.values()].map((r) => ({
      evidenceId: r.evidenceId,
      decision: r.decision,
      qualification: r.qualification,
      editorId: r.editorId,
    }));
  }

  _latestCorrectionForVersion(sourceVersionId) {
    if (!sourceVersionId) return null;
    const corrections = this.store
      .list("corrections")
      .filter((c) => c.sourceVersionId === sourceVersionId)
      .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
    return corrections[0] ?? null;
  }

  /** 套用来源版本上已登记的更正，得到依据片段在当前时点的有效形态。 */
  _effectiveEvidence(ev) {
    const correction = this._latestCorrectionForVersion(ev.sourceVersionId);
    return correction ? this._evidenceAfterCorrection(ev, correction) : ev;
  }

  reevaluateClaim({ claimId }) {
    const claim = this._need("claims", claimId, "主张");
    const evidence = claim.evidenceIds
      .map((id) => this._need("evidence", id, "依据片段"))
      .map((ev) => this._effectiveEvidence(ev));
    const result = evaluateClaim({
      claim,
      evidence,
      now: this.now,
      resolvedConflicts: this._resolvedConflictsFor(claim),
      ...this._evaluationContext(),
    });
    this.store.update("claims", claimId, (c) => {
      c.lastEvaluation = result;
      c.hasConflict = result.conflicts.length > 0;
      c.openConflictCount = result.conflicts.filter((cf) => cf.resolution === "unresolved" || cf.resolution === "defer").length;
      if (result.eligible) c.status = c.status === "published" ? "published" : "publishable";
      else if (c.openConflictCount > 0) c.status = "blocked";
      else c.status = c.status === "published" ? "published" : "proposed";
      c.updatedAt = this.now;
      return c;
    });
    return this.store.get("claims", claimId);
  }

  /**
   * 编辑对分歧作出取舍决定。矛盾不会被自动消解：
   * decision: qualify（限定后采用）| exclude_note（在内部备注中保留分歧，不采用相反说）
   *           | defer（搁置，主张继续 blocked）
   * 决定与理由被记录，用于溯源「纠正决定由谁作出」。
   */
  resolveConflict({ claimId, evidenceId, editorId, decision, qualification = null, reason = "" }) {
    const claim = this._need("claims", claimId, "主张");
    this._need("evidence", evidenceId, "依据片段");
    if (!["qualify", "exclude_note", "defer"].includes(decision)) {
      throw new DomainError("INVALID_INPUT", "决定必须是 qualify、exclude_note 或 defer");
    }
    const seq = (claim.reviews?.length || 0) + 1;
    const reviewId = `rv-${claimId}-${evidenceId}-${seq}`;
    const review = {
      reviewId,
      claimId,
      evidenceId,
      editorId,
      decision,
      qualification,
      reason,
      decidedAt: this.now,
    };
    this.store.add("reviews", reviewId, review);
    this.store.update("claims", claimId, (c) => {
      c.reviews = c.reviews || [];
      c.reviews.push(reviewId);
      c.updatedAt = this.now;
      return c;
    });
    this.reevaluateClaim({ claimId });
    return review;
  }

  // ───────────────────────── 发布版本（公开 / 内部草稿） ─────────────────────────

  /**
   * 把主张编入一个发布版本。
   * - target=public：必须评估通过（证据充分、有公开许可、口述已确认、无未决矛盾、地域不越界）。
   * - target=draft：证据不足也允许，但会被标记为 internal_only。
   * 返回 release；每次发布生成新版本号，主张版本谱系记录它出现在哪些版本。
   */
  publishClaim({ claimId, target = "draft", editorId, statementOverride = null }) {
    const claim = this._need("claims", claimId, "主张");
    const evaluated = this.reevaluateClaim({ claimId });

    if (target === "public" && !evaluated.lastEvaluation.eligible) {
      throw new DomainError(
        "NOT_PUBLISHABLE",
        `主张不具备公开发布资格：${evaluated.lastEvaluation.violations.map((v) => v.code).join("、")}`
      );
    }

    const claimVersion = (claim.versions?.length || 0) + 1;
    const releaseId = `rel-${claimId}-v${claimVersion}`;
    const release = {
      releaseId,
      claimId,
      claimVersion,
      target, // public | draft
      statement: statementOverride ?? claim.statement,
      regions: claim.regions,
      editorId,
      internalOnly: target !== "public",
      evidenceIds: [...claim.evidenceIds],
      basisSnapshot: claim.lastEvaluation?.basis ?? [],
      violationsSnapshot: claim.lastEvaluation?.violations ?? [],
      publishedAt: this.now,
      withdrawn: false,
    };
    this.store.add("releases", releaseId, release);
    this.store.update("claims", claimId, (c) => {
      c.versions.push({
        claimVersion,
        releaseId,
        target,
        statement: release.statement,
        editorId,
        at: release.publishedAt,
      });
      if (target === "public") c.status = "published";
      c.updatedAt = this.now;
      return c;
    });
    return release;
  }

  _conflictDecided(claimId, evidenceId) {
    const claim = this.store.get("claims", claimId);
    const reviewIds = claim.reviews || [];
    const reviews = reviewIds
      .map((id) => this.store.get("reviews", id))
      .filter(Boolean)
      .filter((r) => r.evidenceId === evidenceId)
      .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
    return reviews[0] || null;
  }

  // ───────────────────────── 片段与剪辑（含限制闸门、并行剪辑） ─────────────────────────

  registerSnippet({ snippetId, releaseId, title = "", durationSec = 0, editorId = null }) {
    this._need("releases", releaseId, "发布版本");
    if (this.store.has("snippets", snippetId)) throw new DomainError("ALREADY_EXISTS", `片段已存在：${snippetId}`);
    const snippet = {
      snippetId,
      releaseId,
      title,
      durationSec,
      editorId,
      clipVersion: 1,
      state: "registered", // registered | clipped | published
      annotationIds: [],
      createdAt: this.now,
      updatedAt: this.now,
    };
    this.store.add("snippets", snippetId, snippet);
    return snippet;
  }

  /**
   * 对片段发起一次剪辑工作副本。多个剪辑师可并行检出，各自拿到当前 clipVersion。
   */
  checkoutSnippet({ snippetId, editorId }) {
    const snippet = this._need("snippets", snippetId, "片段");
    const checkoutId = `co-${snippetId}-${snippet.clipVersion}-${editorId}-${Math.random().toString(36).slice(2, 8)}`;
    const checkout = {
      checkoutId,
      snippetId,
      editorId,
      baseClipVersion: snippet.clipVersion,
      startedAt: this.now,
      open: true,
    };
    this.store.add("checkouts", checkoutId, checkout);
    return { checkout, clipVersion: snippet.clipVersion };
  }

  /**
   * 提交剪辑。expectedClipVersion 实现乐观并发：并行剪辑基于旧版本提交会被拒绝，
   * 避免有人绕过其间已经生效的限制。target=public 必须通过限制闸门。
   */
  commitSnippet({ snippetId, checkoutId, expectedClipVersion, target = "public", annotationIds = [], editorId }) {
    const snippet = this._need("snippets", snippetId, "片段");
    const checkout = this.store.get("checkouts", checkoutId);
    if (!checkout || checkout.snippetId !== snippetId || !checkout.open) {
      throw new DomainError("INVALID_CHECKOUT", "剪辑工作副本不存在或已关闭");
    }
    if (checkout.editorId !== editorId) throw new DomainError("FORBIDDEN", "只能提交自己检出的剪辑");
    if (expectedClipVersion !== snippet.clipVersion) {
      throw new DomainError("CLIP_VERSION_CONFLICT", `片段已被他人更新到 v${snippet.clipVersion}，请基于新版本重新剪辑`);
    }

    const restrictions = this.store.list("restrictions", (r) => r.snippetId === snippetId);
    const gate = restrictionGate(restrictions, this.now, target);
    if (!gate.allowed) {
      throw new DomainError(gate.code, `片段被限制：${gate.reason}（${gate.restrictionId}）`);
    }
    if (gate.requiresAnnotation && annotationIds.length === 0 && snippet.annotationIds.length === 0) {
      throw new DomainError("ANNOTATION_REQUIRED", `已生效限制要求追加说明（${gate.restrictionId}）`);
    }

    const updated = this.store.update("snippets", snippetId, (s) => {
      s.clipVersion += 1;
      s.state = target === "public" ? "published" : "clipped";
      s.annotationIds = [...new Set([...s.annotationIds, ...annotationIds])];
      s.lastCommit = { editorId, target, at: this.now, gate };
      s.updatedAt = this.now;
      return s;
    });
    this.store.put("checkouts", checkoutId, { ...checkout, open: false, closedAt: this.now });
    return updated;
  }

  /** 对片段生效限制：block（禁止公开使用）或 annotation_required（须追加说明）。 */
  imposeRestriction({ restrictionId, snippetId, type, reason = "", effectiveAt = null, issuedBy = null }) {
    this._need("snippets", snippetId, "片段");
    if (!["block", "annotation_required"].includes(type)) {
      throw new DomainError("INVALID_INPUT", "限制类型必须是 block 或 annotation_required");
    }
    const restriction = {
      restrictionId,
      snippetId,
      type,
      reason,
      issuedBy,
      effectiveAt: effectiveAt ?? this.now,
      status: "active",
      createdAt: this.now,
    };
    this.store.add("restrictions", restrictionId, restriction);
    return restriction;
  }

  // ───────────────────────── 下游渠道与发布物 ─────────────────────────

  registerChannel({ channelId, name, partnerId = null, receiptDeadlineHours = 72 }) {
    if (this.store.has("channels", channelId)) throw new DomainError("ALREADY_EXISTS", `渠道已存在：${channelId}`);
    const channel = { channelId, name, partnerId, receiptDeadlineHours, createdAt: this.now };
    this.store.add("channels", channelId, channel);
    return channel;
  }

  /** 登记某片段在某渠道上的实际发布物（旧视频、字幕切片、品牌合作稿等）。 */
  registerUsage({ usageId, snippetId, channelId, url = "", kind = "video", publishedAt = null }) {
    this._need("snippets", snippetId, "片段");
    this._need("channels", channelId, "渠道");
    const usage = {
      usageId,
      snippetId,
      channelId,
      url,
      kind,
      publishedAt: publishedAt ?? this.now,
      status: "live", // live | annotated | withdrawn
      createdAt: this.now,
    };
    this.store.add("usages", usageId, usage);
    return usage;
  }

  // ───────────────────────── 来源更正 → 影响面 → 处置单 ─────────────────────────

  /**
   * 登记一次来源更正。
   * correctionType: retract（撤回原说法）| qualify（证明仅适用某地）| erratum（刊误）
   */
  recordCorrection({ correctionId, sourceVersionId, correctionType, regionsScopedTo = null, note = "", decidedBy = null }) {
    this._need("sourceVersions", sourceVersionId, "来源版本");
    if (!["retract", "qualify", "erratum"].includes(correctionType)) {
      throw new DomainError("INVALID_INPUT", "更正类型必须是 retract、qualify 或 erratum");
    }
    const correction = {
      correctionId,
      sourceVersionId,
      correctionType,
      regionsScopedTo,
      note,
      decidedBy,
      recordedAt: this.now,
    };
    this.store.add("corrections", correctionId, correction);

    if (correctionType === "retract") {
      this.store.update("sourceVersions", sourceVersionId, (v) => ({ ...v, status: "retracted" }));
    }
    return correction;
  }

  /** 沿 来源版本 → 依据 → 主张 → 发布版本 → 片段 → 发布物 计算受影响范围并分级。 */
  analyzeCorrectionImpact({ correctionId }) {
    const correction = this._need("corrections", correctionId, "更正");
    const impactedEvidence = this.store
      .list("evidence")
      .filter((e) => e.sourceVersionId === correction.sourceVersionId);

    // 同一发布物可能经由多条依据/主张被波及，按对象去重并保留最严重的分级。
    const byKey = new Map();
    const rank = { withdraw: 3, annotate: 2, none: 1 };
    const merge = (impact) => {
      const key = impact.usageId ? `usage:${impact.usageId}` : `draft:${impact.claimId}:${impact.evidenceId}`;
      const prev = byKey.get(key);
      if (!prev || rank[impact.severity] > rank[prev.severity]) byKey.set(key, impact);
    };

    for (const ev of impactedEvidence) {
      const claims = this.store.list("claims", (c) => c.evidenceIds.includes(ev.evidenceId));
      for (const claim of claims) {
        // 更正前评估：沿用主张最近一次评估快照。
        const before = claim.lastEvaluation ?? { eligible: false, violations: [] };
        const scopedEvidence = claim.evidenceIds.map((id) =>
          id === ev.evidenceId ? this._evidenceAfterCorrection(ev, correction) : this.store.get("evidence", id)
        );
        const after = evaluateClaim({
          claim: structuredClone(claim),
          evidence: scopedEvidence,
          now: this.now,
          ...this._evaluationContext(),
        });

        const publicReleases = this.store
          .list("releases")
          .filter((r) => r.claimId === claim.claimId && r.target === "public" && !r.withdrawn);

        for (const release of publicReleases) {
          const classification = classifyCorrectionImpact({
            correctionType: correction.correctionType,
            wasPublic: true,
            before,
            after,
          });
          const snippets = this.store.list("snippets", (s) => s.releaseId === release.releaseId);
          for (const snippet of snippets) {
            const usages = this.store.list("usages", (u) => u.snippetId === snippet.snippetId && u.status === "live");
            for (const usage of usages) {
              merge({
                correctionId,
                evidenceId: ev.evidenceId,
                claimId: claim.claimId,
                releaseId: release.releaseId,
                snippetId: snippet.snippetId,
                usageId: usage.usageId,
                channelId: usage.channelId,
                severity: classification.severity,
                reason: classification.reason,
              });
            }
          }
        }

        // 未公开或仅有草稿的路径：分级为 none，仍保留在影响面里以便审计。
        if (publicReleases.length === 0) {
          merge({
            correctionId,
            evidenceId: ev.evidenceId,
            claimId: claim.claimId,
            releaseId: null,
            snippetId: null,
            usageId: null,
            channelId: null,
            severity: "none",
            reason: classifyCorrectionImpact({
              correctionType: correction.correctionType,
              wasPublic: false,
              before,
              after,
            }).reason,
          });
        }

        // 用更正后的视角刷新主张评估（撤回由处置单驱动，此处不自动改发布状态）。
        this.store.update("claims", claim.claimId, (c) => {
          c.lastEvaluation = after;
          c.hasConflict = after.conflicts.length > 0;
          c.pendingCorrectionIds = [...new Set([...(c.pendingCorrectionIds || []), correctionId])];
          return c;
        });
      }
    }

    const impacts = [...byKey.values()];
    const summary = {
      correctionId,
      withdraw: impacts.filter((i) => i.severity === "withdraw").length,
      annotate: impacts.filter((i) => i.severity === "annotate").length,
      none: impacts.filter((i) => i.severity === "none").length,
      computedAt: this.now,
    };
    this.store.put("impactAnalyses", correctionId, { summary, impacts });
    return { summary, impacts };
  }

  _evidenceAfterCorrection(evidence, correction) {
    if (correction.correctionType === "retract") {
      // 撤回不等于相反主张：依据转为中立，是否仍成立取决于其余依据。
      return { ...evidence, supports: "retracted", note: `来源版本已撤回：${correction.note || correction.correctionId}` };
    }
    if (correction.correctionType === "qualify" && correction.regionsScopedTo) {
      return { ...evidence, applicableRegions: correction.regionsScopedTo };
    }
    return evidence; // erratum 不改变据支撑结构，分级上仍要求追加说明
  }

  // ───────────────────────── 处置单与渠道回执（回调幂等） ─────────────────────────

  /**
   * 依据影响面生成处置单。幂等：同一 correctionId 只生成一套处置单，
   * 合作方重放发布回调不会产生重复处置单。
   */
  issueDispositionTickets({ correctionId, callbackId = null }) {
    this._need("corrections", correctionId, "更正");
    if (callbackId) {
      const existing = this.store.get("callbacks", callbackId);
      if (existing) {
        return { replayed: true, callbackId, tickets: existing.ticketIds.map((id) => this.store.get("tickets", id)) };
      }
    }

    if (!this.store.has("impactAnalyses", correctionId)) {
      this.analyzeCorrectionImpact({ correctionId });
    }
    const current = this.store.get("impactAnalyses", correctionId);

    const existingTickets = this.store.list("tickets", (t) => t.correctionId === correctionId);
    if (existingTickets.length > 0) {
      if (callbackId) this._rememberCallback(callbackId, correctionId, existingTickets.map((t) => t.ticketId));
      return { replayed: true, callbackId: callbackId ?? null, tickets: existingTickets };
    }

    const channel = this.store.list("channels");
    const deadlineFor = (channelId) => {
      const ch = channel.find((c) => c.channelId === channelId);
      const hours = ch ? ch.receiptDeadlineHours : 72;
      return new Date(Date.parse(this.now) + hours * 3600_000).toISOString();
    };

    const tickets = [];
    for (const impact of current.impacts) {
      if (impact.severity === "none") continue;
      const ticketId = `tk-${impact.correctionId}-${impact.usageId}`;
      const ticket = {
        ticketId,
        correctionId: impact.correctionId,
        usageId: impact.usageId,
        snippetId: impact.snippetId,
        channelId: impact.channelId,
        action: impact.severity, // withdraw | annotate
        reason: impact.reason,
        status: "issued", // issued | acknowledged | done | overdue
        receiptDeadline: deadlineFor(impact.channelId),
        issuedAt: this.now,
        events: [{ type: "issued", at: this.now }],
      };
      this.store.add("tickets", ticketId, ticket);
      tickets.push(ticket);

      // 撤回类处置单立即对相关片段生效 block 限制，阻止并行剪辑继续公开使用。
      if (impact.severity === "withdraw") {
        this.imposeRestriction({
          restrictionId: `rs-${ticket.ticketId}`,
          snippetId: impact.snippetId,
          type: "block",
          reason: `来源更正撤回：${impact.reason}`,
          issuedBy: "system",
        });
      } else {
        this.imposeRestriction({
          restrictionId: `rs-${ticket.ticketId}`,
          snippetId: impact.snippetId,
          type: "annotation_required",
          reason: `来源更正追加说明：${impact.reason}`,
          issuedBy: "system",
        });
      }
    }

    const ticketIds = tickets.map((t) => t.ticketId);
    if (callbackId) this._rememberCallback(callbackId, correctionId, ticketIds);
    return { replayed: false, callbackId: callbackId ?? null, tickets };
  }

  _rememberCallback(callbackId, correctionId, ticketIds) {
    this.store.add("callbacks", callbackId, {
      callbackId,
      correctionId,
      ticketIds,
      receivedAt: this.now,
    });
  }

  /**
   * 合作方发布回调（重放安全）。同一 callbackId 第二次到达时直接返回首次结果，
   * 不重复生成处置单、不重复登记回执。
   */
  receivePublishCallback({ callbackId, correctionId, partnerId = null, payload = null }) {
    const seen = this.store.get("callbacks", callbackId);
    if (seen) {
      return {
        replayed: true,
        callbackId,
        correctionId: seen.correctionId,
        ticketIds: seen.ticketIds,
        receivedAt: seen.receivedAt,
      };
    }
    const result = this.issueDispositionTickets({ correctionId, callbackId });
    return { replayed: false, callbackId, correctionId, ticketIds: result.tickets.map((t) => t.ticketId) };
  }

  /**
   * 渠道对处置单回执。status: acknowledged | done。
   * 超过期限未 done 的处置单可通过 markOverdueTickets 标记。
   */
  acknowledgeTicket({ ticketId, channelId, status = "acknowledged", note = "" }) {
    const ticket = this._need("tickets", ticketId, "处置单");
    if (ticket.channelId !== channelId) throw new DomainError("FORBIDDEN", "渠道与处置单不匹配");
    return this.store.update("tickets", ticketId, (t) => {
      t.status = status;
      t.events.push({ type: status, channelId, note, at: this.now });
      if (status === "done") {
        t.completedAt = this.now;
        const usage = this.store.get("usages", t.usageId);
        if (usage) {
          this.store.put("usages", t.usageId, {
            ...usage,
            status: t.action === "withdraw" ? "withdrawn" : "annotated",
          });
        }
      }
      return t;
    });
  }

  /** 扫描逾期未完成的处置单。 */
  markOverdueTickets() {
    const nowMs = Date.parse(this.now);
    const overdue = [];
    for (const t of this.store.list("tickets")) {
      if ((t.status === "issued" || t.status === "acknowledged") && Date.parse(t.receiptDeadline) < nowMs) {
        const updated = this.store.update("tickets", t.ticketId, (x) => {
          if (x.status !== "overdue") {
            x.status = "overdue";
            x.events.push({ type: "overdue", at: this.now });
          }
          return x;
        });
        overdue.push(updated);
      }
    }
    return overdue;
  }

  // ───────────────────────── 溯源 ─────────────────────────

  /**
   * 一条公开表述为何被允许：
   * 发布版本快照、依据与来源版本、许可、传承人确认、编辑决定、矛盾保留、
   * 它在哪些主张版本出现、相关处置单与各渠道回执状态。
   */
  explainRelease({ releaseId }) {
    const release = this._need("releases", releaseId, "发布版本");
    const claim = this._need("claims", release.claimId, "主张");

    const evidence = release.evidenceIds.map((evidenceId) => {
      const rawEv = this.store.get("evidence", evidenceId);
      const ev = this._effectiveEvidence(rawEv);
      const activeCorrection = this._latestCorrectionForVersion(rawEv.sourceVersionId);
      const sourceVersion = ev.sourceVersionId ? this.store.get("sourceVersions", ev.sourceVersionId) : null;
      const source = sourceVersion ? this.store.get("sources", sourceVersion.sourceId) : null;
      const license = ev.sourceVersionId ? this._licenseForVersion(ev.sourceVersionId) : null;
      const confirmation =
        ev.kind === "bearer_testimony" ? this.store.get("confirmations", `${evidenceId}:${claim.claimId}`) : null;
      const review = this._conflictDecided(claim.claimId, evidenceId);
      return {
        evidenceId,
        kind: ev.kind,
        supports: ev.supports,
        applicableRegions: ev.applicableRegions,
        excerpt: ev.excerpt,
        activeCorrection: activeCorrection
          ? {
              correctionId: activeCorrection.correctionId,
              correctionType: activeCorrection.correctionType,
              regionsScopedTo: activeCorrection.regionsScopedTo,
              decidedBy: activeCorrection.decidedBy,
              recordedAt: activeCorrection.recordedAt,
            }
          : null,
        sourceVersion: sourceVersion
          ? {
              versionId: sourceVersion.versionId,
              sourceId: source.sourceId,
              title: source.title,
              status: sourceVersion.status,
              contentHash: sourceVersion.contentHash,
              issuedAt: sourceVersion.issuedAt,
            }
          : null,
        license: license
          ? {
              licenseId: license.licenseId,
              scope: license.scope,
              validFrom: license.validFrom,
              validUntil: license.validUntil,
              revoked: license.revoked,
            }
          : null,
        bearerConfirmation: confirmation
          ? { bearerId: confirmation.bearerId, confirmedAt: confirmation.confirmedAt }
          : null,
        conflictResolution: review
          ? { editorId: review.editorId, decision: review.decision, reason: review.reason, decidedAt: review.decidedAt }
          : null,
      };
    });

    const snippets = this.store.list("snippets", (s) => s.releaseId === releaseId);
    const usageTrace = [];
    for (const snippet of snippets) {
      const restrictions = this.store.list("restrictions", (r) => r.snippetId === snippet.snippetId);
      for (const usage of this.store.list("usages", (u) => u.snippetId === snippet.snippetId)) {
        const tickets = this.store.list("tickets", (t) => t.usageId === usage.usageId);
        usageTrace.push({
          snippetId: snippet.snippetId,
          clipVersion: snippet.clipVersion,
          channelId: usage.channelId,
          usageId: usage.usageId,
          url: usage.url,
          usageStatus: usage.status,
          restrictions: restrictions.map((r) => ({
            restrictionId: r.restrictionId,
            type: r.type,
            status: r.status,
            effectiveAt: r.effectiveAt,
          })),
          tickets: tickets.map((t) => ({
            ticketId: t.ticketId,
            action: t.action,
            status: t.status,
            receiptDeadline: t.receiptDeadline,
            events: t.events,
            withinDeadline: this._ticketWithinDeadline(t),
          })),
        });
      }
    }

    // 当前视角的成立性：套用来源版本上的全部更正后重新评估，
    // 与「发布当时为何被允许」的快照区分开。
    const currentEvaluation = evaluateClaim({
      claim: structuredClone(claim),
      evidence: release.evidenceIds.map((id) => this._effectiveEvidence(this.store.get("evidence", id))),
      now: this.now,
      resolvedConflicts: this._resolvedConflictsFor(claim),
      ...this._evaluationContext(),
    });
    const openConflictsNow = currentEvaluation.conflicts.filter(
      (cf) => cf.resolution === "unresolved" || cf.resolution === "defer"
    );
    const currentStanding = {
      stillHolds: currentEvaluation.eligible && openConflictsNow.length === 0,
      violations: currentEvaluation.violations,
      activeCorrectionIds: evidence.filter((e) => e.activeCorrection).map((e) => e.activeCorrection.correctionId),
      evaluatedAt: this.now,
    };

    return {
      release: {
        releaseId: release.releaseId,
        target: release.target,
        statement: release.statement,
        regions: release.regions,
        editorId: release.editorId,
        publishedAt: release.publishedAt,
        allowedBecause: this._allowedBecause(release),
        currentStanding,
      },
      claim: {
        claimId: claim.claimId,
        statement: claim.statement,
        versions: claim.versions,
        status: claim.status,
      },
      evidence,
      unresolvedConflicts: (claim.lastEvaluation?.conflicts || []).map((cf) => ({
        evidenceId: cf.evidenceId,
        note: cf.note,
        resolution: cf.resolution,
      })),
      downstream: usageTrace,
      explainedAt: this.now,
    };
  }

  _allowedBecause(release) {
    if (release.target !== "public") return ["INTERNAL_DRAFT_ONLY：证据不足时允许进入内部草稿，不对外公开"];
    const reasons = ["EVIDENCE_SUFFICIENT：发布时评估通过（支持性依据、试做成功、地域不越界）"];
    if (release.basisSnapshot.some((b) => b.sourceVersionId)) reasons.push("PUBLIC_LICENSE：引用的来源版本具备有效公开使用许可");
    if (release.basisSnapshot.some((b) => b.kind === "bearer_testimony")) reasons.push("BEARER_CONFIRMED：口述依据已经传承人确认");
    return reasons;
  }

  _ticketWithinDeadline(ticket) {
    const done = ticket.events.filter((e) => e.type === "done").sort((a, b) => (a.at < b.at ? -1 : 1))[0];
    if (!done) return false;
    return Date.parse(done.at) <= Date.parse(ticket.receiptDeadline);
  }

  /** 处置台总览：各渠道是否都在期限内回执。 */
  correctionStatus({ correctionId }) {
    this._need("corrections", correctionId, "更正");
    const tickets = this.store.list("tickets", (t) => t.correctionId === correctionId);
    const channels = {};
    for (const t of tickets) {
      const entry = channels[t.channelId] || { channelId: t.channelId, total: 0, done: 0, overdue: 0, allReceiptedInTime: true };
      entry.total += 1;
      const inTime = this._ticketWithinDeadline(t);
      if (t.status === "done") entry.done += 1;
      if (t.status === "overdue" || (t.status === "done" && !inTime)) entry.overdue += 1;
      if (!inTime) entry.allReceiptedInTime = false;
      channels[t.channelId] = entry;
    }
    return {
      correctionId,
      ticketCount: tickets.length,
      allDone: tickets.length > 0 && tickets.every((t) => t.status === "done" && this._ticketWithinDeadline(t)),
      channels: Object.values(channels),
      tickets: tickets.map((t) => ({
        ticketId: t.ticketId,
        channelId: t.channelId,
        action: t.action,
        status: t.status,
        withinDeadline: this._ticketWithinDeadline(t),
      })),
    };
  }
}
