/**
 * 传统技艺内容依据管理服务。
 *
 * 关键约束（见 README 与 policy.js）：
 * - 主张拆到具体片段；来源记录版本、许可、地域范围；传承人确认、试做条件、编辑取舍逐项留痕。
 * - 证据不足的主张只能停留在内部草稿；互相矛盾的来源以"分歧"显式保留，系统不自动选边。
 * - 来源更正时算出全部受影响主张与下游发布物，分级为撤回 / 追加说明 / 无需处理并开处置单。
 * - 合作方回调按事件编号幂等，重放不产生重复处置单；同一片段的并行操作经按主张串行的锁排队。
 */
import { Clock } from "./clock.js";
import { Store } from "./store.js";
import { KeyLock } from "./lock.js";
import { conflict, insufficientEvidence, invalidRequest, notFound, restrictionActive } from "./errors.js";
import {
  LICENSE,
  SOURCE_TYPES,
  evaluateClaim,
  gradeAction,
  receiptStatus,
  restrictionForCorrection,
} from "./policy.js";

const HOUR_MS = 3600_000;

function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString();
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw invalidRequest(`${label}缺失`);
  return value;
}

export class Service {
  constructor({
    store = new Store(),
    clock = new Clock(),
    locks = new KeyLock(),
    deadlines = { retract: 72, annotate: 168 },
  } = {}) {
    /** 兼容基础脚手架的通用登记存储。 */
    this.store = store;
    this.clock = clock;
    this.locks = locks;
    this.deadlines = deadlines;

    this.sources = new Store();
    this.claims = new Store();
    this.disagreements = new Store();
    this.versions = new Store();
    this.clips = new Store();
    this.publications = new Store();
    this.restrictions = new Store();
    this.orders = new Store();
    /** 合作方事件（发布回调、回执回调）幂等登记。 */
    this.events = new Store();
  }

  health() {
    return { service: "craft_claims", status: "ok" };
  }

  // ───────────────────────── 基础登记（脚手架兼容） ─────────────────────────

