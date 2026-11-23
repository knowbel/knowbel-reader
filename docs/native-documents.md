# Native document engine

`src/document/` owns the common reader for reflowable formats. Markdown and
HTML files have native adapters. Existing PDFs, converted EPUBs and saved web articles keep
their PDF rendering and source storage. Existing annotations migrate into the shared Notebook on first open.
New URL articles save a native HTML snapshot; direct PDF and EPUB URLs retain
their existing handling. Previously saved PDF articles keep their annotations;
fetching a fresh copy creates a separate native document.

## Adding another format

Implement a `DocumentAdapter` and register it in `document/registry.ts` with
its extensions, MIME types and lazy loader. Its parser returns a prepared
`FlowDocument`, built with `prepareDocument()`. An adapter supplies:

- An inert semantic tree using the allowed `FlowNode` tags, text, math and
  images. Never put arbitrary source HTML or event handlers into the tree.
- The original document ID and title, and content blocks in reading order.
- Optional bundled image assets, keyed by internal relative paths.

The shared preparation pass assigns text offsets, content IDs, the heading
outline, and image/table objects. The shared view and engine then provide
selection, highlights, comments, sticky notes, glossary marks and tooltips,
search, reading position, internal heading links, citation jumps and previews,
and the text interface for Ask and Deep Dive. New adapters do not implement
these features. File import and reader routing use the format registration.
New web import paths should save their native source with
`importDocument(..., { format })`, then open the same reader.

EPUB can map its spine to blocks and supply the book's images as assets. HTML's
adapter uses the existing `htmlparser2` parser without a live DOM, allowlists
semantic nodes, drops executable/hidden content, and resolves relative resources
against a safe HTTP(S) base when present. Local images remain placeholders.
Custom IDs and named anchors retain internal links, including footnotes.
Inline targets use an inert `span` node that retains only the target ID. Source
stylesheets and scripts are not part of the interchange format. Add new
semantic nodes deliberately when a format requires them.

## Text and anchors

Canonical text is generated once from the semantic tree. Text leaves record
UTF-16 offsets into their containing block. Inline markup contributes no
characters; math contributes its TeX source once; images contribute alt text;
task lists include completion state; tables use tab/newline separators.
Source-file offsets are optional provenance and are never DOM-text offsets.
Treat prepared models as immutable: engines and anchor lookups cache indices.

Text anchors record start/end block IDs and offsets, the quotation, and its
prefix/suffix. A DOM selection maps through explicitly tagged text runs.
KaTeX is atomic, so its visual and accessibility trees cannot duplicate text
or shift subsequent offsets. Ranges may cross inline elements and blocks.
Collapsed anchors represent reading positions. Image/table anchors identify
semantic objects, including images with no alt text. No native annotation
stores viewport rectangles.

Exact anchors are verified against their quotations. Recovery requires one
unambiguous context match; unresolved notes are retained in Notebook.
The source hash identifies a document. An edited source imports as another
document; automatic annotation migration between revisions is not implemented.

## Shared study tools

`TextProvider` in `text/documentText.ts` lets native engines share the existing
chunking, BM25 retrieval, scope inference, glossary jobs and citation protocol.
Its legacy `pageNumber`/`numPages` fields mean ordered text-unit ordinals for
native content. They are an internal compatibility boundary, not generated
pages; no PDF geometry is fabricated. Native sources and glossary references
persist a semantic `location` and section `locationLabel`. Native page-number
scopes are disabled. Citation chips, previews and history use section labels.

`navigation/ReaderNavigator.tsx` owns the floating bottom-center navigation,
idle fade, scroll/hover/keyboard reveal, selection-drag hiding and jump-history
menu for both readers. `PageNavigator` supplies PDF page controls;
`SectionNavigator` supplies native heading selection and previous/next sections.
Both support **⌥⌘G** to focus their location control and **⌘← / ⌘→** to retrace
jumps. Native history retains semantic anchors, including when skipping several
history entries; section navigation never exposes internal text-unit numbers.

