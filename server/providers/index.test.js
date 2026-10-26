import test from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "./index.js";

test("anthropic requires ANTHROPIC_API_KEY", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => createProvider("anthropic", { model: "claude-sonnet-5" }), /ANTHROPIC_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test("openai requires OPENAI_API_KEY", () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => createProvider("openai", { model: "gpt-5" }), /OPENAI_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});

test("google requires GOOGLE_API_KEY", () => {
  const prev = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    assert.throws(() => createProvider("google", { model: "gemini-3-pro" }), /GOOGLE_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.GOOGLE_API_KEY = prev;
  }
});

test("meta requires META_API_KEY", () => {
  const prev = { META_API_KEY: process.env.META_API_KEY, MUSE_SPARK_API_KEY: process.env.MUSE_SPARK_API_KEY };
  delete process.env.META_API_KEY;
  delete process.env.MUSE_SPARK_API_KEY;
  try {
    assert.throws(() => createProvider("meta", { model: "muse-spark-1.3" }), /META_API_KEY/);
  } finally {
    for (const [name, value] of Object.entries(prev)) if (value !== undefined) process.env[name] = value;
  }
});

test("meta's old name and key variable from when it was muse-spark still work", () => {
  const prev = { META_API_KEY: process.env.META_API_KEY, MUSE_SPARK_API_KEY: process.env.MUSE_SPARK_API_KEY };
  delete process.env.META_API_KEY;
  process.env.MUSE_SPARK_API_KEY = "legacy-key";
  try {
    assert.equal(typeof createProvider("muse-spark", { model: "muse-spark-1.3" }).complete, "function");
    assert.equal(typeof createProvider("meta", { model: "muse-wonder" }).complete, "function");
  } finally {
    delete process.env.MUSE_SPARK_API_KEY;
    for (const [name, value] of Object.entries(prev)) if (value !== undefined) process.env[name] = value;
  }
});

test("an unknown provider name throws a clear error", () => {
  assert.throws(() => createProvider("bogus", { model: "x" }), /Unknown provider "bogus"/);
});

test("a key from the app's AI settings is used in place of the .env one", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(typeof createProvider("anthropic", { model: "claude-sonnet-5", apiKey: "sk-ant-test" }).streamReply, "function");
    assert.throws(() => createProvider("anthropic", { model: "claude-sonnet-5" }), /Add one in Settings/);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});
