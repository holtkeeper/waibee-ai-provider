import { type FetchFunction, loadApiKey, withoutTrailingSlash } from '@ai-sdk/provider-utils'

/** Where the Router API lives unless `baseURL` says otherwise. */
export const WAIBEE_BASE_URL = 'https://api.waibee.com/v1'

/** Environment variable the API key is read from when none is passed. */
export const WAIBEE_API_KEY_ENV = 'WAIBEE_API_KEY'

/** Which endpoint a model works on: `chat`, `embedding` or `decision`; new classes pass through. */
export type WaibeeModelClass = 'chat' | 'embedding' | 'decision' | (string & {})

/** Reasoning effort levels the router knows; a model accepts the subset in its `reasoning.efforts`. */
export type WaibeeReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | (string & {})

/**
 * Prices of one model in USD per token. `input` and `output` are always set (zero when the catalog
 * gives none, as for `waibee/auto`); every other rate is set only when the catalog lists it.
 */
export interface WaibeePricing {
  input: number
  output: number
  cacheRead?: number
  /** Cache write with the default (5 minute) lifetime. */
  cacheWrite?: number
  cacheWrite1h?: number
  /** Reasoning tokens, when they are billed apart from the rest of the output. */
  reasoning?: number
  image?: number
  audio?: number
  /** Fixed price per request. */
  request?: number
  /** Rates the catalog lists that have no field above, by their catalog name. */
  other?: Record<string, number>
}

/** One model of the Waibee catalog. */
export interface WaibeeModel {
  /** The value for the `model` field of a request, e.g. `anthropic/claude-sonnet-4.6`. */
  id: string
  name: string
  class: WaibeeModelClass
  contextWindow?: number
  maxOutputTokens?: number
  /** Input modalities, e.g. `['image', 'text']`. */
  input: string[]
  output: string[]
  /** Capabilities such as `tools`, `reasoning`, `structured_outputs`, `pdf_input`; the list grows. */
  features: string[]
  /** Accepted effort levels, weakest first, and the default; absent when the model does not reason. */
  reasoning?: { efforts: WaibeeReasoningEffort[]; default?: WaibeeReasoningEffort }
  pricing: WaibeePricing
}

/** Model classes `listWaibeeModels` can ask for; `all` means every class. */
export type WaibeeModelFilter = 'text' | 'embeddings' | 'decisions' | 'all'

export interface ListWaibeeModelsOptions {
  /** Defaults to the `WAIBEE_API_KEY` environment variable. */
  apiKey?: string
  /** Defaults to `WAIBEE_BASE_URL`. */
  baseURL?: string
  headers?: Record<string, string>
  fetch?: FetchFunction
  /** Classes to list. Default `['all']`; the API itself defaults to chat models only. */
  classes?: WaibeeModelFilter[]
  signal?: AbortSignal
}

const PRICE_FIELDS: Record<string, keyof Omit<WaibeePricing, 'other'>> = {
  prompt: 'input',
  completion: 'output',
  input_cache_read: 'cacheRead',
  input_cache_write: 'cacheWrite',
  input_cache_write_1h: 'cacheWrite1h',
  internal_reasoning: 'reasoning',
  image: 'image',
  audio: 'audio',
  request: 'request',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function rate(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined
}

function pricingOf(value: unknown): WaibeePricing {
  const pricing: WaibeePricing = { input: 0, output: 0 }
  if (!isRecord(value)) return pricing
  const other: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const amount = rate(raw)
    if (amount === undefined) continue
    const field = PRICE_FIELDS[key]
    if (field) pricing[field] = amount
    else other[key] = amount
  }
  if (Object.keys(other).length) pricing.other = other
  return pricing
}

function reasoningOf(value: unknown): WaibeeModel['reasoning'] {
  if (!isRecord(value)) return undefined
  const fallback = text(value.default)
  return { efforts: strings(value.efforts), ...(fallback && { default: fallback }) }
}

/** One entry of `GET /v1/models`, or `undefined` when it has no id. */
export function parseWaibeeModel(value: unknown): WaibeeModel | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id)
  if (!id) return undefined
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {}
  const contextWindow = count(value.context_length)
  const maxOutputTokens = count(value.max_completion_tokens)
  const reasoning = reasoningOf(value.reasoning)
  return {
    id,
    name: text(value.name) ?? id,
    class: text(value.model_class) ?? 'chat',
    ...(contextWindow !== undefined && { contextWindow }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    input: strings(capabilities.modality_input),
    output: strings(capabilities.modality_output),
    features: strings(capabilities.features),
    ...(reasoning && { reasoning }),
    pricing: pricingOf(value.pricing),
  }
}

/** The models of a `GET /v1/models` response body; entries it cannot read are skipped. */
export function parseWaibeeModels(body: unknown): WaibeeModel[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  return data.flatMap((entry) => parseWaibeeModel(entry) ?? [])
}

/** Whether the catalog lists `feature` (e.g. `tools`, `reasoning`) for the model. */
export const supports = (model: Pick<WaibeeModel, 'features'>, feature: string) =>
  model.features.includes(feature)

/**
 * The models available to the key, from `GET /v1/models`. Prices follow the key's plan, so they
 * are what the account is billed, unlike the bundled `WAIBEE_MODELS_SNAPSHOT`.
 */
export async function listWaibeeModels(
  options: ListWaibeeModelsOptions = {},
): Promise<WaibeeModel[]> {
  const apiKey = loadApiKey({
    apiKey: options.apiKey,
    environmentVariableName: WAIBEE_API_KEY_ENV,
    description: 'Waibee',
  })
  const base = withoutTrailingSlash(options.baseURL ?? WAIBEE_BASE_URL)
  const classes = (options.classes ?? ['all']).join(',')
  const url = `${base}/models?output_modalities=${encodeURIComponent(classes)}`
  const response = await (options.fetch ?? fetch)(url, {
    headers: { ...options.headers, accept: 'application/json', authorization: `Bearer ${apiKey}` },
    ...(options.signal && { signal: options.signal }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `GET ${url}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`,
    )
  }
  return parseWaibeeModels(await response.json())
}
