import type { ProviderErrorStructure } from '@ai-sdk/openai-compatible'
import { z } from 'zod/v4'

const waibeeErrorSchema = z.object({
  error: z.union([
    z.object({
      message: z.string(),
      code: z.union([z.string(), z.number()]).nullish(),
      type: z.string().nullish(),
      extra: z.record(z.string(), z.unknown()).nullish(),
    }),
    z.string(),
  ]),
})

/** A Router error body: `{ error: { code, message, extra } }`, or `{ error: "unauthorized" }`. */
export type WaibeeErrorData = z.infer<typeof waibeeErrorSchema>

/** Router error codes that a retry cannot fix even though their HTTP status looks transient. */
const FINAL_CODES = new Set(['api_key_limit_exceeded', 'insufficient_funds'])

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503])

/** The error code of a Router error body, e.g. `model_not_found`. */
export const waibeeErrorCode = (data: WaibeeErrorData): string | undefined =>
  typeof data.error === 'string' ? data.error : (data.error.code?.toString() ?? undefined)

/**
 * How Router errors read: the message carries the code, and only transient failures (408, 429,
 * 5xx) are retried, except a spent key limit or balance, which a retry cannot fix.
 */
export const waibeeErrorStructure: ProviderErrorStructure<WaibeeErrorData> = {
  errorSchema: waibeeErrorSchema,
  errorToMessage: (data) => {
    if (typeof data.error === 'string') return data.error
    const code = waibeeErrorCode(data)
    return code ? `${code}: ${data.error.message}` : data.error.message
  },
  isRetryable: (response, data) => {
    const code = data && waibeeErrorCode(data)
    if (code && FINAL_CODES.has(code)) return false
    return TRANSIENT_STATUSES.has(response.status)
  },
}
