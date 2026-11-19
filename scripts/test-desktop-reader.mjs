// macOS regression check for the packaged reader's actual rendering engine.
// Uses a temporary, nonpersistent WebKit profile and synthetic documents only.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";

if (process.platform !== "darwin") {
  console.log("Desktop WebKit regression check skipped: requires macOS and Swift.");
  process.exit(0);
}
const dist = resolve("dist");
await access(join(dist, "index.html"));
const temporary = await mkdtemp(join(tmpdir(), "knowbel-desktop-reader-"));
try {
  const fixtures = [];
  for (const [kind, fileName] of [["PDF", "fixture.pdf"], ["EPUB", "fixture.epub"], ["Web", "article.pdf"]]) {
    const pdf = await PDFDocument.create();
    const title = `${kind} cold reopen`;
    pdf.setTitle(title);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= 3; page++) pdf.addPage([400, 600]).drawText(`${kind} regression page ${page}`, { x: 40, y: 550, size: 18, font });
    const bytes = await pdf.save();
    const meta = {
      docId: createHash("sha256").update(bytes).digest("hex"), title, fileName, byteLength: bytes.length,
      addedAt: "2026-11-04T00:00:00Z", openedAt: "", pageCount: 3, lastPage: 2,
      view: { zoom: "auto", twoPage: false, continuous: true, panel: "annotations" },
      ...(kind === "Web" ? { source: { kind: "web", format: "article", url: "https://example.invalid/article", finalUrl: "https://example.invalid/article", canonicalUrl: "https://example.invalid/article", fetchedAt: "2026-11-04T00:00:00Z" } } : {}),
    };
    // Legacy EPUB and article imports store PDF bytes, with no native format.
    fixtures.push({ meta, bytes: Array.from(bytes), expect: `${kind} regression page 2`, native: false });
  }
  const bytes = new TextEncoder().encode("# Markdown cold reopen\n\nNative Markdown still works.");
  fixtures.push({ meta: {
    docId: createHash("sha256").update(bytes).digest("hex"), title: "Markdown cold reopen", fileName: "fixture.md", format: "markdown",
    byteLength: bytes.length, addedAt: "2026-11-04T00:00:00Z", openedAt: "",
    view: { zoom: "auto", twoPage: false, continuous: true, panel: "annotations" },
  }, bytes: Array.from(bytes), expect: "Native Markdown still works.", native: true });
  const htmlBytes = new TextEncoder().encode('<!doctype html><html><head><title>HTML cold reopen</title></head><body><h1 id="intro">HTML cold reopen</h1><p>Native HTML still works.</p><table><tr><th>Value</th></tr><tr><td>42</td></tr></table></body></html>');
  fixtures.push({ meta: {
    docId: createHash("sha256").update(htmlBytes).digest("hex"), title: "HTML cold reopen", fileName: "fixture.html", format: "html",
    byteLength: htmlBytes.length, addedAt: "2026-11-04T00:00:00Z", openedAt: "",
    view: { zoom: "auto", twoPage: false, continuous: true, panel: "annotations" },
  }, bytes: Array.from(htmlBytes), expect: "Native HTML still works.", native: true });
  fixtures.push({ meta: { title: "URL native import" }, native: true, expect: "Native URL imports work in WebKit.", urlImport: {
    url: "https://example.invalid/native-article",
    html: '<!doctype html><html><head><title>URL native import</title></head><body><article><h1>URL native import</h1><p>Native URL imports work in WebKit.</p>'+Array.from({length:8},()=>'<p>This article explains native reading with precise text anchors, persistent notebook writing, source citations, and comfortable typography. It contains enough context for the article extractor to identify its main content.</p>').join('')+'<p>An equation <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math> remains native.</p></article></body></html>',
  } });
  const fixturePath = join(temporary, "fixtures.json");
  await writeFile(fixturePath, JSON.stringify(fixtures));
  const script = fileURLToPath(new URL("./test-desktop-reader.swift", import.meta.url));
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn("swift", ["-swift-version", "5", "-module-cache-path", join(tmpdir(), "knowbel-reader-swift-cache"), script, dist, fixturePath], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
