/** 处理进程内 JSON 请求；动作白名单分派到 Service，领域错误结构化返回。 */
import { Service } from "./service.js";
import { DomainError } from "./errors.js";

/** 动作 -> 服务方法。异步方法（含加锁/回调）会被 await。 */
const ACTIONS = {
  health: (service) => service.health(),
  register: (service, body) => service.register(String(body.recordId), String(body.ownerId)),
  find: (service, body) => service.find(String(body.recordId)),

  registerSource: (service, body) => service.registerSource(body),
  correctSource: (service, body) => service.correctSource(body),

  registerClaim: (service, body) => service.registerClaim(body),
  attachEvidence: (service, body) => service.attachEvidence(body),
  confirmInheritor: (service, body) => service.confirmInheritor(body),
  recordTrial: (service, body) => service.recordTrial(body),
  setEditorialNote: (service, body) => service.setEditorialNote(body),
  carryDisagreement: (service, body) => service.carryDisagreement(body),
  reviseClaimScope: (service, body) => service.reviseClaimScope(body),
  publishClaim: (service, body) => service.publishClaim(body),
  explainClaim: (service, body) => service.explainClaim(String(body.claimId)),

  openDisagreement: (service, body) => service.openDisagreement(body),
  addPosition: (service, body) => service.addPosition(body),
  closeDisagreement: (service, body) => service.closeDisagreement(body),

  createClip: (service, body) => service.createClip(body),
  releasePublication: (service, body) => service.releasePublication(body),
  recordOrderReceipt: (service, body) => service.recordOrderReceipt(body),

  correctionImpact: (service, body) => service.correctionImpact(String(body.correctionId)),
  explainPublication: (service, body) => service.explainPublication(String(body.publicationId)),
};

/** 返回对象结果；领域错误抛出，供编程方按 error.code 分支处理。 */
export async function dispatch(raw, service = new Service()) {
  const body = JSON.parse(raw);
  const action = body?.action;
  const handler = ACTIONS[action];
  if (!handler) throw new DomainError("invalid_request", "不支持的请求动作", { action });
  return handler(service, body);
}

/** 文本入口：成功返回结果 JSON，失败返回错误 JSON（不抛出）。 */
export async function handle(raw, service = new Service()) {
  try {
    const result = await dispatch(raw, service);
    return JSON.stringify(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return JSON.stringify({ error: { code: error.code, message: error.message, ...error.extra } });
    }
    return JSON.stringify({ error: { code: "bad_request", message: error.message } });
  }
}
