/**
 * Provider-agnostic extractor for cache token stats.
 *
 * Vercel AI SDK v6 already normalizes most cache info into
 * `result.usage.inputTokenDetails.{cacheReadTokens,cacheWriteTokens}`. For
 * some providers/modes, however, the richer numbers only live in
 * `result.providerMetadata`. This function prefers the normalized usage when
 * provided and falls back to the raw provider-specific metadata blob.
 *
 * The `provider` argument corresponds to the `ProviderType` used in
 * `LLMProvider` (`'anthropic' | 'openai' | 'openai-compatible'`) plus the
 * friendlier preset labels (`'bailian' | 'deepseek'`). Unknown providers
 * silently return zeros so this extractor is always safe to call.
 */
export interface ExtractedCacheTokens {
  cacheCreationTokens: number
  cacheReadTokens: number
}

/**
 * Normalized usage shape from the Vercel AI SDK (subset we care about).
 * Keep it loose so we don't tightly couple to the SDK's concrete types.
 */
export interface NormalizedUsageLike {
  inputTokenDetails?: {
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
  }
}

export function extractCacheTokens(
  providerMetadata: Record<string, unknown> | undefined,
  provider: string,
  usage?: NormalizedUsageLike,
): ExtractedCacheTokens {
  // Prefer the normalized usage shape — the SDK already folded provider
  // numbers into it where possible.
  const normalizedRead = toNumber(usage?.inputTokenDetails?.cacheReadTokens)
  const normalizedWrite = toNumber(usage?.inputTokenDetails?.cacheWriteTokens)
  if (normalizedRead > 0 || normalizedWrite > 0) {
    return { cacheCreationTokens: normalizedWrite, cacheReadTokens: normalizedRead }
  }

  // Fallback: parse raw providerMetadata per-provider.
  if (!providerMetadata) {
    return { cacheCreationTokens: 0, cacheReadTokens: 0 }
  }

  switch (provider) {
    case 'anthropic': {
      // Expected shape (verified against @ai-sdk/anthropic@3.0.66):
      //   providerMetadata.anthropic = {
      //     usage: { ... raw API usage ... },
      //     cacheCreationInputTokens: number | null,
      //     ...
      //   }
      // The corresponding cacheReadInputTokens is only exposed via
      // usage.inputTokenDetails.cacheReadTokens, so we fall back to 0 here.
      const meta = providerMetadata.anthropic as
        | { cacheCreationInputTokens?: number | null; cacheReadInputTokens?: number | null }
        | undefined
      return {
        cacheCreationTokens: toNumber(meta?.cacheCreationInputTokens),
        cacheReadTokens: toNumber(meta?.cacheReadInputTokens),
      }
    }

    case 'openai':
    case 'openai-compatible':
    case 'bailian':
    case 'deepseek': {
      // Expected shape (verified against @ai-sdk/openai@3.0.50):
      //   providerMetadata.openai = {
      //     usage: { prompt_tokens_details: { cached_tokens: number } }
      //   }
      // OpenAI's automatic prompt cache only exposes a "cache read" figure —
      // there is no explicit "cache creation" counter, so writes are 0.
      const meta = providerMetadata.openai as
        | {
            usage?: {
              prompt_tokens_details?: { cached_tokens?: number | null }
              input_tokens_details?: { cached_tokens?: number | null }
            }
            promptTokens?: { cachedTokens?: number | null }
          }
        | undefined
      const cachedFromSnake =
        meta?.usage?.prompt_tokens_details?.cached_tokens ??
        meta?.usage?.input_tokens_details?.cached_tokens
      const cachedFromCamel = meta?.promptTokens?.cachedTokens
      return {
        cacheCreationTokens: 0,
        cacheReadTokens: toNumber(cachedFromSnake ?? cachedFromCamel),
      }
    }

    default:
      return { cacheCreationTokens: 0, cacheReadTokens: 0 }
  }
}

function toNumber(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return v
}
