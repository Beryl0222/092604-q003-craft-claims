/**
 * 处理进程内 JSON 请求。
 *
 * 请求形如：{"action":"publishClaim","payload":{...}}
 * 成功直接返回业务结果 JSON；领域错误返回 {"error":{"code","message"}}。
 */
import { DomainError } from "./errors.js";
import { Service } from "./service.js";

// action → 服务方法。需要位置参数的动作单独处理。
const METHOD_BY_ACTION = {
  registerSource: "registerSource",
  addSourceVersion: "addSourceVersion",
  grantLicense: "grantLicense",
  revokeLicense: "revokeLicense",
  recordTrial: "recordTrial",
  addEvidence: "addEvidence",
  confirmByBearer: "confirmByBearer",
  proposeClaim: "proposeClaim",
  attachEvidence: "attachEvidence",
  detachEvidence: "detachEvidence",
  reevaluateClaim: "reevaluateClaim",
  resolveConflict: "resolveConflict",
  publishClaim: "publishClaim",
  registerSnippet: "registerSnippet",
  checkoutSnippet: "checkoutSnippet",
  commitSnippet: "commitSnippet",
  imposeRestriction: "imposeRestriction",
  registerChannel: "registerChannel",
  registerUsage: "registerUsage",
  recordCorrection: "recordCorrection",
  analyzeCorrectionImpact: "analyzeCorrectionImpact",
  issueTickets: "issueDispositionTickets",
  receiveCallback: "receivePublishCallback",
  acknowledgeTicket: "acknowledgeTicket",
  markOverdue: "markOverdueTickets",
  explainRelease: "explainRelease",
  correctionStatus: "correctionStatus",
};

export function handle(raw, service = new Service()) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return JSON.stringify({ error: { code: "BAD_JSON", message: "请求不是合法 JSON" } });
  }

  try {
    let result;
    if (body.action === "health") {
      result = service.health();
    } else if (body.action === "register") {
      result = service.register(String(body.recordId), String(body.ownerId));
    } else if (body.action === "find") {
      result = service.find(String(body.recordId));
    } else if (METHOD_BY_ACTION[body.action]) {
      const method = METHOD_BY_ACTION[body.action];
      result = service[method](body.payload ?? {});
    } else {
      throw new DomainError("UNSUPPORTED_ACTION", `不支持的请求动作：${body.action}`);
    }
    return JSON.stringify(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return JSON.stringify({ error: { code: error.code, message: error.message } });
    }
    return JSON.stringify({ error: { code: "INTERNAL_ERROR", message: error.message } });
  }
}
