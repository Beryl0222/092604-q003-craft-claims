import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../src/api.js";
import { Service } from "../src/service.js";

test("健康检查返回正常状态", () => {
  const result = JSON.parse(handle('{"action":"health"}'));
  assert.equal(result.status, "ok");
});

test("登记后可以按编号查询", () => {
  const service = new Service();
  const created = service.register("r-1", "owner-1");
  assert.equal(created.state, "draft");
  assert.equal(service.find("r-1").ownerId, "owner-1");
});
