/** 提供可替换的业务时钟。 */
export class Clock {
  now() {
    return new Date().toISOString();
  }
}