Native Deep Dives persist as study threads, preserving existing conversation
and Notebook identities. `nativeDives.ts` projects them into the shared
multi-pane Deep Dive view. The request job reuses PDF's source retrieval,
stable source registry, prompts, suggestions, nested context and history.
Tree maps and summaries use the shared components and semantic section labels.
The source pane stays mounted while moving between source/answer and
parent/child answer pairs. Per-thread cancellation keeps parallel branches
independent. Images use the shared image-attachment path only when selected
for a question; tables already supply canonical searchable text.

Numbered figure/theorem/equation references and bibliography citations use
the shared reference detector over canonical text. They support native
previews and source jumps without introducing PDF geometry.

Area selection captures pixels on demand with the existing lazy screenshot
dependency. The clone retains block containment to match visible layout;
the saved Notebook asset is attached to a semantic text anchor. Coordinates
exist only during capture. Area images can be reused in questions and dives.
Annotated HTML export includes source marks, diagrams, MathML and Notebook;
Print / Save as PDF uses the system print pipeline with an isolated, immutable
print copy. This introduces no PDF conversion engine on the native read path.

## Shared Notebook

`notebook/NotebookDock.tsx` supplies the same rich notebook for both readers.
`notebook/model.ts` owns the versioned JSON envelope, source captures, rich
bodies, sections, deletion records, and AI provenance. Tiptap edits only the
active entry; saved entries use a small memoized renderer and a shared lazy
visibility observer. Original excerpts remain separate from editable prose.

`NotebookStore` is the canonical owner after migration. It derives native,
PDF, and dive annotation views without maintaining a second editable comment
collection. Ordinary writing does not notify the source renderer; sticky
writing also refreshes its source presentation. Removing a mark keeps its
capture and writing; deleting an entry moves it to recoverable Trash.

The native reader supplies exact semantic anchors, section labels, object
snapshots, source jumps, and AI attachments. The PDF reader supplies geometry
and page labels. New native adapters inherit this notebook through
`NativeReader`. Image captures save an asset and tables retain a rich semantic
snapshot. Existing `annotations/model.ts` projections remain pure compatibility
helpers, with no separate Annotations UI.

Notebook stays mounted beside navigation panels and Deep Dive. Ask uses an
optional lower area; its drafts and attachments remain scoped to the active
conversation. Inline question nodes bind streaming to document, entry, and
exchange identity. Regeneration is a proposal, interrupted jobs require an
explicit retry, and source citation nodes retain resolved snapshots rather
than relying on request-local labels such as S1.

## Storage and performance

Both backends retain original Markdown and HTML bytes. Desktop native sources use
`source.md` and `source.html` (future native EPUB uses its own extension); old PDF paths
remain `source.pdf`. `notebook`, `notebookAssets`, and `readerDrafts` are per-document
data kinds included in notes backups. Legacy collections remain migration input
and are no longer actively written after migration. Reimporting source content relinks restored notes. Saves
are debounced, ordered and flushed before switching documents; failures keep
the native reader open for retry.

The library, native reader, PDF reader, parsers, study panels and math renderer
load on demand. Markdown does not load PDF.js, its worker or conversion fonts.
The PDF reader's lazy loader explicitly awaits the PDF.js core before loading
the viewer: `pdf_viewer.mjs` reads `globalThis.pdfjsLib` during evaluation.
Loading those chunks together can fail on a cold WebKit library reopen;
importing a new PDF first masks the error by initializing the core for metadata.
The parser dependencies were already present through `react-markdown` and
the web test tooling; native adapters declare them directly.
The bundler selects the existing entity decoder's table-based implementation,
because its smaller DOM-based browser entry cannot run inside a worker.

URL imports reuse article extraction, cleanup, math normalization, figure
capture and image downloading through `web/convert.ts`'s `prepareArticle()`.
`web/snapshot.ts` embeds downloaded raster images and captured CSS/SVG figures
in one HTML source. The original URL, authors and fetch date live in metadata;
the visible source header retains the title, author, publication date and URL.
The fetch date is excluded from source bytes, so identical text and images
deduplicate across days. Changed snapshots get a new identity. Source equations
use the preparation pass's `data-kr-math` nodes, mapped once to native math.
PDF metadata and conversion dependencies stay lazy on this path.

