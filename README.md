# waibee-ai-provider

A [Waibee Router](https://docs.waibee.com/router/) provider for the [Vercel AI SDK](https://ai-sdk.dev),
plus the model catalog with prices and a cost estimator.

- One key for models of every vendor in the Waibee catalog (`anthropic/…`, `openai/…`, `google/…`,
  `deepseek/…`, `qwen/…`, …) and the `waibee/auto` router.
- Chat Completions, Anthropic Messages and Embeddings endpoints as AI SDK models.
- Token usage that includes cache writes, so cost estimates match what the router bills.
- The live catalog (`GET /v1/models`) as typed objects, a bundled snapshot for offline use, and an
  export to the [models.dev](https://models.dev) format.

## Install

Not on npm yet; install from GitHub:

```bash
npm install github:holtkeeper/waibee-ai-provider ai
```

```bash
bun add github:holtkeeper/waibee-ai-provider ai
```

Requires AI SDK 7 (`ai@^7`, provider specification v4) and Node 20+ or Bun.

## Quickstart

Create a key at [chat.waibee.com/api-keys](https://chat.waibee.com/api-keys) and put it in
`WAIBEE_API_KEY`.

```ts
import { generateText } from 'ai'
import { waibee } from 'waibee-ai-provider'

const { text } = await generateText({
  model: waibee('anthropic/claude-sonnet-4.6'),
  prompt: 'Write a haiku about routers.',
})
```

`createWaibee` takes settings when the environment default does not fit:

```ts
import { createWaibee } from 'waibee-ai-provider'

const waibee = createWaibee({
  apiKey: process.env.MY_WAIBEE_KEY, // default: WAIBEE_API_KEY, read on each request
  baseURL: 'https://api.waibee.com/v1', // the default
  headers: { 'x-request-source': 'batch-jobs' },
})
```

Model ids always carry the vendor prefix (`openai/gpt-5.4`, not `gpt-5.4`). Take them from the
catalog: the model id type lists the ids known at build time and accepts any other string.

## Models

| Method                          | Endpoint                    | Use it for                                               |
| ------------------------------- | --------------------------- | -------------------------------------------------------- |
| `waibee(id)`, `waibee.chat(id)` | `POST /v1/chat/completions` | Any chat model: tools, structured output, streaming      |
| `waibee.messages(id)`           | `POST /v1/messages`         | Claude models with prompt caching or thinking round-trip |
| `waibee.embeddingModel(id)`     | `POST /v1/embeddings`       | `embed`, `embedMany`                                     |
| `waibee.models()`               | `GET /v1/models`            | The catalog for this provider's key                      |

### Chat Completions

The default. It works with every chat model and everything the AI SDK does on top of it: tool loops,
`Output.object`, `streamText`, image inputs.

```ts
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

const result = await generateText({
  model: waibee('deepseek/deepseek-v4-flash'),
  tools: {
    weather: tool({
      description: 'Current weather in a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, celsius: 21 }),
    }),
  },
  stopWhen: stepCountIs(5),
  prompt: 'Is it warm in Lisbon?',
})
```

### Reasoning

Set the effort under `providerOptions.waibee`; it is sent as `reasoning_effort`. The levels a model
accepts are in its catalog entry (`model.reasoning.efforts`); a level outside the list may be
rejected with `400 feature_not_supported`.

```ts
await generateText({
  model: waibee('openai/gpt-5.4-mini'),
  prompt: 'What is 17*23?',
  providerOptions: { waibee: { reasoningEffort: 'low' } },
})
```

The AI SDK's top-level `reasoning` call option works too. Reasoning text comes back as reasoning
parts; reasoning tokens are in `usage.outputTokenDetails.reasoningTokens`.

### Anthropic Messages

`waibee.messages(id)` drives `/v1/messages` with `@ai-sdk/anthropic`, so every Anthropic feature of
the AI SDK applies: `cacheControl` breakpoints, extended thinking with signed blocks kept across
turns, PDF documents. Catalog ids are mapped to the names the Anthropic SDK knows
(`anthropic/claude-sonnet-4.6` → `claude-sonnet-4-6`); options go under `providerOptions.anthropic`.

```ts
await generateText({
  model: waibee.messages('anthropic/claude-sonnet-4.6'),
  messages: [
    {
      role: 'system',
      content: longStablePrompt,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
    { role: 'user', content: 'Summarize section 3.' },
  ],
})
```

### Embeddings

```ts
import { embedMany } from 'ai'

const { embeddings } = await embedMany({
  model: waibee.embeddingModel('openai/text-embedding-3-small'),
  values: ['first', 'second'],
})
```

### Autorouting

`waibee('waibee/auto')` lets the router pick a model per request. The model that actually ran is in
`result.response.modelId`; price the request with that model, since `waibee/auto` itself has no
prices.

## Catalog and prices

```ts
import { listWaibeeModels, supports } from 'waibee-ai-provider'

const models = await listWaibeeModels() // every class; or waibee.models()
const agents = models.filter((m) => m.class === 'chat' && supports(m, 'tools'))
```

Each `WaibeeModel` has `id`, `name`, `class` (`chat`, `embedding`, `decision`), `contextWindow`,
`maxOutputTokens`, `input`/`output` modalities, `features` (`tools`, `reasoning`,
`structured_outputs`, `pdf_input`, …), `reasoning` (`efforts`, `default`) and `pricing` in USD per
token: `input`, `output` and, when the model has them, `cacheRead`, `cacheWrite`, `cacheWrite1h`,
`reasoning`, `image`, `audio`, `request`, plus `other` for rates without a field.

The live catalog carries the prices of the key's plan. `WAIBEE_MODELS_SNAPSHOT` is a copy bundled
with the package (`fetchedAt` says when): use it for model pickers before a key is set, tests and
rough estimates, not for billing.

### Estimating cost

`estimateCost` prices AI SDK usage the way the router bills it: uncached input, cache reads, cache
writes and output each at their own rate, reasoning at its own rate where the model has one, plus a
per-request price.

```ts
import { estimateCost } from 'waibee-ai-provider'

const result = await generateText({ model: waibee('waibee/auto'), prompt })
const model = models.find((m) => m.id === result.response.modelId)
const usd =
  model && estimateCost(model.pricing, result.totalUsage, { requests: result.steps.length })
```

It is an estimate: tiered prices for very long inputs and web searches are not in the catalog, and
the one hour cache share is only counted when you pass `cacheWrite1hTokens`. Searches the router ran
are reported in `providerMetadata.waibee.webSearchRequests`.

`pricePerMillion(model.pricing)` gives the same rates per million tokens.

### models.dev format

`toModelsDev(models)` turns the chat models into a models.dev provider entry (prices per million,
limits, capabilities), for tools and dashboards that already read models.dev data:

```ts
import { listWaibeeModels, toModelsDev } from 'waibee-ai-provider'

const entry = toModelsDev(await listWaibeeModels())
const catalog = { ...(await (await fetch('https://models.dev/api.json')).json()), waibee: entry }
```

## Errors and retries

Router errors become AI SDK `APICallError`s whose message starts with the router code
(`model_not_found: …`, `insufficient_funds: …`); the parsed body is in `error.data`, and
`waibeeErrorCode(error.data)` returns the code. Only transient failures are retryable (408, 429,
500, 502, 503), except `api_key_limit_exceeded` and `insufficient_funds`, which a retry cannot fix.
The AI SDK's `maxRetries` applies as usual.

## Limitations

- The OpenAI Responses endpoint (`/v1/responses`) is not wrapped; Chat Completions covers the same
  models.
- On Chat Completions, encrypted `reasoning_details` are not sent back in later turns. Use
  `messages()` for Claude when thinking must carry over between turns.
- Prompt caching with explicit breakpoints needs `messages()`; Chat Completions only reports the
  caching the model does on its own.
- Image generation, decision models (`/v1/systemone`) and transcription are not offered.

## Development

```bash
bun install
bun run check   # format, lint, typecheck, tests
bun run build   # dist/ for Node consumers
```

`WAIBEE_API_KEY=… bun test` also runs a live test that makes one cheap request.
`WAIBEE_API_KEY=… bun run sync` refreshes `src/snapshot.ts` and the model id types from the live
catalog.

## License

MIT
