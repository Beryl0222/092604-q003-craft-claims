/** 处理进程内 JSON 请求。 */
import { Service } from "./service.js";

export function handle(raw, service = new Service()) {
  const body = JSON.parse(raw);
  let result;
  if (body.action === "health") result = service.health();
  else if (body.action === "register") result = service.register(String(body.recordId), String(body.ownerId));
  else if (body.action === "find") result = service.find(String(body.recordId));
  else throw new Error("不支持的请求动作");
  return JSON.stringify(result);
}