`src-tauri/src/browser.rs` provides a child system WebView **inside the reader's
existing window**. Desktop URL documents default to Page mode, preserving the
original site's markup, stylesheets, scripts, animations and interactive controls.
Study text remains an independent, saved semantic source for offline reading and
precise study anchors. A flattened article is not browser-equivalent content.
No claim of identical behavior across every browser, viewport, website version or
access restriction is made.

Page mode also works offline on macOS from a saved web archive
(`library/<docId>/page.webarchive`, `source.pageArchivedAt` in metadata). WebKit's
`createWebArchiveData` stores the *current DOM* plus every loaded subresource, so
replaying it would run the page's scripts a second time over their own output
(duplicated inserted content, animations resuming mid-state). `page_archive` in
`browser.rs` therefore replaces the archive's main resource with the server's
original document, which `page_bridge.js` fetches from inside the page (same
session, HTTP cache) with a `fetch` captured before site scripts run. Replay then
behaves like a fresh load served from the archive, with no request to the site.
Requests a script makes while running still need the network.

WebKit will not navigate a view showing an archive back to the network through
`loadRequest` (in-page link navigation still works), so `PageState` remembers an
archived view and `open_import_browser` replaces it when the live page is
requested.

WebKit's "navigation finished" event arrives around the `load` event, before a
modern site's hydration, code it loads on demand, data requests and web fonts.
So `page_bridge.js` reports `settled` itself: the document has loaded, fonts are
ready, no `fetch`/XHR request (counted by wrapping both before site scripts run)
or eager image is pending, and no resource finished for one second. Pages that
never go quiet report after 30 seconds. The signal uses the toolbar's action queue
and needs no trusted event, since it only prompts a save. The reader saves the
archive on that signal when none exists or it is over a day old, and refreshes it
on leaving after 30 seconds of reading so lazily loaded images are included; no
load event covers those. It opens the saved
page when the system reports no connection, and offers it when the live page
hasn't loaded after 15 seconds. Archives are bounded at 128 MiB, are binary
property lists, and are excluded from notes backups.

No browser engine, driver or binary is added. The existing Tauri dependency
enables its `unstable` feature for the child-WebView API. The archive code
declares `objc2-web-kit`, `objc2-foundation`, `block2`, `plist` and `base64`
directly; all are already in Tauri's dependency tree at the same versions. Only the main
**webview** can invoke capture/control/print or keychain commands. Capabilities are
scoped with `webviews: ["main"]`, rather than granting every child in the main
window filesystem/opener permissions. Navigation allows
HTTP(S) without embedded credentials, denies local/custom protocols, and
keeps popups in the same embedded pane. Verification is completed
by the user, never automatically bypassed.

`browser_capture.js` snapshots rendered DOM, resolves actual image sources,
captures canvases and bounded same-origin/blob images, and freezes SVG
presentation. Executable scripts, import controls, inputs and editable fields
are excluded. Capture is bounded by node/image/HTML limits, a Rust result-size
limit, a callback timeout, and a final URL check. A blocked fetch opens inline;
capture retries while the page loads, and saves the study copy automatically.
The existing article preparation path
then sanitizes, embeds images and persists the native source without fetching
the blocked page again. The running child view transfers to the reader without
reloading it. Owner tokens fence placement, capture, action and cleanup commands,
so an old import pane cannot close a newer document. An unclaimed handoff expires.
Cancel and unmount close the child, with an incognito profile discarded on close.

`web/EmbeddedPage.tsx` observes the source slot's bounds and visibility, including
Notebook resizing and portal moves during Deep Dive. Main-window menus temporarily
occlude the native child so controls remain accessible. The content is not loaded
in an iframe and does not depend on a site's frame-embedding policy.
Switching to Study text hides the running page without reloading it; zoom applies
to the native child, and its scroll position is saved/restored independently of
the semantic reading position. A saved Study text preference does not fetch the
live page until the user chooses Page.
`web/selection.ts` maps live quotations and surrounding context to saved semantic
anchors; ambiguous or changed text is rejected. Matching ignores whitespace and
invisible characters on both sides, since a minified page has no separators
between blocks. Page actions reuse Notebook, Ask, Glossary and Deep Dive.

