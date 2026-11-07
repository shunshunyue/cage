/** 首段立即提交，后续最多合并 40ms；持久化不再阻塞每一个模型 token。 */
export class TextStream {
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private started = false;
  private closed = false;
  constructor(private readonly emit: (text: string) => Promise<void>, private readonly signal: AbortSignal) {}

  async push(text: string): Promise<void> {
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.closed || !text) return;
    this.pending += text;
    // 长片段施加背压，普通 token 则留给短定时器合并，避免数据库往返降低生成速度。
    if (!this.started || this.pending.length >= 2048) return this.flush();
    this.timer ??= setTimeout(() => { void this.flush().catch(() => {}); }, 40);
  }
  private flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const text = this.pending; this.pending = '';
    if (text) {
      this.started = true;
      this.tail = this.tail.then(async () => {
        if (this.failure) return;
        this.signal.throwIfAborted();
        await this.emit(text);
      }).catch(error => { this.failure = error; });
    }
    return this.tail.then(() => { if (this.failure) throw this.failure; });
  }
  /** 完成事件必须排在最后一段文字提交之后。 */
  async finish(): Promise<void> { this.closed = true; await this.flush(); }
  /** 失败/取消后丢弃未提交的尾段，等待已开始的事务退出，杜绝迟到文本。 */
  async dispose(): Promise<void> {
    this.closed = true; this.pending = ''; clearTimeout(this.timer); this.timer = undefined;
    await this.tail;
  }
}
