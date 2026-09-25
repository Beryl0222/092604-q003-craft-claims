/** 保存基础登记记录。 */
export class Store {
  constructor() {
    this.records = new Map();
  }

  add(record) {
    if (this.records.has(record.recordId)) {
      throw new Error("记录编号已存在");
    }
    this.records.set(record.recordId, structuredClone(record));
  }

  get(recordId) {
    const value = this.records.get(recordId);
    return value ? structuredClone(value) : null;
  }
}
