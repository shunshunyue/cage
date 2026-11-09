/**
 * 将模型零碎文本合并为有序、可等待的持久事件提交。
 * 运行时传入带租约检查的 emit；首段尽快提交，后续短片段合并 40 毫秒，完成和取消时分别冲刷或丢弃尾段，避免迟到文本越过运行终态。
 */
/** 首段立即提交，后续最多合并 40ms；持久化不再阻塞每一个模型 token。 */
/**
 * 有序文本批处理器，串行等待 emit 并记住首次提交失败。
 * 普通 token 不逐个阻塞数据库往返，累计到 2048 字符时主动施加背压；不负责网络重试或重建已经丢弃的文本。
 */
export class TextStream {
  /**
   * 尚未交给 emit 的文本缓冲，按字符长度触发批次阈值。
   */
  private pending = '';
  /**
   * 短片段合并定时器；冲刷、完成或销毁时清理。
   */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 已排队提交的串行尾 Promise，保证事件顺序。
   */
  private tail: Promise<void> = Promise.resolve();
  /**
   * 最近捕获的提交失败；后续 push/finish 重新抛出。
   */
  private failure: unknown;
  /**
   * 是否曾提交过非空批次，确保首段不等待定时器。
   */
  private started = false;
  /**
   * 是否已完成或销毁，阻止继续追加。
   */
  private closed = false;
  /**
   * 绑定异步提交回调和运行取消信号；回调负责实际持久化与租约验证，本类不创建事务。
   */
  constructor(private readonly emit: (text: string) => Promise<void>, private readonly signal: AbortSignal) {}

  /**
   * 追加文本；先检查取消及此前提交失败，再按首段、2048 字符阈值或 40 毫秒定时器触发冲刷。
   * 关闭后及空文本不再入队；长片段等待提交形成背压，短片段可能先返回。
   */
  async push(text: string): Promise<void> {
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.closed || !text) return;
    this.pending += text;
    // 长片段施加背压，普通 token 则留给短定时器合并，避免数据库往返降低生成速度。
    if (!this.started || this.pending.length >= 2048) return this.flush();
    this.timer ??= setTimeout(() => { void this.flush().catch(() => {}); }, 40);
  }
  /**
   * 取走当前缓冲并链接到同一提交 Promise，确保各批次顺序不交错。
   * 清理定时器，捕获异步失败供本次和后续调用重新抛出，失败后不继续发送排队文本。
   */
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
  /**
   * 关闭输入并等待尾段提交；调用方必须在此成功后发布模型完成事件，否则界面可能先看到完成再收到文字。
   */
  async finish(): Promise<void> { this.closed = true; await this.flush(); }
  /** 失败/取消后丢弃未提交的尾段，等待已开始的事务退出，杜绝迟到文本。 */
  /**
   * 取消/失败时丢弃尚未提交的尾段并清理定时器，等待已开始的提交退出。
   * 不会撤销已提交数据库事件；关闭后 push 不再接收新文字。
   */
  async dispose(): Promise<void> {
    this.closed = true; this.pending = ''; clearTimeout(this.timer); this.timer = undefined;
    await this.tail;
  }
}
