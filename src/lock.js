/**
 * 按键串行化的互斥队列。
 *
 * 同一个片段（或任意键）上的并行剪辑、限制生效等操作经此排队执行，
 * 后到者一定能看到先到者已经提交的状态，避免两个编辑同时绕过限制。
 * 未被占用的键直接执行；最后一个持有者离开后清理登记项。
 */
export class KeyLock {
  constructor() {
    this.queues = new Map();
  }

  /** 在 key 的临界区内执行 fn；同一 key 的其他调用按序等待。 */
  async withLock(key, fn) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // 本回合在队列中的占位：前一回合的门打开、且本回合释放后才放行后继者。
    const turn = previous.then(() => gate);
    this.queues.set(key, turn);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // 若没有更新的等待者替换登记项，则回收该键。
      if (this.queues.get(key) === turn) this.queues.delete(key);
    }
  }
}
