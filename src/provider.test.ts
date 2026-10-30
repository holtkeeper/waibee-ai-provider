import { describe, expect, test } from 'bun:test'

import { APICallError, NoSuchModelError } from '@ai-sdk/provider'
import { generateText } from 'ai'

import { anthropicModelName, createWaibee } from './provider.ts'

interface Call {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse((init?.body as string | undefined) ?? '{}'),
    }
    calls.push(call)
    return respond(call)
  }
  return { calls, fetch: handler as typeof globalThis.fetch }
}

const completion = (usage: Record<string, unknown>) =>
  Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'openai/gpt-5.4-nano',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage,
  })

const errorResponse = (status: number, code: string) =>
  Response.json({ error: { code, message: 'nope', extra: {} } }, { status })

describe('chat', () => {
  test('sends the key and the reasoning effort', async () => {
    const { calls, fetch } = fakeFetch(() => completion({ prompt_tokens: 1, completion_tokens: 1 }))
    const waibee = createWaibee({ apiKey: 'sk_test', baseURL: 'https://router.test/v1/', fetch })
    await generateText({
      model: waibee('openai/gpt-5.4-nano'),
      prompt: 'hi',
      providerOptions: { waibee: { reasoningEffort: 'low' } },
    })
    const [call] = calls
    expect(call?.url).toBe('https://router.test/v1/chat/completions')
    expect(call?.headers.get('authorization')).toBe('Bearer sk_test')
    expect(call?.body.model).toBe('openai/gpt-5.4-nano')
    expect(call?.body.reasoning_effort).toBe('low')
  })

  test('asks for usage in streams', async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(
          [
            `data: ${JSON.stringify({ id: 'c1', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'ok' } }] })}`,
            `data: ${JSON.stringify({ id: 'c1', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, server_tool_use: { web_search_requests: 2 } } })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const model = createWaibee({ apiKey: 'sk_test', fetch })('openai/gpt-5.4-nano')
    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    const parts: { type: string; providerMetadata?: unknown }[] = []
    for await (const part of result.stream) parts.push(part)
    expect(calls[0]?.body.stream_options).toEqual({ include_usage: true })
    expect(parts.find((p) => p.type === 'finish')?.providerMetadata).toEqual({
      waibee: { webSearchRequests: 2 },
    })
  })

  test('counts cache writes apart from uncached input and reports web searches', async () => {
    const { fetch } = fakeFetch(() =>
      completion({
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 25 },
        completion_tokens_details: { reasoning_tokens: 10 },
        server_tool_use: { web_search_requests: 1 },
      }),
    )
    const result = await generateText({
      model: createWaibee({ apiKey: 'sk_test', fetch })('anthropic/claude-sonnet-4.6'),
      prompt: 'hi',
    })
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.inputTokenDetails).toEqual({
      noCacheTokens: 35,
      cacheReadTokens: 40,
      cacheWriteTokens: 25,
    })
    expect(result.usage.outputTokenDetails).toEqual({ textTokens: 20, reasoningTokens: 10 })
    expect(result.providerMetadata?.waibee).toEqual({ webSearchRequests: 1 })
  })
})

test('model calls carry the package in the user agent', async () => {
  const { calls, fetch } = fakeFetch(() => completion({ prompt_tokens: 1, completion_tokens: 1 }))
  await createWaibee({ apiKey: 'sk_test', fetch })('m').doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  expect(calls[0]?.headers.get('user-agent')).toContain('waibee-ai-provider/')
})

const failure = async (status: number, code: string) => {
  const { fetch } = fakeFetch(() => errorResponse(status, code))
  try {
    await generateText({
      model: createWaibee({ apiKey: 'sk_test', fetch })('openai/gpt-5.4-nano'),
      prompt: 'hi',
      maxRetries: 0,
    })
  } catch (error) {
    if (APICallError.isInstance(error)) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('errors', () => {
  test('carry the router code in the message', async () => {
    const error = await failure(404, 'model_not_found')
    expect(error.message).toBe('model_not_found: nope')
    expect(error.isRetryable).toBe(false)
  })

  test('retry transient failures but not a spent key limit or balance', async () => {
    expect((await failure(503, 'service_unavailable')).isRetryable).toBe(true)
    expect((await failure(429, 'provider_rate_limited')).isRetryable).toBe(true)
    expect((await failure(429, 'api_key_limit_exceeded')).isRetryable).toBe(false)
    expect((await failure(402, 'insufficient_funds')).isRetryable).toBe(false)
  })

  test('read the short unauthorized body', async () => {
    const { fetch } = fakeFetch(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    const run = generateText({
      model: createWaibee({ apiKey: 'sk_bad', fetch })('openai/gpt-5.4-nano'),
      prompt: 'hi',
      maxRetries: 0,
    })
    expect(run).rejects.toThrow('unauthorized')
  })
})

describe('messages', () => {
  test('talks Anthropic Messages with the short Claude name', async () => {
    const { calls, fetch } = fakeFetch(() =>
      Response.json({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'anthropic/claude-haiku-4.5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    )
    const result = await generateText({
      model: createWaibee({ apiKey: 'sk_test', fetch }).messages('anthropic/claude-haiku-4.5'),
      prompt: 'hi',
    })
    expect(result.text).toBe('ok')
    expect(calls[0]?.url).toBe('https://api.waibee.com/v1/messages')
    expect(calls[0]?.headers.get('x-api-key')).toBe('sk_test')
    expect(calls[0]?.body.model).toBe('claude-haiku-4-5')
  })
})

test('embeddings go to /v1/embeddings', async () => {
  const { calls, fetch } = fakeFetch(() =>
    Response.json({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } }),
  )
  const model = createWaibee({ apiKey: 'sk_test', fetch }).embeddingModel(
    'openai/text-embedding-3-small',
  )
  const result = await model.doEmbed({ values: ['hello'] })
  expect(result.embeddings).toEqual([[0.1, 0.2]])
  expect(calls[0]?.url).toBe('https://api.waibee.com/v1/embeddings')
})

test('image models are not offered', () => {
  expect(() => createWaibee({ apiKey: 'sk_test' }).imageModel('x')).toThrow(NoSuchModelError)
})

test('anthropicModelName maps catalog ids to Anthropic SDK names', () => {
  expect(anthropicModelName('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6')
  expect(anthropicModelName('anthropic/claude-opus-5')).toBe('claude-opus-5')
  expect(anthropicModelName('openai/gpt-5.4')).toBe('openai/gpt-5.4')
})
