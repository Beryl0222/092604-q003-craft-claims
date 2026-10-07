/**
 * 进程内存储。按集合保存登记对象，所有读写都经过结构化克隆，
 * 避免调用方持有的引用在存储外被修改。
 *
 * 集合（键前缀）：
 * - records   基础登记（保留既有行为）
 * - sources   来源
 * - sourceVersions 来源版本（只追加）
 * - licenses  使用许可
 * - evidence  依据片段
 * - trials    反复试做记录
 * - claims    可核查主张及其版本谱系
 * - confirmations 传承人对口述依据-主张的确认
 * - reviews   编辑复核决定
 * - releases  发布版本（公开版本/内部草稿）
 * - snippets  成片片段
 * - checkouts 剪辑工作副本（并行剪辑）
 * - usages    片段在发布物中的使用
 * - channels  下游发布渠道
 * - corrections 来源更正
 * - impactAnalyses 更正影响面分析
 * - restrictions 已生效的片段限制
 * - tickets   处置单（撤回 / 追加说明，内含渠道回执事件）
 * - callbacks 合作方发布回调（幂等键）
 */
export class Store {
  static COLLECTIONS = [
    "records",
    "sources",
    "sourceVersions",
    "licenses",
    "evidence",
    "trials",
    "claims",
    "confirmations",
    "reviews",
    "releases",
    "snippets",
    "checkouts",
    "usages",
    "channels",
    "corrections",
    "impactAnalyses",
    "restrictions",
    "tickets",
    "callbacks",
  ];

  constructor() {
    this.tables = new Map();
    for (const name of Store.COLLECTIONS) this.tables.set(name, new Map());
    // 兼容既有脚手架里的 records 直接访问。
    this.records = this.tables.get("records");
  }

  _table(name) {
    const table = this.tables.get(name);
    if (!table) throw new Error(`未知存储集合：${name}`);
    return table;
  }

  add(collection, id, value) {
    // 兼容旧签名 add(record)。
    if (value === undefined) {
      value = collection;
      collection = "records";
      id = value.recordId;
    }
    const table = this._table(collection);
    if (table.has(id)) throw new Error("记录编号已存在");
    table.set(id, structuredClone(value));
  }

  put(collection, id, value) {
    this._table(collection).set(id, structuredClone(value));
  }

  get(collection, id) {
    // 兼容旧签名 get(recordId)。
    if (id === undefined) {
      id = collection;
      collection = "records";
    }
    const value = this._table(collection).get(id);
    return value ? structuredClone(value) : null;
  }

  has(collection, id) {
    return this._table(collection).has(id);
  }

  update(collection, id, mutator) {
    const table = this._table(collection);
    const current = table.get(id);
    if (!current) throw new Error("记录不存在");
    const next = mutator(structuredClone(current));
    table.set(id, structuredClone(next));
    return structuredClone(next);
  }

  list(collection, predicate) {
    const values = [...this._table(collection).values()].map((v) => structuredClone(v));
    return predicate ? values.filter(predicate) : values;
  }
}
