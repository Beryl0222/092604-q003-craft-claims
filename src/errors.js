/** 领域错误：携带机器可读代码，接口层据此返回结构化错误。 */
export class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.extra = extra;
  }
}

/** 不合法的请求内容（编号缺失、枚举值错误等）。 */
export function invalidRequest(message, extra) {
  return new DomainError("invalid_request", message, extra);
}

/** 找不到目标对象。 */
export function notFound(message, extra) {
  return new DomainError("not_found", message, extra);
}

/** 当前对象状态不允许该操作（状态机冲突等）。 */
export function conflict(message, extra) {
  return new DomainError("conflict", message, extra);
}

/** 证据不足，主张只能停留在内部分草稿。 */
export function insufficientEvidence(message, extra) {
  return new DomainError("insufficient_evidence", message, extra);
}

/** 并行剪辑试图绕过已经生效的限制。 */
export function restrictionActive(message, extra) {
  return new DomainError("restriction_active", message, extra);
}
