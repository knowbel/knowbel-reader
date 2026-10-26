import { invoke, isTauri } from "@tauri-apps/api/core";

// The reader's own AI provider, API key and models (Settings). The choice of
// provider and models is kept in localStorage; the keys in the system
// keychain via the desktop app's commands (src-tauri/src/lib.rs). Both are
// sent as headers with each AI request to the local server (server/app.js),
// so no build of the app carries a key. Until settings are first saved,
// nothing is sent and the server's .env configuration applies.

export type ProviderId = "meta" | "anthropic" | "openai" | "google";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  keyUrl?: string; // where to create a key
  model: string; // the default main model: Deep Dive and Ask
  fastModel: string; // the default fast model: quick meanings and the glossary
  envKey: string; // the .env variable the server falls back to
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "meta",
    label: "Meta",
    keyUrl: "https://dev.meta.ai/api-keys",
    model: "muse-spark-1.3-contributor",
    fastModel: "muse-spark-1.3-contributor",
    envKey: "META_API_KEY",
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    model: "claude-sonnet-5",
    fastModel: "claude-haiku-4-5-20251001",
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    model: "gpt-5",
    fastModel: "gpt-5-mini",
    envKey: "OPENAI_API_KEY",
  },
  {
    id: "google",
    label: "Gemini (Google)",
    keyUrl: "https://aistudio.google.com/apikey",
    model: "gemini-3-pro",
    fastModel: "gemini-3-flash",
    envKey: "GOOGLE_API_KEY",
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

// Models left blank use the provider's defaults above.
export interface AiChoice {
  provider: ProviderId;
  models: Partial<Record<ProviderId, { model?: string; fastModel?: string }>>;
}

const STORAGE_KEY = "knowbel.aiSettings";

export function loadAiChoice(): AiChoice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved?.provider === "muse-spark") saved.provider = "meta"; // its name before Meta had other models
    if (!saved || !PROVIDERS.some((provider) => provider.id === saved.provider)) return null;
    return { provider: saved.provider, models: saved.models && typeof saved.models === "object" ? saved.models : {} };
  } catch {
    return null;
  }
}

export function saveAiChoice(choice: AiChoice) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  cachedHeaders = null;
}

// Keys live in the system keychain, which only the desktop app can reach.
// The browser version reads them from the server's .env instead.
export const canStoreKeys = isTauri();

export async function readApiKey(provider: ProviderId): Promise<string | null> {
  if (!canStoreKeys) return null;
  return invoke<string | null>("get_api_key", { provider });
}

export async function saveApiKey(provider: ProviderId, key: string) {
  await invoke("set_api_key", { provider, key });
  cachedHeaders = null;
}

export async function removeApiKey(provider: ProviderId) {
  await invoke("delete_api_key", { provider });
  cachedHeaders = null;
}

// Read once and reused, so the keychain isn't asked on every request;
// dropped whenever the settings change.
let cachedHeaders: Promise<Record<string, string>> | null = null;

async function buildHeaders(): Promise<Record<string, string>> {
  const choice = loadAiChoice();
  if (!choice) return {};
  const info = providerInfo(choice.provider);
  const models = choice.models[choice.provider] ?? {};
  let key: string | null;
  try {
    key = await readApiKey(choice.provider);
  } catch (error) {
    throw new Error(`Couldn't read your ${info.label} API key from the keychain: ${error}`);
  }
  return {
    "X-AI-Provider": choice.provider,
    "X-AI-Model": models.model || info.model,
    "X-AI-Fast-Model": models.fastModel || info.fastModel,
    ...(key ? { "X-AI-Key": key } : {}),
  };
}

export function aiRequestHeaders(): Promise<Record<string, string>> {
  cachedHeaders ??= buildHeaders().catch((error) => {
    cachedHeaders = null; // try the keychain again next time
    throw error;
  });
  return cachedHeaders;
}
