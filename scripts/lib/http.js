// Fetch wrapper with retry/backoff and a simple rate limiter. Node 20+ has
// global fetch — no dependency needed.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a rate limiter that allows at most `maxPerSecond` calls/sec.
 * Call `await limiter()` before each request.
 */
export function createRateLimiter(maxPerSecond) {
  const intervalMs = 1000 / maxPerSecond;
  let lastCall = 0;
  return async function limiter() {
    const now = Date.now();
    const wait = lastCall + intervalMs - now;
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  };
}

/**
 * Run `fn` over `items` with up to `concurrency` in flight at once, instead
 * of a plain `for...of` loop that awaits each call in turn. A sequential
 * loop is bounded by (rate-limit delay + full round-trip latency) per item;
 * for a few dozen items that's fine, but it scales linearly and becomes
 * minutes-long once the item count reaches into the thousands (e.g.
 * link-health checks across a full live event dataset). Order of results
 * matches the order of `items`.
 */
export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Fetch JSON with retry + exponential backoff on 429/5xx. Throws on
 * exhausted retries or non-retryable errors (4xx other than 429).
 */
export async function fetchJsonWithRetry(url, options = {}, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res.json();

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      // non-retryable 4xx — marked so the catch below rethrows it instead
      // of retrying a request that will fail the same way every time (a bad
      // API key otherwise costs four requests and ~7s of backoff per call)
      const body = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`);
      err.status = res.status;
      err.retryable = false;
      throw err;
    } catch (err) {
      if (err.retryable === false) throw err;
      lastError = err;
      if (attempt < retries) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}
