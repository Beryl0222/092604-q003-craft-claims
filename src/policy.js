/**
 * 领域策略：证据充分性评估、来源更正后的影响分级、回执状态判定。
 *
 * 本模块只做纯计算，不接触存储与时钟，便于对每条规则单独测试。
 * 互相矛盾的来源在此不做"自动选边"——评估只指出尚未携带的分歧，
 * 如何保留分歧由编辑在发布决定中显式确认。
 */

/** 外部依据类型；团队自己的试做记录单列，不计入独立来源数。 */
export const SOURCE_TYPES = new Set(["classic_text", "documentary", "inheritor_testimony", "trial_record"]);

export const LICENSE = { GRANTED: "granted", DENIED: "denied", UNKNOWN: "unknown" };

/** 公开所需的最少独立（不同出处、已获许可）来源数。 */
export const MIN_INDEPENDENT_SOURCES = 2;

/**
 * 评估一条主张是否具备公开条件。
 *
 * @param {object} claim 主张（含 scope、inheritorConfirmation、trials、editorialNote）
 * @param {object} ctx
 * @param {Array}  ctx.evidence   该主张当前生效的依据明细：{sourceId, type, licenseStatus, regionScope}
 * @param {Array}  ctx.disagreements 涉及该主张且尚未关闭的分歧：{disagreementId, status}
 * @returns {{publishable: boolean, reasons: string[], independentSources: number, carriedDisagreements: string[]}}
 */
export function evaluateClaim(claim, ctx) {
  const reasons = [];
  const evidence = ctx.evidence ?? [];
  const disagreements = ctx.disagreements ?? [];

  // 规则 1：至少要有一条依据。
  if (evidence.length === 0) reasons.push("no_evidence");

  // 规则 2：至少两处相互独立（不同出处 originKey）、且使用许可明确为"已授权"的来源。
  // 同一出处的不同版本或转述（如官方纪录片与其切片）只算一处独立来源。
  const granted = evidence.filter((item) => item.licenseStatus === LICENSE.GRANTED);
  const independentSources = new Set(granted.map((item) => item.originKey ?? item.sourceId)).size;
  if (evidence.length > 0 && independentSources < MIN_INDEPENDENT_SOURCES) {
    reasons.push("insufficient_independent_sources");
  }

  // 规则 3：工序类主张必须有传承人确认（确认人、确认时间记录在主张上）。
  if (claim.kind === "process" && !claim.inheritorConfirmation) {
    reasons.push("inheritor_confirmation_missing");
  }

  // 规则 4：工序类主张必须有至少一次在记录条件下复现成功的试做。
  if (claim.kind === "process") {
    const reproduced = (claim.trials ?? []).some(
      (trial) => trial.result === "reproduced" && typeof trial.conditions === "string" && trial.conditions.trim() !== "",
    );
    if (!reproduced) reasons.push("reproduced_trial_missing");
  }

  // 规则 5：地域适用范围不得超出来源所能支撑的范围——禁止把地方性做法概括成通说。
  const scopedSources = granted.filter((item) => Array.isArray(item.regionScope) && item.regionScope.length > 0);
  if (claim.scope?.kind === "general") {
    if (scopedSources.length > 0) reasons.push("scope_overreach");
  } else if (claim.scope?.kind === "region") {
    const covered = new Set(scopedSources.flatMap((item) => item.regionScope));
    const claimed = claim.scope.regions ?? [];
    if (claimed.length === 0) reasons.push("scope_region_missing");
    else if (claimed.some((region) => !covered.has(region))) reasons.push("scope_not_supported");
  } else {
    reasons.push("scope_missing");
  }

  // 规则 6：仍然开放的分歧必须由编辑在发布决定中显式"携带"，不得静默选边。
  const open = disagreements.filter((item) => item.status === "open");
  const carried = new Set(claim.carriedDisagreements ?? []);
  const uncarried = open.filter((item) => !carried.has(item.disagreementId)).map((item) => item.disagreementId);
  if (uncarried.length > 0) reasons.push("unresolved_disagreement");

  // 规则 7：工序类主张公开须留下编辑取舍说明（为何采用其中一种说法、分歧如何呈现）。
  if (claim.kind === "process" && !(typeof claim.editorialNote === "string" && claim.editorialNote.trim() !== "")) {
    reasons.push("editorial_note_missing");
  }

  return {
    publishable: reasons.length === 0,
    reasons,
    independentSources,
    uncarriedDisagreements: uncarried,
  };
}

/**
 * 来源更正类型 -> 对主张施加的限制类型。
 * - withdraw（来源撤回/吊销许可）：依据撤空，主张不得继续公开。
 * - narrow_scope（来源被证明仅适用于特定地域）：限制主张的地域适用范围。
 * - correct_detail（来源细节更正）：不撤主张，但旧表述须追加更正说明。
 */
export function restrictionForCorrection(correctionType) {
  switch (correctionType) {
    case "withdraw":
      return "retract";
    case "narrow_scope":
      return "scope_note";
    case "correct_detail":
      return "annotation";
    default:
      return null;
  }
}

/**
 * 为一份已发布下游物分级处置动作：
 * - retract   需要撤回
 * - annotate  需要追加说明
 * - none      无需处理
 *
 * @param {object} restriction {type, regions?} 施加在主张上的限制
 * @param {object} publication {scope:{kind, regions?}, annotatedCorrectionIds: string[]}
 */
export function gradeAction(restriction, publication) {
  switch (restriction.type) {
    case "retract":
      return "retract";
    case "scope_note": {
      if (publication.scope?.kind === "region") {
        const allowed = new Set(restriction.regions ?? []);
        const regions = publication.scope.regions ?? [];
        // 本就限定在适用地域内：无需处理；落在适用地域外：该说法失去依据，撤回。
        if (regions.length > 0 && regions.every((region) => allowed.has(region))) return "none";
        return "retract";
      }
      // 通说性发布物不能撤回为地方性说法了事，须追加地域适用说明；
      // 已就本次更正追加过说明的不重复开单。
      const covered = new Set(publication.annotatedCorrectionIds ?? []);
      return covered.has(restriction.correctionId) ? "none" : "annotate";
    }
    case "annotation": {
      const covered = new Set(publication.annotatedCorrectionIds ?? []);
      return covered.has(restriction.correctionId) ? "none" : "annotate";
    }
    default:
      return "none";
  }
}

/**
 * 处置单回执状态：pending / receipted / overdue。
 * 期限内的判定同时返回，供解释接口向渠道负责人展示。
 */
export function receiptStatus(item, now) {
  if (item.receiptedAt) {
    return { status: "receipted", withinDeadline: item.receiptedAt <= item.deadline };
  }
  return { status: now > item.deadline ? "overdue" : "pending", withinDeadline: null };
}
