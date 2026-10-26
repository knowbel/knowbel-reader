import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";

// Meta's models (Muse Spark, Muse Wonder, ...), via the OpenAI SDK pointed at
// Meta's endpoint instead of api.openai.com (per https://dev.meta.ai/docs/sdks
// — Chat Completions, streaming, and vision are all supported through the
// OpenAI SDK the same way as real OpenAI). The key (META_API_KEY, from
// https://dev.meta.ai/api-keys) is passed explicitly since the SDK only
// auto-reads OPENAI_API_KEY by default.
//
// NOTE: api.meta.ai isn't a host this code has independently verified as
// Meta's API endpoint — confirm against Meta's own current developer docs
// before relying on this in production.
const META_BASE_URL = "https://api.meta.ai/v1";

// Medium keeps dive replies quicker to start — the reasoning phase isn't
// streamed to the UI, so a long one reads as the panel hanging. A role can
// pass its own (the glossary runs at "low" — see ../models.js).
const DEFAULT_REASONING_EFFORT = "medium";

export function createMetaProvider({
  apiKey,
  model,
  createClient,
  timeoutMs,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  maxTokens,
}) {
  return createOpenAiCompatibleProvider({
    apiKey,
    baseURL: META_BASE_URL,
    model,
    label: "Meta API",
    createClient,
    timeoutMs,
    reasoningEffort,
    maxTokens,
  });
}