Native HTML cannot draw over the child view, so `page_bridge.js` renders the
selection toolbar inside the page (a closed shadow root mirroring
`HighlightToolbar`). Trusted clicks queue an action and navigate to a reserved
sentinel URL; `browser.rs` cancels that navigation and emits
`knowbel-page-interaction`, and `NativeReader` drains the queue with
`read_page_interaction`. The reader also forwards its tool and pen, so the
Highlight and Note tools act on the page; Area capture switches to Study text.
Keyboard shortcuts typed in the page are forwarded to the reader.

Native CSS Highlight ranges paint saved quotations, using each anchor's prefix
and suffix to disambiguate repeated phrases (preferring the article or main
element on a tie), without changing the site's DOM structure. Styles live in a
constructed stylesheet, which a site's inline-style policy does not block. The
bridge repaints when the site replaces the marked text, for example during
hydration. Citation/source jumps scroll and flash the matching original text;
a passage the live page lacks opens in Study text. Moving to another URL
prevents notes from being attached to the previous document, and its marks are
not painted there.

Direct video/audio and allowlisted YouTube/Vimeo embeds survive preparation.
Media has no player or network load until explicitly activated. Other embeds
retain links. Inline SVG in local HTML becomes a sanitized, scoped image asset;
scripts, external references and HTML inside SVG are removed. Source HTML is
still preserved byte for byte. Relative local resources require an included
asset or an HTTP(S) base; opening a single file grants no sibling-file access.

Documents of at least 256 KiB parse in a short-lived module worker. Webviews
that cannot start module workers use the same parser on the main thread. A single
bounded parse cache shares import/open work. Engines cache derived text once;
chunks and BM25 remain lazy and weakly keyed by the open provider. Memoized
blocks keep sidebar updates from rebuilding document content. Browser
`content-visibility` skips offscreen layout/painting; one intersection observer
and a passive, animation-frame-throttled caret lookup track reading position.
Search results and attached passages are bounded. There is no per-word
geometry polling, OCR, or headless conversion. The rich notebook uses Tiptap;
its editor does not participate in source-document parsing or layout.

## Verification

macOS file associations live in `src-tauri/tauri.macos.conf.json`; imported
Markdown and EPUB type declarations live in `src-tauri/Info.plist`. The app
registers as an alternate viewer, leaving the user's default application choice
alone. `RunEvent::Opened` queues incoming file URLs until the frontend is ready.
The main webview can read only those queued requests, using raw byte IPC; the
general filesystem scope remains restricted to the library. Each file goes
through `library/importFiles.ts` for parsing, deduplication and reader routing.
External opens await the active reader's checkpoint, page archive and saves
before switching. Save failures keep its in-memory writing mounted.

`npm run test:macos-file-open` checks real LaunchServices delivery with a
temporary `.app`, synthetic documents and an isolated library. Start Vite with
`./node_modules/.bin/vite --host 127.0.0.1 --port 5178 --strictPort` first.
The check covers cold launch, later opens, names with spaces/punctuation/Unicode,
active notebook edits, deduplication, multi-file events, failed imports and PDF
rendering. It unregisters and removes its fixture app afterward. Rust queue tests
run with `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib`.

`npm test` covers parsing, semantic objects, canonical offsets, Unicode,
anchors, retrieval, citations, original-byte storage, deduplication, backup
relinking and save flushing, alongside the existing PDF suite. Notebook checks cover migration, shared mark ownership, acknowledged saves,
concurrent flushes, recoverable deletion, combining, provenance, assets,
portable and library backups, and readable HTML/Markdown export.

