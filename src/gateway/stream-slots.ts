/**
 * 运行事件流的数量上限：`GET /v1/runs/:id/events`、`GET /v1/runs/:id/wait`、
 * `GET /v1/responses/:id?stream=true` 与兼容入口的流式请求，每条都持有一个运行监听器、一个授权
 * 监听器和一个心跳定时器。按调用方（密钥）与 owner 各计一份，超限时 429 `too_many_streams`。
 *
 * 数值与目录订阅（`catalog_capacity`，每个 owner 64）同一量级：每个调用方 64 条，每个 owner 256 条，
 * 远低于 `authorization` 监听器的 MaxListeners（1000），也够一个控制台加一批并行客户端用。
 */
import type { Principal } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import { Fault } from '../core/util.js';

export type StreamSlotLimits = { perSubject: number; perOwner: number };

export class StreamSlots {
  private readonly bySubject = new Map<string, number>();
  private readonly byOwner = new Map<string, number>();
  constructor(public limits: StreamSlotLimits = { perSubject: 64, perOwner: 256 }) {}
  private static subject(p: Principal): string {
    return p.keyId ?? `${p.owner}\n${p.name}`;
  }
  /** 占一个名额；返回只生效一次的释放函数。 */
  acquire(p: Principal): () => void {
    const subject = StreamSlots.subject(p);
    const mine = this.bySubject.get(subject) ?? 0;
    const owner = this.byOwner.get(p.owner) ?? 0;
    if (mine >= this.limits.perSubject)
      throw new Fault(
        'too_many_streams',
        `A caller may hold at most ${this.limits.perSubject} open run event streams; close unused streams and retry.`,
        429,
      );
    if (owner >= this.limits.perOwner)
      throw new Fault(
        'too_many_streams',
        `An owner may hold at most ${this.limits.perOwner} open run event streams; close unused streams and retry.`,
        429,
      );
    this.bySubject.set(subject, mine + 1);
    this.byOwner.set(p.owner, owner + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      decrement(this.bySubject, subject);
      decrement(this.byOwner, p.owner);
    };
  }
  count(p: Principal): { subject: number; owner: number } {
    return {
      subject: this.bySubject.get(StreamSlots.subject(p)) ?? 0,
      owner: this.byOwner.get(p.owner) ?? 0,
    };
  }
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

const registry = new WeakMap<Store, StreamSlots>();
/** 每个网关（以它的 Store 为准）一份计数。 */
export function streamSlots(store: Store): StreamSlots {
  let slots = registry.get(store);
  if (!slots) {
    slots = new StreamSlots();
    registry.set(store, slots);
  }
  return slots;
}
