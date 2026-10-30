import { createAnthropic } from '@ai-sdk/anthropic'
import {
  type MetadataExtractor,
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleEmbeddingModel,
} from '@ai-sdk/openai-compatible'
import {
  type EmbeddingModelV4,
  type JSONObject,
  type LanguageModelV4,
  NoSuchModelError,
  type ProviderV4,
} from '@ai-sdk/provider'
import {
  type FetchFunction,
  loadApiKey,
  withUserAgentSuffix,
  withoutTrailingSlash,
} from '@ai-sdk/provider-utils'

import {
  type ListWaibeeModelsOptions,
  WAIBEE_API_KEY_ENV,
  WAIBEE_BASE_URL,
  type WaibeeModel,
  listWaibeeModels,
} from './catalog.ts'
import { waibeeErrorStructure } from './errors.ts'
import type { WaibeeChatModelId, WaibeeEmbeddingModelId } from './model-ids.ts'
import { VERSION } from './version.ts'

export interface WaibeeProviderSettings {
  /** Defaults to the `WAIBEE_API_KEY` environment variable, read when a request is made. */
  apiKey?: string
  /** API root with `/v1`. Defaults to `WAIBEE_BASE_URL`. */
  baseURL?: string
  /** Extra headers for every request, e.g. tracing ids. */
  headers?: Record<string, string>
  /** Custom fetch, e.g. for tests or a proxy. */
  fetch?: FetchFunction
  /** Provider name in model metadata and the key of `providerOptions`. Default `waibee`. */
  name?: string
}

/** A Waibee Router provider for the AI SDK. Calling it is the same as `chat(modelId)`. */
export interface WaibeeProvider extends ProviderV4 {
  (modelId: WaibeeChatModelId): LanguageModelV4
  /** Same as `chat(modelId)`. */
  languageModel(modelId: WaibeeChatModelId): LanguageModelV4
  /**
   * Any chat model over `POST /v1/chat/completions`, the format the router supports best: tools,
   * structured outputs, reasoning (`providerOptions.waibee.reasoningEffort`) and streaming.
   */
  chat(modelId: WaibeeChatModelId): LanguageModelV4
  /**
   * A chat model over `POST /v1/messages` (Anthropic Messages), driven by `@ai-sdk/anthropic`.
   * Use it for Claude models when you need `cache_control` prompt caching or signed thinking
   * blocks passed back across turns; set Anthropic options under `providerOptions.anthropic`.
   */
  messages(modelId: WaibeeChatModelId): LanguageModelV4
  /** An embedding model over `POST /v1/embeddings`. */
  embeddingModel(modelId: WaibeeEmbeddingModelId): EmbeddingModelV4
  /** @deprecated Use `embeddingModel`. */
  textEmbeddingModel(modelId: WaibeeEmbeddingModelId): EmbeddingModelV4
  /** The catalog for this provider's key and base URL: ids, capabilities and prices. */
  models(options?: Pick<ListWaibeeModelsOptions, 'classes' | 'signal'>): Promise<WaibeeModel[]>
}

/**
 * The Anthropic SDK name of a catalog id: `anthropic/claude-sonnet-4.6` becomes
 * `claude-sonnet-4-6`, which `@ai-sdk/anthropic` recognizes and the router maps back. Ids of other
 * vendors are returned as they are.
 */
export function anthropicModelName(modelId: string): string {
  if (!modelId.startsWith('anthropic/')) return modelId
  return modelId.slice('anthropic/'.length).replaceAll(/(\d)\.(\d)/g, '$1-$2')
}

type ChatConfig = ConstructorParameters<typeof OpenAICompatibleChatLanguageModel>[1]
type ChatUsage = Parameters<NonNullable<ChatConfig['convertUsage']>>[0]

