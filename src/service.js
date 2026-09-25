/** 传统技艺内容依据管理的最小应用服务。 */
import { Clock } from "./clock.js";
import { Store } from "./store.js";

export class Service {
  constructor({ store = new Store(), clock = new Clock() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  health() {
    return { service: "craft_claims", status: "ok" };
  }

  register(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.clock.now() };
    this.store.add(record);
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get(recordId);
  }
}
