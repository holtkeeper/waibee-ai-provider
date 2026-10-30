import { expect, test } from 'bun:test'

import type { WaibeeModel } from './catalog.ts'
import { toModelsDev } from './models-dev.ts'

const chat: WaibeeModel = {
  id: 'openai/gpt-5.4-nano',
  name: 'OpenAI: GPT-5.4 Nano',
  class: 'chat',
  contextWindow: 400000,
  input: ['text'],
  output: ['text'],
  features: ['pdf_input', 'reasoning', 'tools'],
  pricing: { input: 0.0000002, output: 0.00000125, cacheRead: 0.00000002 },
}

const embedding: WaibeeModel = {
  id: 'openai/text-embedding-3-small',
  name: 'Embedding',
  class: 'embedding',
  input: ['text'],
  output: [],
  features: [],
  pricing: { input: 0.00000002, output: 0 },
}

test('toModelsDev lists chat models with prices per million', () => {
  expect(toModelsDev([chat, embedding])).toEqual({
    id: 'waibee',
    name: 'Waibee',
    npm: 'waibee-ai-provider',
    api: 'https://api.waibee.com/v1',
    doc: 'https://docs.waibee.com/router/models/',
    env: ['WAIBEE_API_KEY'],
    models: {
      'openai/gpt-5.4-nano': {
        id: 'openai/gpt-5.4-nano',
        name: 'OpenAI: GPT-5.4 Nano',
        attachment: true,
        reasoning: true,
        tool_call: true,
        structured_output: false,
        temperature: true,
        modalities: { input: ['text'], output: ['text'] },
        cost: { input: 0.2, output: 1.25, cache_read: 0.02 },
        limit: { context: 400000, output: 0 },
      },
    },
  })
})
