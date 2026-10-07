/** 领域错误：携带稳定错误码，便于接口层返回错误信封。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
