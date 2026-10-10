// A fetch that is also cancelled by a job-wide signal.
//
// The Anthropic client takes a custom fetch (new Anthropic({ fetch })). Every
// call extraction makes (pass 1, each pass 2, collapse) goes through it, so one
// abort cancels whichever are in flight, whether or not the call site passed a
// signal of its own. The caller's signal, when there is one, still works: either
// aborts the request.
//
// The SDK treats a failed fetch as a connection error and retries it (twice, after
// about 0.5 s and 1 s), so an abort reaches the caller as an error about 1.5 s
// later and not at once. The worker does not read the error to learn that it
// aborted; it knows, because it did it.

export function abortableFetch(base: typeof fetch, signal: AbortSignal): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch;
}
