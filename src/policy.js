/**
 * 纯领域策略：不碰存储、不碰时钟（now 由参数传入），
 * 所有判断都可以脱离服务单独验证。
 *
 * 设计原则：
 * - 证据不足的主张不具备公开发布资格，只能进入内部草稿。
 * - 互相矛盾的来源永远作为「分歧」保留，策略不会自动选边。
 * - 地域适用性以依据覆盖范围为准，主张不得超出依据覆盖地。
 */

export const BASIS_KINDS = new Set([
  "ancient_text", // 古籍摘录
  "documentary", // 官方纪录片
  "bearer_testimony", // 传承人口述
  "trial", // 反复试做记录
]);

const UNIVERSE = "*";

function regionsOf(evidence) {
  const regions = evidence.applicableRegions;
  if (!regions || regions.length === 0) return [UNIVERSE];
  return regions;
}

function isUniversal(regions) {
  return regions.includes(UNIVERSE);
}

/** 许可此刻是否覆盖指定来源版本的公开使用。 */
export function licenseCoversPublic(license, now) {
  if (!license || license.scope !== "public") return false;
  const at = Date.parse(now);
  if (license.validFrom && Date.parse(license.validFrom) > at) return false;
  if (license.validUntil && Date.parse(license.validUntil) < at) return false;
  return true;
}

/**
 * 评估一条主张是否具备公开发布资格。
 *
 * @param {object} args
 * @param {object} args.claim 主张（含 regions）
 * @param {Array}  args.evidence 已关联的依据片段
 * @param {Function} args.licenseFor 取 (sourceVersionId) => 许可
 * @param {Function} args.trialFor 取 (trialId) => 试做记录
 * @param {Function} args.isConfirmedByBearer (evidenceId, claimId) => bool
 * @param {Array} args.resolvedConflicts 已由编辑裁定的矛盾 [{evidenceId, decision, qualification}]
 * @param {string} args.now 当前时间
 * @returns {{eligible:boolean, violations:Array, conflicts:Array, basis:Array}}
 */
export function evaluateClaim({
  claim,
  evidence,
  licenseFor,
  trialFor,
  isConfirmedByBearer,
  resolvedConflicts = [],
  now,
}) {
  const violations = [];
  const conflicts = [];
  const basis = [];
  const resolutionByEvidence = new Map(resolvedConflicts.map((r) => [r.evidenceId, r]));

  const supporting = evidence.filter((e) => e.supports === "supports");
  const contradicting = evidence.filter((e) => e.supports === "contradicts");

  if (supporting.length === 0) {
    violations.push({ code: "INSUFFICIENT_EVIDENCE", message: "没有任何支持性依据" });
  }

  for (const e of supporting) {
    if (!BASIS_KINDS.has(e.kind)) {
      violations.push({ code: "UNRECOGNIZED_BASIS", evidenceId: e.evidenceId, message: "依据类型不可作为复原基础" });
      continue;
    }

    if (e.kind === "trial") {
      const trial = e.trialId ? trialFor(e.trialId) : null;
      if (!trial || trial.outcome !== "success") {
        violations.push({ code: "TRIAL_NOT_SUCCESSFUL", evidenceId: e.evidenceId, message: "引用的试做未成功或无记录" });
      }
    }

    if (e.sourceVersionId) {
      const license = licenseFor(e.sourceVersionId);
      if (!licenseCoversPublic(license, now)) {
        violations.push({
          code: "NO_PUBLIC_LICENSE",
          evidenceId: e.evidenceId,
          sourceVersionId: e.sourceVersionId,
          message: "来源版本缺少有效的公开使用许可",
        });
      }
    }

    if (e.kind === "bearer_testimony" && !isConfirmedByBearer(e.evidenceId, claim.claimId)) {
      violations.push({ code: "BEARER_NOT_CONFIRMED", evidenceId: e.evidenceId, message: "口述依据未经传承人确认" });
    }

    basis.push({
      evidenceId: e.evidenceId,
      kind: e.kind,
      sourceVersionId: e.sourceVersionId ?? null,
      regions: regionsOf(e),
    });
  }

  // 地域过度概括：主张声称的每个地域都必须被至少一条支持性依据覆盖。
  const claimRegions = claim.regions && claim.regions.length > 0 ? claim.regions : [UNIVERSE];
  const covered = new Set();
  let universalEvidence = false;
  for (const e of supporting) {
    const regions = regionsOf(e);
    if (isUniversal(regions)) {
      universalEvidence = true;
      break;
    }
    for (const r of regions) covered.add(r);
  }
  if (isUniversal(claimRegions)) {
    // 主张普遍适用，却只有局部地域依据，本身就是过度概括。
    if (!universalEvidence) {
      violations.push({
        code: "REGION_OVERREACH",
        uncoveredRegions: [UNIVERSE],
        message: "依据仅适用于特定地域，不足以支持普遍适用的主张",
      });
    }
  } else if (!universalEvidence) {
    const uncovered = claimRegions.filter((r) => !covered.has(r));
    if (uncovered.length > 0) {
      violations.push({
        code: "REGION_OVERREACH",
        uncoveredRegions: uncovered,
        message: `主张超出依据适用地域：${uncovered.join("、")}`,
      });
    }
  }

  // 矛盾保留：任何相反依据都作为分歧记录保留，系统不自动选边。
  // 已由编辑裁定（qualify / exclude_note）的分歧不再阻断发布，但仍随溯源返回；
  // 未裁定或被搁置（defer）的分歧继续阻断公开发布。
  for (const e of contradicting) {
    const license = e.sourceVersionId ? licenseFor(e.sourceVersionId) : null;
    const resolution = resolutionByEvidence.get(e.evidenceId);
    conflicts.push({
      evidenceId: e.evidenceId,
      kind: e.kind,
      sourceVersionId: e.sourceVersionId ?? null,
      note: e.note ?? "",
      publiclyLicensed: licenseCoversPublic(license, now),
      resolution: resolution ? resolution.decision : "unresolved",
      resolvedBy: resolution?.editorId ?? null,
      qualification: resolution?.qualification ?? null,
    });
    if (!resolution || resolution.decision === "defer") {
      violations.push({
        code: "CONFLICTING_SOURCES",
        evidenceId: e.evidenceId,
        message: "存在互相矛盾的来源，须由编辑决定如何处置，系统不得自动选边",
      });
    }
  }

  return {
    eligible: violations.length === 0,
    violations,
    conflicts,
    basis,
    evaluatedAt: now,
  };
}

