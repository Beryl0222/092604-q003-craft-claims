/**
 * 进程内实体存储。
 *
 * 按编号保存记录，读写成对做深拷贝，避免调用方绕过服务直接改写已存对象。
 * 服务为每类实体持有独立的 Store 实例。
 */
export class Store {
  constructor() {
    this.records = new Map();
  }

  /** 新增；编号重复时拒绝，防止覆盖既有事实。 */
  add(record) {
    if (this.records.has(record.recordId)) {
      throw new Error("记录编号已存在");
    }
    this.records.set(record.recordId, structuredClone(record));
  }

  /** 写入或整体替换。 */
  put(record) {
    this.records.set(record.recordId, structuredClone(record));
  }

  get(recordId) {
    const value = this.records.get(recordId);
    return value ? structuredClone(value) : null;
  }

  has(recordId) {
    return this.records.has(recordId);
  }

  /** 返回全部记录的副本；可传入谓词筛选。 */
  list(predicate = () => true) {
    return [...this.records.values()].filter(predicate).map((record) => structuredClone(record));
  }

  remove(recordId) {
    return this.records.delete(recordId);
  }
}
