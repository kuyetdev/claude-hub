import type { TokenTotals } from '../shared/types.ts';

interface ApiRates {
  input: number;
  output: number;
  cache5m: number;
  cache1h: number;
  cacheRead: number;
}

/** Approximate global Anthropic API list prices in USD per million tokens. */
function ratesForModel(model: string): ApiRates | undefined {
  const id = model.toLowerCase();
  if (id.includes('sonnet-5-5')) return { input: 2, output: 10, cache5m: 2.5, cache1h: 4, cacheRead: 0.1 };
  if (id.includes('opus-5-5')) return { input: 4, output: 20, cache5m: 5, cache1h: 8, cacheRead: 0.2 };
  if (id.includes('haiku-5-5')) return { input: 0.1, output: 0.5, cache5m: 0.125, cache1h: 0.2, cacheRead: 0.01 };
  if (/opus-(?:5|4-[5678])/.test(id)) return { input: 5, output: 25, cache5m: 6.25, cache1h: 10, cacheRead: 0.5 };
  if (/opus-4-[01]/.test(id)) return { input: 15, output: 75, cache5m: 18.75, cache1h: 30, cacheRead: 1.5 };
  if (/sonnet-(?:4-[456]|4-202|3-7)/.test(id)) return { input: 3, output: 15, cache5m: 3.75, cache1h: 6, cacheRead: 0.3 };
  if (/haiku-4-5/.test(id)) return { input: 1, output: 5, cache5m: 1.25, cache1h: 2, cacheRead: 0.1 };
  if (/haiku-3-5/.test(id)) return { input: 0.8, output: 4, cache5m: 1, cache1h: 1.6, cacheRead: 0.08 };
  return undefined;
}

export function estimatedApiCostUsd(model: string, tokens: TokenTotals): number | null {
  const rates = ratesForModel(model);
  if (!rates) return null;
  let cache5m = tokens.cacheCreation5m ?? 0;
  let cache1h = tokens.cacheCreation1h ?? 0;
  // Older local scan state did not record cache TTL; display an estimate using 5m writes.
  if (cache5m + cache1h === 0 && tokens.cacheCreation > 0) cache5m = tokens.cacheCreation;
  const dollars = tokens.input * rates.input + tokens.output * rates.output
    + cache5m * rates.cache5m + cache1h * rates.cache1h + tokens.cacheRead * rates.cacheRead;
  return dollars / 1_000_000;
}