  register(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.clock.now() };
    this.store.add(record);
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get(recordId);
  }

  // ──────────────────────────────── 来源 ────────────────────────────────

  registerSource(input = {}) {
    const sourceId = required(input.sourceId, "来源编号");
    const kind = required(input.kind, "来源类型");
    if (!SOURCE_TYPES.has(kind)) throw invalidRequest("不支持的来源类型", { kind });
    const licenseStatus = input.licenseStatus ?? LICENSE.UNKNOWN;
    if (!Object.values(LICENSE).includes(licenseStatus)) throw invalidRequest("许可状态不合法");
    const source = {
      recordId: sourceId,
      sourceId,
      kind,
      title: typeof input.title === "string" ? input.title : "",
      originKey: required(input.originKey, "出处标识"), // 同出处的版本/转述共享，用于判断独立性
      versionLabel: String(input.versionLabel ?? "1"),
      versionDate: String(input.versionDate ?? this.clock.now()),
      license: {
        status: licenseStatus,
        terms: typeof input.licenseTerms === "string" ? input.licenseTerms : "",
      },
      regionScope: Array.isArray(input.regionScope) ? [...input.regionScope] : [],
      supersedes: Array.isArray(input.supersedes) ? [...input.supersedes] : [],
      corrections: [],
      withdrawn: false,
      createdAt: this.clock.now(),
    };
    this.sources.add(source);
    return this.sources.get(sourceId);
  }

  /**
   * 来源更正（撤回 / 收窄地域 / 细节更正）。
   * 同一 correctionId 重放直接返回既有影响报告，不重复施加限制、不重复开单。
   */
  async correctSource(input = {}) {
    const sourceId = required(input.sourceId, "来源编号");
    const correctionId = required(input.correctionId, "更正编号");
    const type = required(input.type, "更正类型");
    if (!["withdraw", "narrow_scope", "correct_detail"].includes(type)) {
      throw invalidRequest("更正类型不合法", { type });
    }
    const source = this._require(this.sources, sourceId, "来源");
    const already = source.corrections.find((item) => item.correctionId === correctionId);
    if (already) return this.correctionImpact(correctionId);

    if (type === "narrow_scope") {
      if (!Array.isArray(input.regions) || input.regions.length === 0) {
        throw invalidRequest("收窄地域必须给出适用地域");
      }
    }

    const at = this.clock.now();
    source.corrections.push({
      correctionId,
      type,
      note: typeof input.note === "string" ? input.note : "",
      regions: Array.isArray(input.regions) ? [...input.regions] : [],
      decidedBy: required(input.decidedBy, "纠正决定人"),
      at,
    });
    if (type === "withdraw") {
      source.withdrawn = true;
      source.license.status = LICENSE.DENIED;
    }
    if (type === "narrow_scope") source.regionScope = [...input.regions];
    this.sources.put(source);

    // 仅已公开（含已受限）的主张需要对外处置；草稿主张由证据评估自然挡住。
    const affected = this.claims
      .list()
      .filter((claim) => claim.status !== "draft" && claim.evidence.some((item) => item.sourceId === sourceId))
      .sort((a, b) => (a.claimId < b.claimId ? -1 : 1));

    for (const claim of affected) {
      await this.locks.withLock(this._claimKey(claim.claimId), async () => {
        const current = this._require(this.claims, claim.claimId, "主张");
        this._applyRestriction(current, {
          correctionId,
          sourceId,
          type,
          regions: source.corrections.at(-1).regions,
          decidedBy: input.decidedBy,
          note: source.corrections.at(-1).note,
        });
      });
    }
    return this.correctionImpact(correctionId);
  }

  // ──────────────────────────────── 主张 ────────────────────────────────

  registerClaim(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const scope = this._normalizeScope(input.scope);
    const claim = {
      recordId: claimId,
      claimId,
      statement: typeof input.statement === "string" ? input.statement : "",
      kind: input.kind === "other" ? "other" : "process",
      scope,
      evidence: [],
      inheritorConfirmation: null,
      trials: [],
      editorialNote: "",
      carriedDisagreements: [],
      status: "draft",
      revision: 1,
      createdAt: this.clock.now(),
    };
    this.claims.add(claim);
    this.versions.add({
      recordId: `ver-${claimId}-1`,
      versionId: `ver-${claimId}-1`,
      claimId,
      revision: 1,
      status: "draft",
      statement: claim.statement,
      scope: structuredClone(claim.scope),
      createdBy: input.openedBy ?? null,
      at: claim.createdAt,
    });
    return this.claims.get(claimId);
  }

  attachEvidence(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const sourceId = required(input.sourceId, "来源编号");
    const claim = this._require(this.claims, claimId, "主张");
    this._require(this.sources, sourceId, "来源");
    if (claim.evidence.some((item) => item.sourceId === sourceId)) {
      throw conflict("该来源已挂接在此主张上");
    }
    claim.evidence.push({ sourceId, addedAt: this.clock.now() });
    this.claims.put(claim);
    return this.claims.get(claimId);
  }

  confirmInheritor(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const inheritorId = required(input.inheritorId, "传承人编号");
    const claim = this._require(this.claims, claimId, "主张");
    claim.inheritorConfirmation = {
      inheritorId,
      name: typeof input.name === "string" ? input.name : "",
      at: this.clock.now(),
    };
    this.claims.put(claim);
    return this.claims.get(claimId);
  }

  recordTrial(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const trialId = required(input.trialId, "试做编号");
    const conditions = required(input.conditions, "试做条件");
    const result = input.result === "failed" ? "failed" : "reproduced";
    const claim = this._require(this.claims, claimId, "主张");
    if (claim.trials.some((item) => item.trialId === trialId)) throw conflict("试做编号已存在");
    claim.trials.push({ trialId, conditions, result, at: this.clock.now() });
    this.claims.put(claim);
    return this.claims.get(claimId);
  }

  setEditorialNote(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const note = required(input.editorialNote, "编辑取舍说明");
    const claim = this._require(this.claims, claimId, "主张");
    claim.editorialNote = note;
    this.claims.put(claim);
    return this.claims.get(claimId);
  }

  /** 显式携带一条尚未关闭的分歧：编辑确认公开时并列呈现两种说法，而不是静默选边。 */
  carryDisagreement(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const disagreementId = required(input.disagreementId, "分歧编号");
    const claim = this._require(this.claims, claimId, "主张");
    const disagreement = this._require(this.disagreements, disagreementId, "分歧");
    if (disagreement.claimId !== claimId) throw invalidRequest("分歧不属于该主张");
    if (disagreement.status !== "open") throw conflict("分歧已关闭，无需携带");
    if (!claim.carriedDisagreements.includes(disagreementId)) claim.carriedDisagreements.push(disagreementId);
    this.claims.put(claim);
    return this.claims.get(claimId);
  }

  /** 编辑收窄主张的地域适用范围（来源被证明仅适用于某地后使用），留新版本。 */
  reviseClaimScope(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const decidedBy = required(input.decidedBy, "改范围决定人");
    const scope = this._normalizeScope(input.scope);
    const claim = this._require(this.claims, claimId, "主张");
    this._gateScope(claim, scope, input.incorporatesCorrections ?? []);
    claim.scope = scope;
    this._snapshot(claim, decidedBy);
    return this.claims.get(claimId);
  }

  /** 发布决定：证据不足则拒绝，主张继续停留在内部分草稿。 */
  publishClaim(input = {}) {
    const claimId = required(input.claimId, "主张编号");
    const decidedBy = required(input.decidedBy, "发布决定人");
    const claim = this._require(this.claims, claimId, "主张");
    if (claim.status === "retracted") throw conflict("主张已撤回，不能再发布");
    // 已生效的更正限制同样约束重新发布：撤回不可复活，地域收窄须收敛范围，
    // 细节更正须声明本次发布已吸收更正说法。
    this._gateScope(claim, claim.scope, input.incorporatesCorrections ?? []);
    const evaluation = this._evaluate(claim);
    if (!evaluation.publishable) {
      throw insufficientEvidence("证据不满足公开条件，主张只能保留为内部草稿", { reasons: evaluation.reasons });
    }
    claim.status = "published";
    this._snapshot(claim, decidedBy);
    return this.claims.get(claimId);
  }

  /** 一条公开表述"为什么被允许"的完整解释。 */
  explainClaim(claimId) {
    const claim = this._require(this.claims, claimId, "主张");
    const evaluation = this._evaluate(claim);
    const restrictions = this._activeRestrictions(claimId);
    const evidence = claim.evidence.map((item) => {
      const source = this.sources.get(item.sourceId);
      return {
        sourceId: item.sourceId,
        addedAt: item.addedAt,
        type: source?.kind,
        originKey: source?.originKey,
        title: source?.title,
        version: { label: source?.versionLabel, date: source?.versionDate },
        license: source?.license,
        regionScope: source?.regionScope ?? [],
        withdrawn: source?.withdrawn ?? false,
        corrections: source?.corrections ?? [],
      };
    });
    const disagreementLinks = this.disagreements
      .list((item) => item.claimId === claimId)
      .map((item) => structuredClone(item));
    return {
      claim: structuredClone(claim),
      allowance: {
        public: claim.status === "published" && restrictions.length === 0,
        status: claim.status,
        evaluation,
        blockingRestrictions: restrictions.map((item) => item.restrictionId),
      },
      evidence,
      disagreements: disagreementLinks,
      versions: this.versions.list((item) => item.claimId === claimId).sort((a, b) => a.revision - b.revision),
      activeRestrictions: restrictions,
      channelReceipts: this.orders
        .list((item) => item.claimId === claimId)
        .map((order) => this._orderView(order)),
      decisions: this._decisionTrail(claimId),
    };
  }

  // ──────────────────────────────── 分歧 ────────────────────────────────

  openDisagreement(input = {}) {
    const disagreementId = required(input.disagreementId, "分歧编号");
    const claimId = required(input.claimId, "主张编号");
    this._require(this.claims, claimId, "主张");
    const positions = Array.isArray(input.positions) ? input.positions : [];
    if (positions.length < 2) throw invalidRequest("分歧至少需要两个对立立场");
    const distinctSources = new Set();
    for (const position of positions) {
      const sourceId = required(position.sourceId, "立场来源编号");
      this._require(this.sources, sourceId, "来源");
      distinctSources.add(sourceId);
    }
    if (distinctSources.size < 2) throw invalidRequest("分歧立场必须来自不同来源");
    const disagreement = {
      recordId: disagreementId,
      disagreementId,
      claimId,
      summary: typeof input.summary === "string" ? input.summary : "",
      positions: positions.map((position) => ({
        sourceId: position.sourceId,
        note: typeof position.note === "string" ? position.note : "",
      })),
      status: "open",
      openedBy: required(input.openedBy, "分歧记录人"),
      openedAt: this.clock.now(),
      closedBy: null,
      closedAt: null,
      resolutionNote: "",
    };
    this.disagreements.add(disagreement);
    return this.disagreements.get(disagreementId);
  }

  addPosition(input = {}) {
    const disagreementId = required(input.disagreementId, "分歧编号");
    const sourceId = required(input.sourceId, "立场来源编号");
    const disagreement = this._require(this.disagreements, disagreementId, "分歧");
    if (disagreement.status !== "open") throw conflict("分歧已关闭");
    this._require(this.sources, sourceId, "来源");
    if (disagreement.positions.some((item) => item.sourceId === sourceId)) throw conflict("该来源立场已记录");
    disagreement.positions.push({ sourceId, note: typeof input.note === "string" ? input.note : "" });
    this.disagreements.put(disagreement);
    return this.disagreements.get(disagreementId);
  }

  /** 编辑可以关闭分歧（例如有新证据），但关闭不会改写任何已发布主张，只留决定痕迹。 */
  closeDisagreement(input = {}) {
    const disagreementId = required(input.disagreementId, "分歧编号");
    const decidedBy = required(input.decidedBy, "关闭决定人");
    const disagreement = this._require(this.disagreements, disagreementId, "分歧");
    if (disagreement.status !== "open") throw conflict("分歧已关闭");
    disagreement.status = "closed";
    disagreement.closedBy = decidedBy;
    disagreement.closedAt = this.clock.now();
    disagreement.resolutionNote = typeof input.resolutionNote === "string" ? input.resolutionNote : "";
    this.disagreements.put(disagreement);
    return this.disagreements.get(disagreementId);
  }

  // ───────────────────────── 片段（剪辑）与下游发布物 ─────────────────────────

  /**
   * 登记剪辑片段。按主张加锁：与来源更正施加限制并发时，
   * 后执行者必须看到先生效的限制，不能并行绕过。
   */
  async createClip(input = {}) {
    const clipId = required(input.clipId, "片段编号");
    const claimId = required(input.claimId, "主张编号");
    const scope = this._normalizeScope(input.scope);
    return this.locks.withLock(this._claimKey(claimId), async () => {
      const claim = this._require(this.claims, claimId, "主张");
      this._gateScope(claim, scope, input.incorporatesCorrections ?? []);
      const clip = {
        recordId: clipId,
        clipId,
        claimId,
        editingSessionId: typeof input.editingSessionId === "string" ? input.editingSessionId : null,
        scope: structuredClone(scope),
        incorporatesCorrections: Array.isArray(input.incorporatesCorrections)
          ? [...input.incorporatesCorrections]
          : [],
        createdAt: this.clock.now(),
        publicationId: null,
      };
      this.clips.add(clip);
      return this.clips.get(clipId);
    });
  }

  /**
   * 合作方发布回调：把若干片段汇成下游发布物（成片、字幕切片、品牌合作稿等）。
   * eventId 幂等——重放同一回调返回原发布物，不重复生成处置单或其他副作用。
   */
  async releasePublication(input = {}) {
    const eventId = required(input.eventId, "回调事件编号");
    const seen = this.events.get(eventId);
    if (seen) {
      return { replayed: true, publication: this.publications.get(seen.publicationId) };
    }
    const publicationId = required(input.publicationId, "发布物编号");
    const channel = required(input.channel, "发布渠道");
    const clipIds = Array.isArray(input.clipIds) ? input.clipIds.map(String) : [];
    if (clipIds.length === 0) throw invalidRequest("发布物至少包含一个片段");
    for (const clipId of clipIds) this._require(this.clips, clipId, "片段");

    const claimIds = new Set(
      clipIds.map((clipId) => this._require(this.clips, clipId, "片段").claimId),
    );
    // 多主张时按固定顺序取锁，避免并发发布互相死等。
    const ordered = [...claimIds].sort();
    return this._withClaimLocks(ordered, async () => {
      // 锁内复检：另一个并行回调可能已经把同一片段归入别的发布物，
      // 来源更正也可能在我们排队等待期间刚生效。
      const clips = [];
      for (const clipId of clipIds) {
        const clip = this._require(this.clips, clipId, "片段");
        if (clip.publicationId) throw conflict("片段已归入其他发布物", { clipId: clip.clipId });
        clips.push(clip);
      }
      for (const clip of clips) {
        const claim = this._require(this.claims, clip.claimId, "主张");
        if (claim.status === "draft") {
          throw insufficientEvidence("主张仍为内部草稿，不能进入公开发布物", { claimId: claim.claimId });
        }
        this._gateScope(claim, clip.scope, clip.incorporatesCorrections);
      }
      const now = this.clock.now();
      const publication = {
        recordId: publicationId,
        publicationId,
        eventId,
        channel,
        title: typeof input.title === "string" ? input.title : "",
        clips: clips.map((clip) => ({
          clipId: clip.clipId,
          claimId: clip.claimId,
          scope: structuredClone(clip.scope),
        })),
        status: "live",
        annotatedCorrectionIds: [],
        decidedBy: required(input.decidedBy, "发布决定人"),
        publishedAt: now,
      };
      this.publications.add(publication);
      for (const clip of clips) {
        clip.publicationId = publicationId;
        this.clips.put(clip);
      }
      this.events.add({ recordId: eventId, eventId, kind: "release", publicationId, at: now });
      return { replayed: false, publication: this.publications.get(publicationId) };
    });
  }

  /** 渠道对处置单的回执（已撤回 / 已追加说明）。回执事件同样幂等。 */
  recordOrderReceipt(input = {}) {
    const eventId = required(input.eventId, "回执事件编号");
    const seen = this.events.get(eventId);
    if (seen) {
      return { replayed: true, order: this._orderView(this._require(this.orders, seen.orderId, "处置单")) };
    }
    const orderId = required(input.orderId, "处置单编号");
    const order = this._require(this.orders, orderId, "处置单");
    if (order.action === "none") throw conflict("无需处理的处置单不需要回执");
    if (order.receipt) throw conflict("处置单已回执");
    const kind = required(input.receiptKind, "回执类型");
    if (kind !== order.action) throw invalidRequest("回执类型与处置动作不符", { expected: order.action });

    const at = this.clock.now();
    const status = receiptStatus({ receiptedAt: at, deadline: order.deadline }, at);
    order.receipt = {
      eventId,
      kind,
      at,
      withinDeadline: status.withinDeadline,
      note: typeof input.note === "string" ? input.note : "",
    };
    this.orders.put(order);
    this.events.add({ recordId: eventId, eventId, kind: "receipt", orderId, at });

    const publication = this.publications.get(order.publicationId);
    if (publication) {
      if (kind === "annotate" && !publication.annotatedCorrectionIds.includes(order.correctionId)) {
        publication.annotatedCorrectionIds.push(order.correctionId);
      }
      if (kind === "retract") publication.status = "retracted";
      this.publications.put(publication);
    }
    return { replayed: false, order: this._orderView(order) };
  }

  /** 来源更正的影响范围报告：受影响主张、三类处置动作、渠道回执总览。 */
  correctionImpact(correctionId) {
    required(correctionId, "更正编号");
    const source = this.sources
      .list((item) => item.corrections.some((correction) => correction.correctionId === correctionId))
      .at(0);
    if (!source) throw notFound("更正不存在", { correctionId });
    const correction = source.corrections.find((item) => item.correctionId === correctionId);
    const restrictions = this.restrictions.list((item) => item.correctionId === correctionId);
    const orders = this.orders.list((item) => item.correctionId === correctionId);
    const now = this.clock.now();
    const grouped = { retract: [], annotate: [], none: [] };
    const channels = [];
    for (const order of orders) {
      grouped[order.action].push(order.orderId);
      let receipt;
      if (order.action === "none") {
        receipt = { status: "not_required", withinDeadline: null };
      } else if (order.receipt) {
        receipt = receiptStatus({ receiptedAt: order.receipt.at, deadline: order.deadline }, now);
      } else {
        receipt = { status: now > order.deadline ? "overdue" : "pending", withinDeadline: null };
      }
      channels.push({
        channel: order.channel,
        publicationId: order.publicationId,
        claimId: order.claimId,
        orderId: order.orderId,
        action: order.action,
        deadline: order.deadline,
        receiptState: receipt.status,
        withinDeadline: receipt.withinDeadline,
      });
    }
    const actionable = orders.filter((item) => item.action !== "none");
    return {
      correctionId,
      sourceId: source.sourceId,
      correction,
      affectedClaimIds: [...new Set(restrictions.map((item) => item.claimId))],
      restrictions: restrictions.map((item) => item.restrictionId),
      disposition: {
        retract: grouped.retract,
        annotate: grouped.annotate,
        noAction: grouped.none,
      },
      receiptSummary: {
        expected: actionable.length,
        receipted: actionable.filter((item) => item.receipt).length,
        overdue: channels.filter((item) => item.receiptState === "overdue").length,
        pending: channels.filter((item) => item.receiptState === "pending").length,
        allReceiptedInTime:
          actionable.length > 0 && actionable.every((item) => item.receipt?.withinDeadline === true),
      },
      channels,
    };
  }

  explainPublication(publicationId) {
    const publication = this._require(this.publications, publicationId, "发布物");
    const orders = this.orders
      .list((item) => item.publicationId === publicationId)
      .map((order) => this._orderView(order));
    return {
      publication,
      orders,
      allCleared: orders.every((order) => order.action === "none" || order.receiptState === "receipted"),
    };
  }

  // ──────────────────────────────── 内部方法 ────────────────────────────────

  _require(store, id, label) {
    const record = store.get(String(id));
    if (!record) throw notFound(`${label}不存在`, { id: String(id) });
    return record;
  }

  _claimKey(claimId) {
    return `claim:${claimId}`;
  }

  async _withClaimLocks(claimIds, fn) {
    const [first, ...rest] = claimIds;
    if (first === undefined) return fn();
    return this.locks.withLock(this._claimKey(first), () => this._withClaimLocks(rest, fn));
  }

  _normalizeScope(scope) {
    if (!scope || typeof scope !== "object") throw invalidRequest("地域适用范围缺失");
    if (scope.kind === "general") return { kind: "general", regions: [] };
    if (scope.kind === "region") {
      if (!Array.isArray(scope.regions) || scope.regions.length === 0) {
        throw invalidRequest("地域型范围必须列出地域");
      }
      return { kind: "region", regions: [...scope.regions] };
    }
    throw invalidRequest("范围类型不合法");
  }

  /** 把证据明细与开放分歧组装后交给纯策略评估。 */
  _evaluate(claim) {
    const evidence = claim.evidence.map((item) => {
      const source = this.sources.get(item.sourceId);
      return {
        sourceId: item.sourceId,
        type: source?.kind,
        originKey: source?.originKey,
        licenseStatus: source?.license.status,
        regionScope: source?.regionScope ?? [],
      };
    });
    const disagreements = this.disagreements.list(
      (item) => item.claimId === claim.claimId && item.status === "open",
    );
    const result = evaluateClaim(claim, { evidence, disagreements });
    return result;
  }

  _snapshot(claim, createdBy) {
    claim.revision += 1;
    this.claims.put(claim);
    const version = {
      recordId: `ver-${claim.claimId}-${claim.revision}`,
      versionId: `ver-${claim.claimId}-${claim.revision}`,
      claimId: claim.claimId,
      revision: claim.revision,
      status: claim.status,
      statement: claim.statement,
      scope: structuredClone(claim.scope),
      createdBy,
      at: this.clock.now(),
    };
    this.versions.add(version);
    return version;
  }

  _activeRestrictions(claimId) {
    return this.restrictions.list((item) => item.claimId === claimId && item.active);
  }

  /** 来源更正在主张上生效：施加限制、留版本、为存量发布物开处置单。 */
  _applyRestriction(claim, { correctionId, sourceId, type, regions, decidedBy, note }) {
    const restrictionType = restrictionForCorrection(type);
    const restrictionId = `rst-${correctionId}-${claim.claimId}`;
    if (this.restrictions.has(restrictionId)) return; // 同一更正对同一主张只生效一次

    const now = this.clock.now();
    const restriction = {
      recordId: restrictionId,
      restrictionId,
      claimId: claim.claimId,
      correctionId,
      sourceId,
      type: restrictionType,
      regions: Array.isArray(regions) ? [...regions] : [],
      reason: note,
      decidedBy,
      effectiveAt: now,
      active: true,
    };
    this.restrictions.add(restriction);

    claim.status = type === "withdraw" ? "retracted" : "restricted";
    this._snapshot(claim, decidedBy);

    // 已发布的下游物：按片段口径分级，同一发布物取最强动作。
    const publications = this.publications.list((item) =>
      item.clips.some((clip) => clip.claimId === claim.claimId),
    );
    for (const publication of publications) {
      const orderId = `ord-${correctionId}-${claim.claimId}-${publication.publicationId}`;
      if (this.orders.has(orderId)) continue;
      const relevantClips = publication.clips.filter((clip) => clip.claimId === claim.claimId);
      let action = "none";
      for (const clip of relevantClips) {
        const graded = gradeAction(
          { type: restrictionType, regions: restriction.regions, correctionId },
          { scope: clip.scope, annotatedCorrectionIds: publication.annotatedCorrectionIds },
        );
        if (graded === "retract") action = "retract";
        else if (graded === "annotate" && action !== "retract") action = "annotate";
      }
      const deadline =
        action === "none" ? null : addHours(now, this.deadlines[action] ?? this.deadlines.annotate);
      const order = {
        recordId: orderId,
        orderId,
        correctionId,
        sourceId,
        claimId: claim.claimId,
        restrictionId,
        publicationId: publication.publicationId,
        channel: publication.channel,
        clipIds: relevantClips.map((clip) => clip.clipId),
        action,
        decidedBy,
        reason: note,
        createdAt: now,
        deadline,
        receipt: null,
      };
      this.orders.add(order);
    }
  }

  /**
   * 新剪辑/新发布是否撞在已生效限制上。
   * retract：主张撤回，禁止任何新公开；
   * scope_note：只允许限定在适用地域内的地域型片段；
   * annotation：片段须声明已吸收本次更正的说法。
   */
  _gateScope(claim, scope, incorporatesCorrections = []) {
    const incorporated = new Set(incorporatesCorrections);
    for (const restriction of this._activeRestrictions(claim.claimId)) {
      if (restriction.type === "retract") {
        throw restrictionActive("主张已被撤回，不得剪辑或发布新片段", {
          restrictionId: restriction.restrictionId,
        });
      }
      if (restriction.type === "scope_note") {
        const allowed = new Set(restriction.regions);
        if (scope.kind === "general" || scope.regions.some((region) => !allowed.has(region))) {
          throw restrictionActive("来源已被证明仅适用于特定地域，通说性表述不得继续使用", {
            restrictionId: restriction.restrictionId,
            allowedRegions: restriction.regions,
          });
        }
      }
      if (restriction.type === "annotation" && !incorporated.has(restriction.correctionId)) {
        throw restrictionActive("该片段须吸收来源更正后才能剪辑或发布", {
          restrictionId: restriction.restrictionId,
          correctionId: restriction.correctionId,
        });
      }
    }
  }

  _orderView(order) {
    const now = this.clock.now();
    if (order.action === "none") {
      return { ...structuredClone(order), receiptState: "not_required" };
    }
    if (order.receipt) {
      return { ...structuredClone(order), receiptState: "receipted" };
    }
    return { ...structuredClone(order), receiptState: now > order.deadline ? "overdue" : "pending" };
  }

  _decisionTrail(claimId) {
    const trail = [];
    for (const version of this.versions.list((item) => item.claimId === claimId)) {
      trail.push({ type: `claim:${version.status}`, revision: version.revision, by: version.createdBy, at: version.at });
    }
    for (const restriction of this.restrictions.list((item) => item.claimId === claimId)) {
      trail.push({
        type: "correction",
        correctionId: restriction.correctionId,
        by: restriction.decidedBy,
        at: restriction.effectiveAt,
      });
    }
    return trail.sort((a, b) => (a.at < b.at ? -1 : 1));
  }
}
