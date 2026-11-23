// Start Vite on 127.0.0.1:5178 first. The fixture .app, source files and
// library are temporary; the user's installed app and library are untouched.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

if (process.platform !== "darwin") {
  console.log("File association check skipped: requires macOS.");
  process.exit(0);
}
const build = spawnSync("cargo", ["build", "--offline", "--manifest-path", "src-tauri/Cargo.toml", "--example", "file-open-smoke"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const root = await mkdtemp(join(tmpdir(), "knowbel-file-open-"));
const bundle = join(root, "File Open Smoke.app");
try {
  const contents = join(bundle, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  const executable = join(contents, "MacOS", "file-open-smoke");
  await copyFile(resolve("src-tauri/target/debug/examples/file-open-smoke"), executable);
  await chmod(executable, 0o755);
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>file-open-smoke</string>
    <key>CFBundleIdentifier</key><string>com.knowbelreader.file-open-smoke</string>
    <key>CFBundleName</key><string>File Open Smoke</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSUIElement</key><true/>
    <key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleTypeExtensions</key><array><string>md</string><string>html</string><string>pdf</string></array></dict></array>
  </dict></plist>`);
  await writeFile(join(root, "Cold #1 日本語.md"), "# Cold launch document\n\nOpened from Finder with spaces, punctuation and Unicode.");
  await writeFile(join(root, "Warm document.HTML"), "<!doctype html><html><head><title>Warm HTML document</title></head><body><h1>Warm HTML document</h1><p>Opened while the reader was running.</p></body></html>");
  await writeFile(join(root, "Broken.pdf"), "This is not a PDF");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([400, 600]).drawText("File association PDF", { x: 40, y: 500, font, size: 18 });
  await writeFile(join(root, "Paper.pdf"), await pdf.save());
  const launch = spawnSync("open", ["-n", "-g", "-a", bundle, join(root, "Cold #1 日本語.md"), "--args", root], { encoding: "utf8" });
  if (launch.status !== 0) throw new Error(`Couldn’t launch the fixture app: ${launch.stderr}`);
  let result;
  for (let i = 0; i < 600; i++) {
    try { result = await readFile(join(root, "result.txt"), "utf8"); break; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  if (result !== "PASS") throw new Error(result ?? "File-open smoke check timed out");
  console.log("PASS: macOS cold/warm opens, Unicode paths, active notebook saves, deduplication, batch failure recovery, and PDF rendering.");
} finally {
  // Kill only a leftover process from this temporary executable, then remove
  // its LaunchServices entry so no fixture app remains in Open With menus.
  spawnSync("pkill", ["-f", `${bundle}/Contents/MacOS/file-open-smoke`]);
  spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", bundle]);
  await rm(root, { recursive: true, force: true });
}
