// p6d gate fix (task #33's cursor-write throttle): three writer paths for
// the same symbol's gap-replay cursor — live trades, gap-replay's own
// direct persist, and the session's final flush — were each firing
// writeCursorFenced independently. gap-replay-cursor.ts's own read-current
// -compare-then-write regression guard is safe ONLY if writes for one
// symbol never interleave; without that, a slower write started earlier
// can still land AFTER a faster one started later, letting a stale value
// win the race and the guard see a false "not a regression" (it only
// compares against whatever's in Redis at the moment IT reads, not against
// any other in-flight writer). This is a small, generic per-key
// serializer, not cursor-specific — every task queued under the same key
// chains strictly after the previous one for that key has fully settled
// (success or failure), so writes for the SAME symbol can never race each
// other; different symbols remain fully independent.
export interface SerialQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  const chains = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve();
      // .then(task, task): runs `task` after `previous` settles, whether it
      // resolved or rejected — a failed task must not break the chain for
      // whatever's queued behind it under the same key.
      const next = previous.then(task, task);
      chains.set(key, next);
      return next;
    },
  };
}
