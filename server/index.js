import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildApp } from "./app.js";
import { createDiveModels } from "./models.js";
import { createReferenceLookup } from "./reference.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Provider API keys and DIVE_/QUICK_ PROVIDER/MODEL overrides live in .env
// (the desktop app's AI settings can override them per request, see ./app.js).
// In source layout that's next to package.json, one directory up from this
// file; the bundled desktop build (see scripts/build-server.mjs) flattens
// everything into one directory, so it copies .env alongside the bundled
// server.mjs instead — try that layout first, then fall back to the source
// one.
for (const candidate of [path.join(__dirname, ".env"), path.join(__dirname, "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    // try the next candidate — fine if neither exists; a provider missing its key fails with a clear error
  }
}

const PORT = process.env.PORT || 4300;
// Only this machine can reach the server: it spends the reader's API keys
// and fetches pages on their behalf. HOST=0.0.0.0 opens it to the network,
// for running the browser version on a server you trust.
const HOST = process.env.HOST || "127.0.0.1";

const app = buildApp({ models: createDiveModels(), lookupReference: createReferenceLookup() });

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "dist")));
}

app.listen(PORT, HOST, () => {
  console.log(`Deep Dive API listening on http://${HOST}:${PORT}`);
});