`npm run test:reader` exercises the browser using Node's built-in WebSocket
and Chrome's debugging protocol. Start Vite on port 5178 and a headless
Chrome instance with remote debugging on port 9224. The test creates and
disposes its own incognito browser context; it does not clear a user's library
or call live AI providers. `READER_URL` and `CDP_URL` override those endpoints;
`SCREENSHOT_PATH` optionally saves a screenshot. Chrome is a local test tool,
not an application dependency. The reader journey includes rich capture and
inline AI, scoped drafts, source/Notebook persistence, and a 1,000-entry mixed
notebook alongside a 3,503-block document. It checks lazy rich rendering, one
active editor, caret restoration, narrow layout, and absence of source DOM
mutations while writing.
The URL journey uses deterministic fetch responses, verifies offline reopening
with embedded PNG and rasterized SVG images, equation rendering, source links,
Notebook persistence and section links, and checks that PDF.js stays unloaded.
It also opens a direct PDF URL through the PDF reader.
Native checks also cover media activation, region image pixels and persistence,
annotated export/printing, nested dive panes, shared prompts, and saved summaries
that reopen without additional AI calls.

`cargo run --offline --manifest-path src-tauri/Cargo.toml --example import-browser-smoke`
exercises production page commands in an actual system WebView: a single reader
window, embedded bounds, live animation, selections/marks, canvas capture,
command isolation, navigation policy, verification detection and closing. It also
saves and replays the page's web archive, checking that scripts run exactly once,
the canvas and animation are restored and the site is not contacted, and that the
live page loads again afterwards. A page that starts a slow request after loading
must report `settled` only once that request is answered. Pass a live HTTP(S) URL after `--` to test it as
well; with the OpenAI scaling-storage article, it plays the first animated figure
both live and from its archive. This standalone harness uses a separate identifier
and an incognito window; it never loads the reader or accesses the user's
library, keychain or AI providers. It is a development example, not bundled.

`cargo run --offline --manifest-path src-tauri/Cargo.toml --example reader-page-smoke`
tests the actual React reader with Tauri IPC and filesystem permissions. Run Vite
on port 5178 first. Every app directory is overridden to a temporary root. The
test checks original styles, native bounds, live text selection and Notebook
highlights, Study text, offline replay of the saved page (scripts, saved marks, no
site requests) and returning to the live page, inline protected-page import,
automatic saving and cleanup.
It uses synthetic documents and a keychain stub, and never reads the user's library.

`npm run test:desktop-reader` tests the production bundle directly in macOS
a WKWebView with inactive scheduling disabled, a test-driven animation frame
clock, and explicit snapshots (remote macOS hosts may have no display link), served through the desktop `tauri://` asset scheme. Run it after
`npm run build`. It seeds synthetic library entries, reloads the JavaScript
runtime before every open, and verifies PDF, converted EPUB, saved web article
and native Markdown/HTML rendering, rich writing, images, equations, and inline AI
using deterministic mocked responses. Keep the production build fixed throughout
the check; rebuilding while it runs invalidates the assets under test. The PDF checks require a visible canvas, page
controls and the restored page's text; native checks also verify that
PDF.js stayed unloaded. The test uses a temporary, nonpersistent profile and
does not read or change the user's library. macOS and its Swift tools are
required; other platforms report a skip.

Earlier snapshot-reader baseline, before the embedded Page view: measured on
macOS after adding system capture, media, shared dives, area
capture and export (2026-11-16): production assets grew from 14,544,346 to
14,598,568 bytes (+54,222, 0.37%); the release executable grew from 16,401,296
to 16,641,296 bytes (+240,000, 1.46%). JavaScript `.js` chunks grew by 52,914
bytes (0.57%), or 45,149 bytes when individually gzipped. These compare the
Tauri production build with the prior production bundle, including embedded
assets; a plain Cargo build can omit them. The existing PDF
worker, fonts and backend dependencies were unchanged. Chrome's development
regression opened a 3,503-block source in roughly 350 ms and rendered only
eight rich entries from a 1,000-entry Notebook. These are local regression
measurements, not guarantees for every site or device.

The embedded Page implementation adds 8,892 bytes of production assets and
195,296 bytes to the executable compared with that snapshot-reader baseline
(14,607,460 asset bytes; 16,836,592 executable bytes). The local macOS app bundle
is rebuilt with these changes. Integrated checks also verify that the original
page retains its identity across mode switches, reader zoom affects its viewport,
its saved scroll position restores, and remote IPC cannot read the library.
