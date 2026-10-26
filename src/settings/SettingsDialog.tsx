import { useEffect, useRef, useState } from "react";
import { KeyRound, Settings, X } from "lucide-react";
import { openExternal } from "../library/desktop";
import {
  PROVIDERS,
  canStoreKeys,
  loadAiChoice,
  providerInfo,
  readApiKey,
  removeApiKey,
  saveAiChoice,
  saveApiKey,
  type AiChoice,
  type ProviderId,
} from "./aiSettings";

// Settings: which model provider the AI study tools use, the reader's API key
// for it (kept in the system keychain, see ./aiSettings.ts), and optionally
// which models. Laid out like the other dialogs (the url-dialog styles, see
// src/web/AddFromUrlDialog.tsx). Nothing changes until Save.

// What's in the keychain for the provider shown: still being read, nothing,
// a key, or an error reading it.
type SavedKey = { kind: "loading" } | { kind: "none" } | { kind: "saved"; key: string } | { kind: "error"; message: string };

function keyEnding(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "";
}

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [choice, setChoice] = useState<AiChoice>(() => loadAiChoice() ?? { provider: PROVIDERS[0].id, models: {} });
  const [savedKey, setSavedKey] = useState<SavedKey>({ kind: canStoreKeys ? "loading" : "none" });
  // The key typed in, or null while keeping the saved one.
  const [newKey, setNewKey] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  const provider = providerInfo(choice.provider);
  const models = choice.models[choice.provider] ?? {};

  useEffect(() => {
    if (!canStoreKeys) return;
    let cancelled = false;
    setSavedKey({ kind: "loading" });
    setNewKey(null);
    setRemoving(false);
    readApiKey(choice.provider).then(
      (key) => !cancelled && setSavedKey(key ? { kind: "saved", key } : { kind: "none" }),
      (err) => !cancelled && setSavedKey({ kind: "error", message: String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [choice.provider]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const setModel = (field: "model" | "fastModel", value: string) =>
    setChoice((current) => ({
      ...current,
      models: { ...current.models, [current.provider]: { ...current.models[current.provider], [field]: value.trim() || undefined } },
    }));

  const editingKey = savedKey.kind !== "saved" || newKey !== null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (canStoreKeys) {
        if (newKey?.trim()) await saveApiKey(choice.provider, newKey.trim());
        else if (removing) await removeApiKey(choice.provider);
      }
      saveAiChoice(choice);
      onClose();
    } catch (err) {
      setError(`Couldn't save the key to the keychain: ${err}`);
      setSaving(false);
    }
  };

  return (
    <div className="url-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="url-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <header className="url-dialog-header">
          <Settings width={16} height={16} aria-hidden="true" />
          <h2 id="settings-dialog-title">Settings</h2>
          <button type="button" className="library-icon-button" onClick={onClose} title="Close">
            <X width={16} height={16} />
          </button>
        </header>

        <form
          className="url-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="url-dialog-hint">
            Deep Dive, Ask and the glossary use a model provider's API with your own key. Usage is billed to your account with
            that provider.
          </p>

          <label className="settings-field">
            <span className="settings-label">Provider</span>
            <select
              className="url-dialog-input"
              value={choice.provider}
              onChange={(event) => setChoice((current) => ({ ...current, provider: event.target.value as ProviderId }))}
            >
              {PROVIDERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="settings-field">
            <span className="settings-label">API key</span>
            {!canStoreKeys ? (
              <p className="url-dialog-hint">
                The browser version reads keys from the server's <code>.env</code> file: set <code>{provider.envKey}</code> there.
              </p>
            ) : savedKey.kind === "loading" ? (
              <p className="url-dialog-hint">Checking the keychain…</p>
            ) : !editingKey ? (
              <div className="settings-saved-key">
                <KeyRound width={14} height={14} aria-hidden="true" />
                <span>
                  {removing ? "Will be removed when you save" : `Saved in your keychain ${keyEnding(savedKey.kind === "saved" ? savedKey.key : "")}`}
                </span>
                {removing ? (
                  <button type="button" className="url-dialog-button" onClick={() => setRemoving(false)}>
                    Keep
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="url-dialog-button"
                      onClick={() => {
                        setNewKey("");
                        requestAnimationFrame(() => keyInputRef.current?.focus());
                      }}
                    >
                      Replace
                    </button>
                    <button type="button" className="url-dialog-button" onClick={() => setRemoving(true)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                <input
                  ref={keyInputRef}
                  className="url-dialog-input"
                  type="password"
                  value={newKey ?? ""}
                  onChange={(event) => setNewKey(event.target.value)}
                  placeholder={`Paste your ${provider.label} API key`}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="url-dialog-hint">
                  Kept in your system keychain, and sent only to {provider.label}.
                  {savedKey.kind === "saved" ? (
                    <>
                      {" "}
                      <button type="button" className="settings-link" onClick={() => setNewKey(null)}>
                        Keep the saved key
                      </button>
                    </>
                  ) : null}
                  {provider.keyUrl ? (
                    <>
                      {" "}
                      <button type="button" className="settings-link" onClick={() => void openExternal(provider.keyUrl!)}>
                        Get a key
                      </button>
                    </>
                  ) : null}
                </p>
                {savedKey.kind === "error" ? (
                  <p className="url-dialog-error" role="alert">
                    Couldn't read the keychain: {savedKey.message}
                  </p>
                ) : null}
              </>
            )}
          </div>

          <details className="settings-models">
            <summary>Models</summary>
            <label className="settings-field">
              <span className="settings-label">Deep Dive and Ask</span>
              <input
                className="url-dialog-input"
                value={models.model ?? ""}
                onChange={(event) => setModel("model", event.target.value)}
                placeholder={provider.model}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="settings-field">
              <span className="settings-label">Quick meanings and glossary</span>
              <input
                className="url-dialog-input"
                value={models.fastModel ?? ""}
                onChange={(event) => setModel("fastModel", event.target.value)}
                placeholder={provider.fastModel}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <p className="url-dialog-hint">Leave blank for the defaults shown.</p>
          </details>

          {error ? (
            <p className="url-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="url-dialog-actions">
            <button type="button" className="url-dialog-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="url-dialog-button is-primary" disabled={saving}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
