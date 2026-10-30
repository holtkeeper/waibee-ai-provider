import { describe, expect, test } from 'bun:test'

import type { WaibeePricing } from './catalog.ts'
import { estimateCost, pricePerMillion } from './cost.ts'

const claude: WaibeePricing = {
  input: 0.000003,
  output: 0.000015,
  cacheRead: 0.0000003,
  cacheWrite: 0.00000375,
  cacheWrite1h: 0.000006,
}

describe('estimateCost', () => {
  test('bills each input part at its own rate', () => {
    const cost = estimateCost(claude, {
      inputTokens: 1_000_000,
      inputTokenDetails: { cacheReadTokens: 500_000, cacheWriteTokens: 200_000 },
      outputTokens: 100_000,
    })
    // 300k uncached * 3 + 500k reads * 0.3 + 200k writes * 3.75 + 100k out * 15, per million
    expect(cost).toBe(0.9 + 0.15 + 0.75 + 1.5)
  })

  test('prefers noCacheTokens and splits one hour cache writes', () => {
    const cost = estimateCost(claude, {
      inputTokens: 999,
      inputTokenDetails: { noCacheTokens: 1000, cacheWriteTokens: 1000 },
      cacheWrite1hTokens: 400,
    })
    expect(cost).toBe(0.00765)
  })

  test('bills reasoning apart only when the model has a reasoning rate', () => {
    const usage = { outputTokens: 1000, outputTokenDetails: { reasoningTokens: 400 } }
    expect(estimateCost({ input: 0, output: 0.00001 }, usage)).toBe(0.01)
    expect(estimateCost({ input: 0, output: 0.00001, reasoning: 0.00002 }, usage)).toBe(0.014)
  })

  test('falls back to the input rate and adds the per-request price', () => {
    const usage = { inputTokens: 100, inputTokenDetails: { cacheReadTokens: 100 } }
    expect(
      estimateCost({ input: 0.00001, output: 0, request: 0.002 }, usage, { requests: 3 }),
    ).toBe(0.007)
  })

  test('is zero for empty usage', () => {
    expect(estimateCost(claude, {})).toBe(0)
  })
})

test('pricePerMillion converts per-token rates without float noise', () => {
  expect(pricePerMillion(claude)).toEqual({
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
  })
  expect(pricePerMillion({ input: 0.000000045, output: 0.0000005 })).toEqual({
    input: 0.045,
    output: 0.5,
  })
})