const count = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The router reports cache writes in `prompt_tokens_details.cache_write_tokens`, which the stock
// OpenAI-compatible converter ignores, so uncached input would be overstated.
function convertUsage(usage: ChatUsage): ReturnType<NonNullable<ChatConfig['convertUsage']>> {
  const details: Record<string, unknown> = usage?.prompt_tokens_details ?? {}
  const prompt = count(usage?.prompt_tokens)
  const completion = count(usage?.completion_tokens)
  const cacheRead = count(details.cached_tokens) ?? 0
  const cacheWrite = count(details.cache_write_tokens) ?? 0
  const reasoning = count(usage?.completion_tokens_details?.reasoning_tokens) ?? 0
  return {
    inputTokens: {
      total: prompt,
      noCache: prompt === undefined ? undefined : Math.max(prompt - cacheRead - cacheWrite, 0),
      cacheRead: prompt === undefined ? undefined : cacheRead,
      cacheWrite: prompt === undefined ? undefined : cacheWrite,
    },
    outputTokens: {
      total: completion,
      text: completion === undefined ? undefined : Math.max(completion - reasoning, 0),
      reasoning: completion === undefined ? undefined : reasoning,
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    ...(usage && { raw: usage as JSONObject }),
  }
}

function webSearchRequests(body: unknown) {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined
  const tools = body.usage.server_tool_use
  return isRecord(tools) ? count(tools.web_search_requests) : undefined
}

function metadataExtractor(name: string): MetadataExtractor {
  const build = (searches: number | undefined) =>
    searches ? { [name]: { webSearchRequests: searches } } : undefined
  return {
    extractMetadata: async ({ parsedBody }) => build(webSearchRequests(parsedBody)),
    createStreamExtractor: () => {
      let searches: number | undefined
      return {
        processChunk: (chunk) => {
          searches = webSearchRequests(chunk) ?? searches
        },
        buildMetadata: () => build(searches),
      }
    },
  }
}

/** A Waibee Router provider. Without settings it reads the key from `WAIBEE_API_KEY`. */
export function createWaibee(settings: WaibeeProviderSettings = {}): WaibeeProvider {
  const baseURL = withoutTrailingSlash(settings.baseURL) ?? WAIBEE_BASE_URL
  const name = settings.name ?? 'waibee'
  const apiKey = () =>
    loadApiKey({
      apiKey: settings.apiKey,
      environmentVariableName: WAIBEE_API_KEY_ENV,
      description: 'Waibee',
    })
  const headers = () =>
    withUserAgentSuffix(
      { ...settings.headers, Authorization: `Bearer ${apiKey()}` },
      `waibee-ai-provider/${VERSION}`,
    )
  const url = ({ path }: { path: string }) => `${baseURL}${path}`

  const chat = (modelId: string) =>
    new OpenAICompatibleChatLanguageModel(modelId, {
      provider: `${name}.chat`,
      url,
      headers,
      ...(settings.fetch && { fetch: settings.fetch }),
      includeUsage: true,
      supportsStructuredOutputs: true,
      errorStructure: waibeeErrorStructure,
      convertUsage,
      metadataExtractor: metadataExtractor(name),
      supportedUrls: () => ({ 'image/*': [/^https?:\/\/.*$/] }),
    })

  const messages = (modelId: string) =>
    createAnthropic({
      baseURL,
      apiKey: apiKey(),
      headers: withUserAgentSuffix(settings.headers, `waibee-ai-provider/${VERSION}`),
      ...(settings.fetch && { fetch: settings.fetch }),
      name: `${name}.messages`,
    }).messages(anthropicModelName(modelId))

  const embeddingModel = (modelId: string) =>
    new OpenAICompatibleEmbeddingModel(modelId, {
      provider: `${name}.embedding`,
      url,
      headers,
      ...(settings.fetch && { fetch: settings.fetch }),
      errorStructure: waibeeErrorStructure,
    })

  function provider(modelId: string) {
    if (new.target) throw new Error('The Waibee provider cannot be called with new.')
    return chat(modelId)
  }
  return Object.assign(provider, {
    specificationVersion: 'v4' as const,
    languageModel: chat,
    chat,
    messages,
    embeddingModel,
    textEmbeddingModel: embeddingModel,
    imageModel: (modelId: string): never => {
      throw new NoSuchModelError({ modelId, modelType: 'imageModel' })
    },
    models: (options: Pick<ListWaibeeModelsOptions, 'classes' | 'signal'> = {}) =>
      listWaibeeModels({
        ...options,
        baseURL,
        apiKey: apiKey(),
        ...(settings.headers && { headers: settings.headers }),
        ...(settings.fetch && { fetch: settings.fetch }),
      }),
  })
}

/** The default provider: key from `WAIBEE_API_KEY`, base URL `WAIBEE_BASE_URL`. */
export const waibee: WaibeeProvider = createWaibee()
