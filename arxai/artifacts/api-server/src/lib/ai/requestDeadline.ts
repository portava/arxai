/** A wall-clock budget shared by transport, SDK retries, and stream reads. */
function deadline(ms: number, purpose: string) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`llm_timeout:${purpose}`);
      reject(error);
      controller.abort(error);
    }, ms);
  });
  return {
    signal: controller.signal,
    wait: <T>(work: PromiseLike<T>) => Promise.race([work, expired]),
    close: () => { clearTimeout(timer); controller.abort(); },
  };
}

export async function runWithDeadline<T>(
  run: (signal: AbortSignal) => PromiseLike<T>, ms: number, purpose: string,
): Promise<T> {
  const budget = deadline(ms, purpose);
  try { return await budget.wait(run(budget.signal)); }
  finally { budget.close(); }
}

export async function openStreamWithDeadline<T>(
  open: (signal: AbortSignal) => PromiseLike<AsyncIterable<T>>, ms: number, purpose: string,
): Promise<AsyncIterable<T>> {
  const budget = deadline(ms, purpose);
  let stream: AsyncIterable<T>;
  try { stream = await budget.wait(open(budget.signal)); }
  catch (error) { budget.close(); throw error; }
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await budget.wait(iterator.next());
          if (next.done) return;
          yield next.value;
        }
      } finally {
        budget.close();
        // An abandoned/stalled iterator must not hold the caller open. The
        // signal above cancels the real SDK transport, including body reads.
        void iterator.return?.().catch(() => {});
      }
    },
  };
}
