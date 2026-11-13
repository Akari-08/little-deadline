/** Tiny typed event emitter. A throwing listener cannot break the emitter's owner. */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (payload: never) => void);
    return () => { set.delete(listener as (payload: never) => void); };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (payload: Events[K]) => void)(payload);
      } catch (error) {
        console.error(`[taskpet] ${String(type)} listener failed:`, error instanceof Error ? error.message : error);
      }
    }
  }
}
