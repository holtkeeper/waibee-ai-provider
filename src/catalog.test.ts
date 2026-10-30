import { describe, expect, test } from 'bun:test'

import { listWaibeeModels, parseWaibeeModels, supports } from './catalog.ts'

const sonnet = {
  id: 'anthropic/claude-sonnet-4.6',
  object: 'model',
  name: 'Anthropic: Claude Sonnet 4.6',
  context_length: 1000000,
  max_completion_tokens: 128000,
  pricing: {
    prompt: '0.000003',
    completion: '0.000015',
    input_cache_read: '0.0000003',
    input_cache_write: '0.00000375',
    input_cache_write_1h: '0.000006',
    input_audio_cache: '0.0000001',
  },
  model_class: 'chat',
  capabilities: {
    modality_input: ['image', 'text'],
    modality_output: ['text'],
    features: ['pdf_input', 'reasoning', 'tools'],
  },
  reasoning: { efforts: ['none', 'low', 'high'], default: 'medium' },
}

describe('parseWaibeeModels', () => {
  test('reads ids, limits, capabilities and per-token prices', () => {
    const [model] = parseWaibeeModels({ object: 'list', data: [sonnet] })
    expect(model).toEqual({
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Anthropic: Claude Sonnet 4.6',
      class: 'chat',
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      input: ['image', 'text'],
      output: ['text'],
      features: ['pdf_input', 'reasoning', 'tools'],
      reasoning: { efforts: ['none', 'low', 'high'], default: 'medium' },
      pricing: {
        input: 0.000003,
        output: 0.000015,
        cacheRead: 0.0000003,
        cacheWrite: 0.00000375,
        cacheWrite1h: 0.000006,
        other: { input_audio_cache: 0.0000001 },
      },
    })
    expect(supports(model!, 'tools')).toBe(true)
    expect(supports(model!, 'structured_outputs')).toBe(false)
  })

  test('keeps the auto router with zero prices and skips unreadable entries', () => {
    const models = parseWaibeeModels({
      data: [
        {
          id: 'waibee/auto',
          model_class: 'chat',
          context_length: null,
          pricing: {},
          reasoning: null,
        },
        { name: 'no id' },
        'junk',
      ],
    })
    expect(models).toEqual([
      {
        id: 'waibee/auto',
        name: 'waibee/auto',
        class: 'chat',
        input: [],
        output: [],
        features: [],
        pricing: { input: 0, output: 0 },
      },
    ])
    expect(parseWaibeeModels(null)).toEqual([])
  })
})

const asFetch = (handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  handler as typeof fetch

describe('listWaibeeModels', () => {
  test('asks for every class with the bearer key', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const models = await listWaibeeModels({
      apiKey: 'sk_test',
      baseURL: 'https://router.test/v1/',
      fetch: asFetch(async (url, init) => {
        calls.push({
          url: url instanceof Request ? url.url : url.toString(),
          headers: init?.headers as Record<string, string>,
        })
        return Response.json({ data: [sonnet] })
      }),
    })
    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.6'])
    expect(calls[0]?.url).toBe('https://router.test/v1/models?output_modalities=all')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk_test')
  })

  test('throws with the status and body on failure', async () => {
    const failing = listWaibeeModels({
      apiKey: 'sk_bad',
      fetch: asFetch(async () => Response.json({ error: 'unauthorized' }, { status: 401 })),
    })
    expect(failing).rejects.toThrow('HTTP 401 {"error":"unauthorized"}')
  })
})
