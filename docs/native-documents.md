# Native document engine

`src/document/` owns the common reader for reflowable formats. Markdown is
the first adapter. Existing PDFs, converted EPUBs and saved web articles keep
their PDF rendering and storage; existing annotations need no migration.

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
unambiguous context match; unresolved notes are retained in the sidebar.
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

## Shared annotations panel

`components/AnnotationsPanel.tsx` owns the cards, search, type/color/note/location
filters, document/recent sorting, note editor and Markdown export for both
readers. `annotations/model.ts` defines its format-neutral rows and section
boundaries, plus common pin/general-note rows. A row supplies an ordered
position, display label and edit/delete/navigation callbacks; the panel never
reads PDF rectangles or native anchors.

`components/PdfAnnotationsPanel.tsx` projects PDF highlights, sticky notes,
dive highlights and outline chapters into those rows. `document/annotationRows.ts`
projects native text/object annotations and heading sections; native sticky
cards display and edit the note's own content. Image/table annotations use area
cards. Unresolved anchors remain editable in the panel. Native panel edits use
the existing save/undo path, and new sticky notes open their editor immediately.
Both readers use the same `AnnotationCard`, Save/Cancel editors, action
buttons, filters, sort controls, help text and `SidebarFrame` (including the
collapse control and responsive sizing). Adapters supply data and callbacks,
with no UI overrides. Hovering a card outlines its source annotation in either
reader. The Dive badge appears only for annotations with an associated
conversation and opens that existing dive; new dives start from the selection
tooltip.
Location text reflects the document: PDF page labels or native section names.
Storage formats stay unchanged.

New native format adapters inherit this panel through `NativeReader` without
adding UI. A reader with a different anchor model can supply its own row
projection. PDF outline hooks stay in the PDF adapter, and the native panel
loads on demand without importing the PDF runtime.

## Storage and performance

Both backends retain original Markdown bytes. Desktop native sources use
`source.md` (future native HTML/EPUB use their own extensions); old PDF paths
remain `source.pdf`. `nativeAnnotations` is a per-document data kind included
in notes backups. Reimporting source content relinks restored notes. Saves
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
geometry polling, OCR, headless conversion, new editor framework or UI kit.

## Verification

`npm test` covers parsing, semantic objects, canonical offsets, Unicode,
anchors, retrieval, citations, original-byte storage, deduplication, backup
relinking and save flushing, alongside the existing PDF suite. Shared-panel
checks cover anchor projections, ordering, section boundaries, unresolved
locations and pin/note edit routing.

`npm run test:reader` exercises the browser using Node's built-in WebSocket
and Chrome's debugging protocol. Start Vite on port 5178 and a headless
Chrome instance with remote debugging on port 9224. The test creates and
disposes its own incognito browser context; it does not clear a user's library
or call live AI providers. `READER_URL` and `CDP_URL` override those endpoints;
`SCREENSHOT_PATH` optionally saves a screenshot. Chrome is a local test tool,
not an application dependency.

`npm run test:desktop-reader` tests the production bundle directly in macOS
WKWebView, served through the desktop `tauri://` asset scheme. Run it after
`npm run build`. It seeds synthetic library entries, reloads the JavaScript
runtime before every open, and verifies PDF, converted EPUB, saved web article
and native Markdown rendering. The PDF checks require a visible canvas, page
controls and the restored page's text; the Markdown check also verifies that
PDF.js stayed unloaded. The test uses a temporary, nonpersistent profile and
does not read or change the user's library. macOS and its Swift tools are
required; other platforms report a skip.
