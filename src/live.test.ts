import { expect, test } from 'bun:test'

import { generateText } from 'ai'

import { estimateCost } from './cost.ts'
import { waibee } from './provider.ts'

test.skipIf(!process.env.WAIBEE_API_KEY)(
  'live: a cheap chat call reports usage that prices against the catalog',
  async () => {
    const id = 'openai/gpt-5.4-nano'
    const [models, result] = await Promise.all([
      waibee.models({ classes: ['text'] }),
      generateText({ model: waibee(id), prompt: 'Reply with one word: ok' }),
    ])
    const model = models.find((m) => m.id === result.response.modelId)
    expect(result.text.toLowerCase()).toContain('ok')
    expect(model).toBeDefined()
    expect(estimateCost(model!.pricing, result.usage)).toBeGreaterThan(0)
  },
  60_000,
)
