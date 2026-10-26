import { createProvider } from "./providers/index.js";

// Dive and quick-meaning can each run through a different provider/model —
// e.g. dive on Claude for quality, quick meanings on a cheaper/faster
// model. Set DIVE_PROVIDER/DIVE_MODEL and QUICK_PROVIDER/QUICK_MODEL in
// .env per role. Supported providers: anthropic, openai, google,
// meta (see ./providers/index.js). With nothing set, every role uses Muse
// Spark through Meta's API (META_API_KEY); the glossary role runs it at low
// reasoning effort since it must answer in real time.
//
// maxTokens caps each role's reply (override with {ROLE}_MAX_TOKENS). The
// caps are a backstop against runaway output, not the way answers are kept
// short — prompts do that. They leave room for a reasoning model's hidden
// reasoning, which most providers count against the same cap.
const ROLE_DEFAULTS = {
  DIVE: { provider: "meta", model: "muse-spark-1.3-contributor", maxTokens: 1024 },
  QUICK: { provider: "meta", model: "muse-spark-1.3-contributor", maxTokens: 512 },
  GLOSSARY: { provider: "meta", model: "muse-spark-1.3-contributor", reasoningEffort: "low", maxTokens: 1024 },
};

// Ask (whole-document questions) answers like a dive does, so unless
// ASK_PROVIDER/ASK_MODEL say otherwise it uses the dive role's provider and
// model — including any DIVE_ overrides in .env.
const INHERITS = { ASK: "DIVE" };

export function roleConfig(role, env = process.env) {
  const parent = INHERITS[role];
  const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS[parent];
  const maxTokens = Number.parseInt(env[`${role}_MAX_TOKENS`] ?? "", 10);
  return {
    provider: env[`${role}_PROVIDER`] || (parent && env[`${parent}_PROVIDER`]) || defaults.provider,
    model: env[`${role}_MODEL`] || (parent && env[`${parent}_MODEL`]) || defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    maxTokens: maxTokens > 0 ? maxTokens : defaults.maxTokens,
  };
}

// The provider and model for one role: from .env, or — when the reader chose
// them in the app's AI settings (sent with each request, see ./app.js) —
// their main model for dives and Ask, their fast model for quick meanings
// and the glossary. The role's reasoning effort and output cap apply either
// way.
const FAST_ROLES = new Set(["QUICK", "GLOSSARY"]);

function roleProvider(role, settings) {
  const { provider, model, ...options } = roleConfig(role);
  if (!settings) return createProvider(provider, { model, ...options });
  return createProvider(settings.provider, {
    ...options,
    model: FAST_ROLES.has(role) ? settings.fastModel || settings.model : settings.model,
    apiKey: settings.apiKey,
  });
}

// One line per model call with its token counts — how the context budgets
// are checked in practice. On in development; LOG_USAGE=1 turns it on in a
// production (packaged) server too.
export function usageLogger(role, { env = process.env, log = console.log } = {}) {
  if (env.NODE_ENV === "production" && env.LOG_USAGE !== "1") return undefined;
  return ({ inputTokens, cachedInputTokens, outputTokens }) => {
    const cached = cachedInputTokens ? ` (cached ${cachedInputTokens})` : "";
    log(`[usage] ${role}: in ${inputTokens}${cached}, out ${outputTokens}`);
  };
}

// A dive request's per-question system text (systemSuffix): a separate
// block for a provider that caches the part before it, otherwise appended.
export function withSystemSuffix(provider, { system, systemSuffix, ...rest }) {
  if (!systemSuffix) return { system, ...rest };
  return provider.supportsSystemSuffix ? { system, systemSuffix, ...rest } : { system: `${system}\n\n${systemSuffix}`, ...rest };
}

// Each role's provider is built on first use rather than at startup, so a
// missing key fails that role's requests (with that error) instead of
// stopping the server from starting — a release build has no .env at all.
function roleModels(settings) {
  const providers = {};
  const provider = (role) => (providers[role] ??= roleProvider(role, settings));
  const onUsage = {
    dive: usageLogger("dive"),
    ask: usageLogger("ask"),
    quick: usageLogger("quick"),
    glossary: usageLogger("glossary"),
  };
  return {
    streamDiveReply: async (args) => {
      const dive = provider("DIVE");
      return dive.streamReply({ ...withSystemSuffix(dive, args), onUsage: onUsage.dive });
    },
    streamAskReply: async (args) => provider("ASK").streamReply({ ...args, onUsage: onUsage.ask }),
    quickAnswer: async (args) => provider("QUICK").complete({ ...args, onUsage: onUsage.quick }),
    streamGlossary: async (args) => provider("GLOSSARY").streamReply({ ...args, onUsage: onUsage.glossary }),
  };
}

// The .env configuration, plus `withSettings` for a request that carries the
// reader's own provider, key and models. Those are kept for reuse (a key
// typically stays the same for the whole session), a handful at most.
const MAX_SETTINGS_CACHED = 8;

export function createDiveModels() {
  const fromEnv = roleModels(null);
  const cached = new Map();
  return {
    ...fromEnv,
    withSettings(settings) {
      if (!settings) return fromEnv;
      const id = JSON.stringify([settings.provider, settings.apiKey, settings.model, settings.fastModel]);
      let models = cached.get(id);
      if (!models) {
        if (cached.size >= MAX_SETTINGS_CACHED) cached.clear();
        models = roleModels(settings);
        cached.set(id, models);
      }
      return models;
    },
  };
}
