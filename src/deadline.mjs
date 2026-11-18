// Cancelling the timer when I/O finishes lets an idle Durable Object hibernate.
export async function withDeadline(ms, parent, run) {
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new DOMException('Deadline exceeded','TimeoutError')),ms)
  try {
    signal.throwIfAborted()
    return await run(signal)
  } finally { clearTimeout(timer) }
}
