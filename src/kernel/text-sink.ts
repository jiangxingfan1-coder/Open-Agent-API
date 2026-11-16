import type { Run } from '../core/contracts.js';
import { finishOutput, type EventInput } from '../store/output.js';
import type { Store } from '../store/store.js';
import { Fault, id } from '../core/util.js';
import { AGENT_LIMITS } from '../core/limits.js';

const OUTPUT_LIMIT = AGENT_LIMITS.outputTextChars;

/**
 * 一次运行的文本输出写入器。
 *
 * 负责三件事：第一次有文本时开出一条输出消息；把同一轮事件循环里到达的增量攒成一次
 * `recordOutput`（一个事务）落盘；收尾时给出结束这条消息的事件。事件条数、内容和顺序与逐条
 * 写入完全相同，存储层「先提交、后通知」的契约不变；合并只发生在本轮循环之内，由
 * `setImmediate` 或下一个需要一致状态的操作（非文本事件、收尾、检查点）触发。
 */
export class RunTextSink {
  private sink: { id: string; index: number } | undefined;
  private pending: string[] = [];
  private pendingChars = 0;
  private scheduled = false;
  private holding = false;

  constructor(
    private readonly store: Store,
    private readonly run: Run,
    /** 运行已被中止时不再接收新文本。 */
    private readonly aborted: () => boolean,
    /** 输出超限或落盘失败：由调用方记录错误并中止运行。 */
    private readonly fail: (fault: Fault) => void,
  ) {}

  /** 本轮是否已经开出输出消息（即已经有文本流出）。 */
  get open(): boolean {
    return this.sink !== undefined;
  }

  /**
   * Structured output: while held, text is not recorded at all. The answer is checked first and
   * written out in one piece once it fits (kernel/structured-output.ts).
   */
  hold(on: boolean): void {
    this.holding = on;
  }

  emit(delta: string): void {
    if (!delta || this.holding || this.aborted()) return;
    const written = this.run.output.reduce((n, m) => n + m.text.length, 0);
    if (written + this.pendingChars + delta.length > OUTPUT_LIMIT) {
      this.fail(new Fault('output_too_large', 'Agent output exceeds limit.', 413));
      return;
    }
    if (!this.sink) {
      const next = { id: id('msg'), index: this.run.output.length };
      this.store.recordOutput(this.run, [
        {
          type: 'response.output_item.added',
          data: {
            output_index: next.index,
            item: {
              id: next.id,
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          },
        },
        {
          type: 'response.content_part.added',
          data: {
            item_id: next.id,
            output_index: next.index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
          },
        },
      ]);
      this.sink = next;
    }
    this.pending.push(delta);
    this.pendingChars += delta.length;
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }

  /** 把攒下的增量落盘。`rethrow` 为真时把存储层的原始错误抛给调用方，否则按落盘失败处理。 */
  flush(rethrow = false): void {
    if (!this.pending.length || !this.sink) return;
    const deltas = this.pending;
    const target = this.sink;
    this.pending = [];
    this.pendingChars = 0;
    try {
      this.store.recordOutput(
        this.run,
        deltas.map((delta) => ({
          type: 'response.output_text.delta',
          data: {
            item_id: target.id,
            output_index: target.index,
            content_index: 0,
            delta,
            logprobs: [],
          },
        })),
      );
    } catch (error) {
      if (rethrow) throw error;
      this.fail(
        new Fault(
          'persistence_failed',
          'Output could not be persisted. Execution was stopped.',
          500,
        ),
      );
    }
  }

  /** 先落盘，再给出结束当前输出消息的事件；还没有输出时返回空数组。 */
  finish(status: 'completed' | 'incomplete'): EventInput[] {
    this.flush();
    return this.sink
      ? finishOutput(this.run.output[this.sink.index]!, this.sink.index, status)
      : [];
  }

  /** 当前输出消息已经随检查点结束；下一段文本会开出新的消息。 */
  close(): void {
    this.sink = undefined;
  }

  /** A resumed orchestration may already have committed its final delta before termination. */
  publishFinalOnce(text: string): EventInput[] {
    const index = this.run.output.length - 1;
    const previous = this.run.output[index];
    if (previous?.text === text)
      return previous.status === 'completed' ? [] : finishOutput(previous, index, 'completed');
    if (previous && !previous.text && previous.status !== 'completed')
      this.sink = { id: previous.id, index };
    this.hold(false);
    this.emit(text);
    return this.finish('completed');
  }
}
