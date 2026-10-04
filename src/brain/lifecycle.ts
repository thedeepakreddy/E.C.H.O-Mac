import type {Brain, BrainEventMap} from './types.js';
import type {Provider} from './index.js';
import {PROVIDER_LABELS} from './switching.js';
import {shutdownStep} from '../shutdown.js';

export interface BrainInstance {brain: Brain; provider: Provider}
export type BrainHandlers = {[Event in keyof BrainEventMap]?: (...args: BrainEventMap[Event]) => void};
export interface SwitchResult {ok: boolean; provider: Provider; message: string}
interface Session extends BrainInstance {unsubscribe: () => void}
interface LifecycleOptions {
  create: (provider: Provider) => BrainInstance;
  unavailable: (provider: Provider) => string | null;
  handlers: () => BrainHandlers;
  activated: (instance: BrainInstance) => void;
  beforeReplace?: () => void;
  report?: (message: string) => void;
  stopTimeoutMs?: number;
}

/** Owns replacement, subscriptions and disposal for the foreground brain. */
export class BrainLifecycle {
  private active: Session | null = null;
  private pending: {target: Provider; restart: boolean; result: Promise<SwitchResult>} | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly disposals = new WeakMap<Brain, Promise<void>>();
  private lastProvider: Provider;

  constructor(initial: BrainInstance, private readonly options: LifecycleOptions) {
    this.lastProvider = initial.provider;
    this.activate(this.prepare(initial));
  }

  get provider(): Provider {return this.active?.provider ?? this.lastProvider;}
  get isSwitching(): boolean {return this.pending !== null;}

  switch(target: Provider, restart = false): Promise<SwitchResult> {
    if (this.closing) return Promise.resolve(this.result(false, 'Echo is shutting down.'));
    if (this.pending) {
      return this.pending.target === target && this.pending.restart === restart ? this.pending.result
        : Promise.resolve(this.result(false, 'A model switch is already in progress.'));
    }
    if (target === this.provider && !restart) return Promise.resolve(this.result(true, `Already running on ${PROVIDER_LABELS[target]}.`));
    // Assign pending before construction/activation hooks can re-enter.
    const result = Promise.resolve().then(() => this.replace(target)).finally(() => {this.pending = null;});
    this.pending = {target, restart, result};
    return result;
  }

  async ready(): Promise<boolean> {
    await this.pending?.result;
    return !this.closing && this.active !== null;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const active = this.active;
    this.active = null;
    this.closePromise = Promise.all([active ? this.dispose(active) : Promise.resolve(), this.pending?.result]).then(() => {});
    return this.closePromise;
  }

  private result(ok: boolean, message: string): SwitchResult {return {ok, provider: this.provider, message};}

  private prepare(instance: BrainInstance): Session {
    const handlers: BrainHandlers = {...this.options.handlers()};
    handlers.error ??= message => this.report(`Brain error: ${message}`);
    const session: Session = {...instance, unsubscribe: () => {}};
    const subscriptions: Array<() => void> = [];
    for (const event of Object.keys(handlers) as (keyof BrainEventMap)[]) {
      const handler = handlers[event] as (...args: unknown[]) => void;
      if (!handler) continue;
      const guarded = (...args: unknown[]) => {
        if (!this.closing && this.active === session) handler(...args);
      };
      instance.brain.on(event, guarded);
      subscriptions.push(() => instance.brain.off(event, guarded));
    }
    session.unsubscribe = () => subscriptions.forEach(unsubscribe => unsubscribe());
    return session;
  }

  private activate(session: Session): void {
    this.active = session;
    this.lastProvider = session.provider;
    // UI and persistence callbacks must not undo a successfully installed brain.
    try {this.options.activated(session);}
    catch (error) {this.report(`Brain activation notification failed: ${String(error)}`);}
  }

  private report(message: string): void {
    try {this.options.report?.(message);} catch { /* Disposal must still complete. */ }
  }

  private async replace(target: Provider): Promise<SwitchResult> {
    if (this.closing) return this.result(false, 'Echo is shutting down.');
    let candidate: BrainInstance | undefined;
    let next: Session | undefined;
    try {
      const blocked = this.options.unavailable(target);
      if (blocked) return this.result(false, `I can't switch to ${PROVIDER_LABELS[target]} — ${blocked}.`);
      // Construction failure must leave the current brain and its listeners usable.
      candidate = this.options.create(target);
      if (candidate.brain === this.active?.brain) throw new Error('Brain factory reused the active instance');
      next = this.prepare(candidate);
      this.options.beforeReplace?.();
    } catch (error) {
      if (candidate && candidate.brain !== this.active?.brain) await this.dispose(next ?? {...candidate, unsubscribe: () => {}});
      return this.result(false, `Could not start ${PROVIDER_LABELS[target]}: ${String(error instanceof Error ? error.message : error)}`);
    }
    const previous = this.active;
    this.active = null;
    if (previous) await this.dispose(previous);
    if (this.closing) {
      await this.dispose(next);
      return this.result(false, 'Echo is shutting down.');
    }
    this.activate(next);
    return this.result(true, candidate.provider === target ? `Now running on ${PROVIDER_LABELS[target]}.`
      : `I couldn't start ${PROVIDER_LABELS[target]}, so I'm on ${PROVIDER_LABELS[candidate.provider]}.`);
  }

  private dispose(session: Session): Promise<void> {
    const existing = this.disposals.get(session.brain);
    if (existing) return existing;
    // Retired providers can finish an async callback after stop. Keep errors
    // consumed after detaching UI handlers so EventEmitter cannot crash Echo.
    session.brain.on('error', () => {});
    session.unsubscribe();
    const result = shutdownStep('retired brain', () => {
      try {session.brain.interrupt();} catch (error) {this.report(`Brain interrupt failed: ${String(error)}`);}
      return session.brain.stop();
    }, this.options.stopTimeoutMs ?? 8_000, message => this.report(message)).then(() => {});
    this.disposals.set(session.brain, result);
    return result;
  }
}
