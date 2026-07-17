export async function withRetries<T>(params: {
  maxAttempts: number;
  baseDelayMs: number;
  execute: (attempt: number) => Promise<T>;
  shouldRetry: (error: unknown) => boolean;
}): Promise<{ result: T; attempts: number }> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < params.maxAttempts) {
    attempt += 1;
    try {
      const result = await params.execute(attempt);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= params.maxAttempts || !params.shouldRetry(error)) {
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { attempts: attempt },
        );
      }
      const delayMs = Math.min(params.baseDelayMs * 2 ** (attempt - 1), 4000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
