# Native document engine

`src/document/` owns the common reader for reflowable formats. Markdown is
the first adapter. Existing PDFs, converted EPUBs and saved web articles keep
their PDF rendering and source storage. Existing annotations migrate into the shared Notebook on first open.

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

EPUB can map its spine to blocks and supply the book's images as assets. HTML
needs a sanitizer and a resource resolver before producing this tree. Source
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

Native Deep Dives use the existing streaming API and persist as study threads,
including follow-ups and nested dives from answers. PDF's multi-pane dive tree
remains in the PDF reader. Images use the shared image-attachment path only
when selected for a question; tables already supply canonical searchable text.

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

Both backends retain original Markdown bytes. Desktop native sources use
`source.md` (future native HTML/EPUB use their own extensions); old PDF paths
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
The parser dependencies were already present through `react-markdown`; they
are now declared directly, without adding a second parsing stack.
The bundler selects the existing entity decoder's table-based implementation,
because its smaller DOM-based browser entry cannot run inside a worker.

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

`npm run test:desktop-reader` tests the production bundle directly in macOS
a WKWebView with inactive scheduling disabled, a test-driven animation frame
clock, and explicit snapshots (remote macOS hosts may have no display link), served through the desktop `tauri://` asset scheme. Run it after
`npm run build`. It seeds synthetic library entries, reloads the JavaScript
runtime before every open, and verifies PDF, converted EPUB, saved web article
and native Markdown rendering, rich writing, images, equations, and inline AI
using deterministic mocked responses. Keep the production build fixed throughout
the check; rebuilding while it runs invalidates the assets under test. The PDF checks require a visible canvas, page
controls and the restored page's text; the Markdown check also verifies that
PDF.js stayed unloaded. The test uses a temporary, nonpersistent profile and
does not read or change the user's library. macOS and its Swift tools are
required; other platforms report a skip.
