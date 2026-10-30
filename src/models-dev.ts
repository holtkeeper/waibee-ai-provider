import { WAIBEE_API_KEY_ENV, WAIBEE_BASE_URL, type WaibeeModel, supports } from './catalog.ts'
import { pricePerMillion } from './cost.ts'

/** One model in the models.dev `api.json` format. */
export interface ModelsDevModel {
  id: string
  name: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  structured_output: boolean
  temperature: boolean
  modalities: { input: string[]; output: string[] }
  cost: { input: number; output: number; cache_read?: number; cache_write?: number }
  limit: { context: number; output: number }
}

/** A provider in the models.dev `api.json` format. */
export interface ModelsDevProvider {
  id: string
  name: string
  npm: string
  api: string
  doc: string
  env: string[]
  models: Record<string, ModelsDevModel>
}

export interface ToModelsDevOptions {
  /** Provider id in the document. Default `waibee`. */
  id?: string
  /** Defaults to `WAIBEE_BASE_URL`. */
  baseURL?: string
}

const PACKAGE_NAME = 'waibee-ai-provider'

/**
 * The chat models of a catalog as a models.dev provider entry, so tools that read models.dev data
 * (model pickers, cost dashboards, OpenCode-style configs) can list Waibee next to other providers.
 * Prices are per million tokens. Embedding and decision models are left out: models.dev describes
 * chat models.
 */
export function toModelsDev(
  models: readonly WaibeeModel[],
  options: ToModelsDevOptions = {},
): ModelsDevProvider {
  const entries = models
    .filter((model) => model.class === 'chat')
    .map((model): [string, ModelsDevModel] => {
      const price = pricePerMillion(model.pricing)
      return [
        model.id,
        {
          id: model.id,
          name: model.name,
          attachment: model.input.some((m) => m !== 'text') || supports(model, 'pdf_input'),
          reasoning: supports(model, 'reasoning'),
          tool_call: supports(model, 'tools'),
          structured_output: supports(model, 'structured_outputs'),
          temperature: true,
          modalities: {
            input: model.input.length ? model.input : ['text'],
            output: model.output.length ? model.output : ['text'],
          },
          cost: {
            input: price.input,
            output: price.output,
            ...(price.cacheRead !== undefined && { cache_read: price.cacheRead }),
            ...(price.cacheWrite !== undefined && { cache_write: price.cacheWrite }),
          },
          limit: { context: model.contextWindow ?? 0, output: model.maxOutputTokens ?? 0 },
        },
      ]
    })
  return {
    id: options.id ?? 'waibee',
    name: 'Waibee',
    npm: PACKAGE_NAME,
    api: options.baseURL ?? WAIBEE_BASE_URL,
    doc: 'https://docs.waibee.com/router/models/',
    env: [WAIBEE_API_KEY_ENV],
    models: Object.fromEntries(entries),
  }
}
