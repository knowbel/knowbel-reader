import { createAnthropicApiProvider } from "./anthropicApi.js";
import { createOpenAiProvider } from "./openai.js";
import { createGoogleProvider } from "./google.js";
import { createMetaProvider } from "./meta.js";

export const PROVIDER_NAMES = ["meta", "anthropic", "openai", "google"];

// Meta's provider was "muse-spark", with MUSE_SPARK_API_KEY, when that was
// its only model. Both still work.
const PROVIDER_ALIASES = { "muse-spark": "meta" };

const KEY_ENV = {
  anthropic: { name: "ANTHROPIC_API_KEY", label: "Claude" },
  openai: { name: "OPENAI_API_KEY", label: "OpenAI" },
  google: { name: "GOOGLE_API_KEY", label: "Gemini" },
  meta: { name: "META_API_KEY", label: "Meta", legacyName: "MUSE_SPARK_API_KEY" },
};

// The key the reader gave in the app's AI settings, else the .env one.
function resolveKey(provider, apiKey) {
  if (apiKey) return apiKey;
  const { name, label, legacyName } = KEY_ENV[provider];
  const value = process.env[name] || (legacyName && process.env[legacyName]);
  if (!value) {
    throw new Error(`No ${label} API key. Add one in Settings, or set ${name} in your .env file.`);
  }
  return value;
}

// Builds a { streamReply, complete } provider for one dive role. `name`
// selects the backend; each takes its model id via `model` (from .env, read
// by ../models.js one role at a time, or from the app's AI settings).
// `apiKey` falls back to the provider's .env key when not given.
// `reasoningEffort` is only honored by meta, whose default otherwise
// applies. `maxTokens` caps the reply's output tokens on every provider.
export function createProvider(requested, { model, reasoningEffort, maxTokens, apiKey }) {
  const name = PROVIDER_ALIASES[requested] ?? requested;
  if (!PROVIDER_NAMES.includes(name)) {
    throw new Error(`Unknown provider "${name}". Supported providers: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const key = resolveKey(name, apiKey);
  switch (name) {
    case "anthropic":
      return createAnthropicApiProvider({ apiKey: key, model, maxTokens });
    case "openai":
      return createOpenAiProvider({ apiKey: key, model, maxTokens });
    case "google":
      return createGoogleProvider({ apiKey: key, model, maxTokens });
    case "meta":
      return createMetaProvider({ apiKey: key, model, reasoningEffort, maxTokens });
  }
}
