import type { WaibeePricing } from './catalog.ts'

/**
 * Token counts of one or more requests. The AI SDK's `LanguageModelUsage` (`result.usage`,
 * `result.totalUsage`) fits as is; missing counts are zero.
 */
export interface WaibeeUsage {
  /** All input, cached part included. */
  inputTokens?: number | undefined
  inputTokenDetails?: {
    noCacheTokens?: number | undefined
    cacheReadTokens?: number | undefined
    cacheWriteTokens?: number | undefined
  }
  /** All output, reasoning included. */
  outputTokens?: number | undefined
  outputTokenDetails?: { reasoningTokens?: number | undefined }
  /** Part of the cache writes made with the one hour lifetime, when the caller knows it. */
  cacheWrite1hTokens?: number
}

export interface EstimateCostOptions {
  /** Requests the usage covers, for models with a fixed price per request. Default 1. */
  requests?: number
}

const tokens = (value: number | undefined) => (value && value > 0 ? value : 0)

/**
 * The cost in USD of `usage` at `pricing`, the way the router bills it: uncached input, cache
 * reads, cache writes and output each at their own rate, reasoning at its own rate when the model
 * has one, plus the per-request price. A rate the model lacks falls back to the plain input or
 * output rate. It is an estimate: tiered prices for long inputs and web searches are not in the
 * catalog.
 */
export function estimateCost(
  pricing: WaibeePricing,
  usage: WaibeeUsage,
  options: EstimateCostOptions = {},
): number {
  const details = usage.inputTokenDetails ?? {}
  const cacheRead = tokens(details.cacheReadTokens)
  const cacheWrite = tokens(details.cacheWriteTokens)
  const cacheWrite1h = Math.min(tokens(usage.cacheWrite1hTokens), cacheWrite)
  const noCache =
    details.noCacheTokens !== undefined
      ? tokens(details.noCacheTokens)
      : Math.max(tokens(usage.inputTokens) - cacheRead - cacheWrite, 0)
  const output = tokens(usage.outputTokens)
  const reasoning =
    pricing.reasoning === undefined
      ? 0
      : Math.min(tokens(usage.outputTokenDetails?.reasoningTokens), output)

  const cost =
    noCache * pricing.input +
    cacheRead * (pricing.cacheRead ?? pricing.input) +
    (cacheWrite - cacheWrite1h) * (pricing.cacheWrite ?? pricing.input) +
    cacheWrite1h * (pricing.cacheWrite1h ?? pricing.cacheWrite ?? pricing.input) +
    (output - reasoning) * pricing.output +
    reasoning * (pricing.reasoning ?? pricing.output) +
    (options.requests ?? 1) * (pricing.request ?? 0)
  return roundUsd(cost)
}

/** Prices in USD per million tokens, the unit most catalogs and dashboards use. */
export interface PricePerMillion {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
  reasoning?: number
}

const perMillion = (perToken: number) => roundUsd(perToken * 1_000_000)

/** `pricing` in USD per million tokens; the per-request price and media rates are left out. */
export function pricePerMillion(pricing: WaibeePricing): PricePerMillion {
  const { cacheRead, cacheWrite, cacheWrite1h, reasoning } = pricing
  return {
    input: perMillion(pricing.input),
    output: perMillion(pricing.output),
    ...(cacheRead !== undefined && { cacheRead: perMillion(cacheRead) }),
    ...(cacheWrite !== undefined && { cacheWrite: perMillion(cacheWrite) }),
    ...(cacheWrite1h !== undefined && { cacheWrite1h: perMillion(cacheWrite1h) }),
    ...(reasoning !== undefined && { reasoning: perMillion(reasoning) }),
  }
}

// Per-token rates like 0.000003 do not survive float multiplication exactly.
const roundUsd = (value: number) => Number(value.toPrecision(12))