/**
 * 来源更正后，对一条已公开发布的主张给出处置分级。
 * - withdraw：发布物中的表述失去支撑，必须撤回。
 * - annotate：表述在限定范围内仍成立，须追加说明。
 * - none：未公开发布或不受影响。
 *
 * @param {object} args
 * @param {string} args.correctionType retract | qualify | erratum
 * @param {boolean} args.wasPublic 更正前是否已公开
 * @param {object} args.before 更正前评估结果
 * @param {object} args.after 更正后评估结果
 */
export function classifyCorrectionImpact({ correctionType, wasPublic, before, after }) {
  if (!wasPublic) return { severity: "none", reason: "仅存在于内部草稿，无需下游处置" };
  if (correctionType === "retract") {
    return after.eligible
      ? { severity: "annotate", reason: "原有依据被撤回，但仍有其它有效依据，须追加说明" }
      : { severity: "withdraw", reason: "支持性依据被撤回且无替代依据，公开表述不再成立" };
  }
  if (correctionType === "qualify") {
    const overreach = after.violations.some((v) => v.code === "REGION_OVERREACH");
    if (!after.eligible && !overreach) {
      return { severity: "withdraw", reason: "限定适用范围后主张失去支撑" };
    }
    return {
      severity: "annotate",
      reason: overreach ? "依据被证明仅适用于特定地域，须追加地域限定说明" : "适用范围被收窄，须追加说明",
    };
  }
  if (correctionType === "erratum") {
    return { severity: "annotate", reason: "来源发布更正，须向下游追加说明" };
  }
  return { severity: "none", reason: "更正类型不影响公开表述" };
}

/** 片段在提交剪辑时是否受已生效限制约束。 */
export function restrictionGate(restrictions, now, intendedTarget) {
  const active = restrictions.filter((r) => r.status === "active" && Date.parse(r.effectiveAt) <= Date.parse(now));
  const block = active.find((r) => r.type === "block");
  if (block && intendedTarget === "public") {
    return { allowed: false, code: "SNIPPET_BLOCKED", restrictionId: block.restrictionId, reason: block.reason };
  }
  const annotation = active.find((r) => r.type === "annotation_required");
  return {
    allowed: true,
    requiresAnnotation: Boolean(annotation) && intendedTarget === "public",
    restrictionId: annotation ? annotation.restrictionId : null,
  };
}
