/** 从标准输入接收 JSON 请求。 */
import { handle } from "./api.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
console.log(await handle(raw.trim() || '{"action":"health"}'));
