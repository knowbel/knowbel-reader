**Knowbel Notebook — UX and implementation plan**\
Prepared November 5, 2026. Status: implemented; validation details and deliberate interaction choices below.

Build a notebook that feels like an extension of reading: capture something, write beside it, ask for help, and continue. It should remain useful after the reader has forgotten the context in which an excerpt was saved.

This plan covers dependable capture, replacing the Annotations panel with Notebook, integrating saved AI material, and a small set of contextual AI writing tools. Learning support, quizzes, spaced repetition, and study reminders are excluded. Start with one notebook per library document. Its notes may cite several passages in that document; a library-wide notebook and cross-document organization are separate work.

**1. Product decisions**

| Decision | Proposed behavior |
| --- | --- |
| Navigation | Replace Annotations in the rail with Notebook. There is one place to find highlights and notes. |
| Primary layout | Document on the left, resizable notebook dock on the right. Persist the reader's open/closed preference and dock width. |
| Notebook form | An editable sequence of source excerpts and written notes, organized under section headings. Source excerpts are compact; written notes have room to develop. |
| Relationship to annotations | A highlight is a visible mark attached to a saved source capture. A note is editable writing that can reference one or several captures. Both appear in Notebook. |
| Automatic capture | Highlighting creates a source excerpt in Notebook immediately, without opening the dock or moving focus. |
| Writing | Notes save automatically. Enter adds a paragraph; finishing or dismissing an editor preserves its contents. |
| AI | Contextual actions appear at the point of use. The reader chooses what to save or change. |
| Organization | New captures use their source section. Written notes can be moved and combined without changing source locations. |
| Deletion | Removing a visible highlight does not delete writing or an AI conversation. Notebook deletions are recoverable. |
| Existing material | Migrate highlights, comments, sticky notes, pins, general notes, and dive highlights into the notebook. Preserve their existing locations and conversation relationships. |

**2. The everyday screen**

The normal desktop arrangement is a reading surface with Notebook alongside it:

```text
┌──────┬─────────────────────────────────┬───────────────────────────────┐
│ Rail │ Document                        │ Notebook            Saved  ···│
│      │                                 │ Find in notebook…             │
│      │ 3.2 Conditional probability     │                               │
│      │                                 │ 3.2 Conditional probability   │
│      │ …selected passage…              │                               │
│      │ Highlight · Note · Ask · ···     │ ▎ “The joint probability…”    │
│      │                                 │   p. 42 · Show source         │
│      │                                 │                               │
│      │                                 │ This step uses independence  │
│      │                                 │ to factor the expression.     │
│      │                                 │                               │
│      │                                 │ + Write a note                │
│      │                                 │                               │
│      │                                 │ ── Ask about this passage ─── │
│      │                                 │ A short explanation…          │
│      │                                 │ Save excerpt · Save takeaway │
└──────┴─────────────────────────────────┴───────────────────────────────┘
```

Readers can insert an AI question directly into the notebook and have its answer appear beneath it. This is the primary interaction when developing a note: the question, answer, and citations remain at that position in the document. A separate Ask area is optional for exploratory conversations the reader has not chosen to include in the notebook. When invoked, it opens as a resizable lower area inside the notebook dock, leaving the notebook above it and the document visible. Dismissing it returns the full dock to writing. The current Ask history remains accessible there. The rail's Ask command and existing shortcut open this same area.

An explicit Expand action opens the existing larger Deep Dive workspace. Mount Notebook outside the workspace/Deep Dive conditional so it remains available in either mode. Keep the existing tree, summary, grounding, and source-navigation capabilities; this project changes their connection to capture and writing.

Use a default dock width around 400 px, bounded by usable document and notebook widths. Resize by a visible separator with a keyboard alternative. At narrow widths use a drawer or full-height notebook sheet and an explicit Return to reading control. Restore both panes' positions when switching. Avoid squeezing three narrow columns into the viewport.

Contents, search, and glossary remain navigation tools in the left rail. Their temporary panels must not replace or unmount Notebook. Close a temporary navigation panel after a chosen jump when space is constrained. Preserve the reading anchor across layout changes, including PDF fit-to-width and native text reflow.

Notebook should look like writing space: restrained borders, generous line spacing, clear hierarchy, and source text quieter than the reader's own writing. Avoid repeating large cards, metadata headers, or empty comment fields for every highlight. Use a short colored rule to relate an excerpt to its highlight; include text labels so color is never the only cue. Entry actions appear on hover or focus and remain accessible on touch.

**3. What goes into the notebook**

Use two closely related concepts:

- **Source capture:** an immutable excerpt or image snapshot plus its exact location and origin. It may have a visible highlight, underline, area mark, or note marker in the document or an AI answer.
- **Notebook entry:** editable writing with zero or more attached captures. An entry containing just a capture is valid and stays compact. Adding a thought expands that same entry.

A highlighted passage therefore appears once, and its comment belongs to the same notebook entry. Editing it from a source tooltip, a sticky note, or Notebook edits the same content. Several captures can support one note; one capture can be referenced by more than one note without duplicating its mark or its stored image.

The notebook behaves as a continuous rich document. Entries and captures provide structure behind the scenes; the reader can write paragraphs, insert images, format text, and ask an AI question at an insertion point without opening a separate note form. Section and entry boundaries must support ordinary cursor movement and keyboard navigation.

Show an excerpt in two or three lines with its page/section chip, a Show more control, and a clear place to write. Keep the original excerpt separate from editable prose. A reader who wants to modify quoted wording can copy it into the note body; the stored source remains exact.

New entries go under the source section using the document outline. Show only sections with content, with Document notes for unanchored writing and Saved excerpts for legacy material whose location is unknown. Without an outline, use page groupings or one document section. A source's exact subsection can remain in its location chip even when the notebook groups by chapter.

Readers can add named sections, move entries between sections, reorder within a section, and combine selected entries. Preserve manual order. Combining entries retains all captures, individual AI provenance, and written content in order; make the operation undoable. Provide menu and keyboard alternatives to drag-and-drop. A note's organizational section and its cited source locations are independent.

Search covers the reader's text, excerpts, location labels, and saved AI material. Secondary filters provide Highlights, Written notes, AI excerpts, With images, and Near current location. These are views of the same notebook. Search and filtering retain unfinished edits and indicate when a newly saved entry is outside the current filter.

Track the section currently being read with a quiet location chip. Clicking it reveals the relevant notebook section. Scrolling the document must not automatically scroll the notebook, move its insertion point, or collapse an entry being edited.

**4. Capture interactions**

| Reader action | Immediate result | Focus and placement |
| --- | --- | --- |
| Select text → Highlight | Apply the last-used pen and create/reuse its compact notebook entry. | Keep focus in the document. If the dock is closed, leave it closed. |
| Select text → Note | Create/reuse the capture and open its rich editor in the adjacent notebook. | Focus the linked writing and preserve its source location. |
| Select text → Ask | Attach the selection and open the Ask area. | Preserve the notebook's existing cursor and position. |
| Select a region or figure → Save | Save its image and available text with a source link. | Same capture behavior as text. |
| Click + Note | Create an entry in the chosen notebook section. | Start writing immediately; a title is optional. |
| Select AI text → Add to notebook | Save the formatted fragment with its origin and citations. | Keep the answer in place. Show a quiet Added message with Show and Undo. |
| AI answer → Save takeaway | Generate a short editable proposal with source links. | Preview before insertion. |
| Existing excerpt → Write a note | Continue writing in that entry. | Do not create another capture. |
| Source tooltip → Remove highlight | Hide the visible mark. | Retain the source snapshot, written note, and conversation. |

The selection toolbar shows Highlight, Note, Ask, and More. Put Copy, colors/styles, glossary, region tools, and advanced actions in More or a pen popover. Retain continuous Highlight mode, with the active tool and pen clearly visible. Existing marks expose their current state and source-linked note.

Replace Pin with Add to notebook. In notebook prose, keep ordinary editing selection behavior; source highlighting is for document and AI-answer text. Saving an AI excerpt must not force readers to highlight that answer visually.

Default new captures to a new entry in their source section. When readers explicitly choose Add to this note, attach the capture to the selected entry. Never insert new material at a live writing cursor just because that editor was last focused. Reveal the chosen destination in the confirmation and allow Move afterwards.

Deduplicate by exact source identity, occurrence, and range, not just matching words. Re-saving the same passage reveals its existing entry; identical text in a different location remains distinct. A selected source spanning blocks/pages remains one capture with multiple anchor segments. A new empty editor should not produce a permanent blank note.

Capture the selection before changing focus. Preserve code whitespace and equation structure. Where PDF math has no reliable textual representation, retain the region image rather than inventing LaTeX. Adding material elsewhere must never steal the current notebook editor's focus or scroll it away. Use a New material below indicator when necessary.

**5. Writing and dependable saving**

Use one shared editing behavior across Notebook, source tooltips, and sticky notes:

- Enter creates a paragraph or line; the editor handles lists and code normally.
- The finish shortcut commits a recovery checkpoint and returns focus appropriately.
- Escape dismisses a transient editor without discarding what was typed. Undo reverses edits; an explicit Discard draft action is available when needed.
- Clicking elsewhere preserves the draft. Changing a color, source, or AI action cannot commit an outdated editor value.
- Respect IME composition and preserve caret/selection when an unrelated capture arrives.
- Keep drafts scoped to document, entry, conversation, and new-question context. Switching threads must not move an unsent question into another thread.

Support paragraphs, headings, emphasis, links, lists, blockquotes, code blocks, tables, inline/display math, images, and source chips. Use normal paste and keyboard formatting. Offer a small formatting menu on text selection and an insertion control at an empty paragraph. Avoid making slash commands necessary for basic use.

Persist editor content independently of component mounting. Preserve a shared in-memory session immediately on input, checkpoint lightweight recovery data promptly, and coalesce durable notebook writes. The notebook, Ask, and Deep Dive composers all use this session layer.

Show Saving while the latest revision is pending and Saved only when that revision has been acknowledged by the actual storage backend. On failure retain dirty data and recovery checkpoints, show a concise Retry state, and preserve the ability to copy the current writing. Older completed writes must not mark newer edits as saved. A later successful retry must not be overwritten by an earlier queued write.

Flush before controlled document switches and desktop window close. Use browser lifecycle events as additional checkpoints, rather than the only persistence mechanism. Recovery guarantees apply to acknowledged writes and completed checkpoints; do not claim that a forcibly terminated process persisted an unacknowledged keystroke.

Use editor-local undo for text while its editor is focused and notebook-command undo for capture, move, combine, and deletion elsewhere. AI insertion/replacement is one undoable edit. Keep a recoverable Trash for deleted entries; entry restoration retains source links and applicable marks. An Undo of a capture that has since gained writing must preserve that writing.

**6. Source links, annotations, and deletion**

Every source chip can preview the saved material and jump to the original passage, figure, or AI answer. Hover/focus may softly outline the corresponding mark. Only an explicit Show source action changes reading position. Preserve a route back to the previous reading location.

Source captures retain their own snapshots and references. Removing a conversation leaves its saved excerpts readable; its Open conversation action becomes unavailable. Removing a mark leaves a notebook note's source accessible through its saved location. Missing source files show the saved material and identify that the original is unavailable.

| Operation | Notebook content | Visible source marks | Conversation |
| --- | --- | --- | --- |
| Remove highlight | Retained, including the excerpt. | That mark is hidden. | Retained. |
| Delete notebook entry | Moved to Trash with its content and source relationships. | Hide marks no longer used by another active entry. | Retained. |
| Restore notebook entry | Restored in its previous section/order where possible. | Restore its unshared marks. | Existing conversation links work. |
| Delete conversation | Saved excerpts and their citation snapshots remain. | Preserve document marks; answer marks cannot render without their conversation. | Deleted only by the conversation action. |
| Move/combine notes | Preserve writing, source identities, and provenance. | Locations and styles stay attached to their source captures. | Retained. |

Normal Note capture uses a quiet source marker and the attached editor. Keep the existing Place sticky note command as a secondary option and preserve imported sticky notes. A sticky's displayed text is a view of its notebook entry, so its page editor and Notebook cannot diverge.

**7. Subtle AI features included in this project**

The useful intelligence is contextual: Knowbel knows what was saved, where it came from, and what the reader is currently writing.

| Feature | Trigger | Result |
| --- | --- | --- |
| Ask AI here | Insert an AI question block using an insertion menu, optional slash command, or keyboard action. | Type a question in the document and explicitly run it; its rich, cited answer streams directly below the question. |
| Save takeaway | An answer or dive-summary action. | An editable, cited draft capturing the useful point. The exact-answer excerpt is also available as a direct save. |
| Clarify / Shorten | Select the reader's writing and open its contextual menu. | A proposed replacement beside the original, with Replace, Insert below, and Dismiss. |
| Ask about this note | An entry action or selected text. | An attached question containing chosen writing and its source captures, with the scope visible. |
| Related notes | An entry action. | A few existing notes relevant to its sources and wording, with explanations such as Same equation or Same passage. |

Use deterministic source relationships and local text ranking for deduplication, section placement, basic titles, and initial related-note suggestions. Run model calls when requested. Do not generate a response or a title for every highlight.

An inline AI exchange is a first-class document node containing a stable ID, editable question, chosen context/source references, answer content, and provenance. Its controls offer Run, Stop, Retry, Follow up, and collapse where applicable. Show the selected context before running. Stream only into that exchange's answer region; paragraphs the reader types elsewhere are unaffected. Answers support the same equations, code, tables, images where available, and source chips as other notebook content. After generation the reader can edit the answer, preserving its origin, or retain it as a collapsible explanation.

Keep active jobs separate from serialized document content. Address updates by exchange ID rather than the current cursor or DOM position. Moving the exchange does not redirect its answer, deleting it cancels its job, and undoing deletion does not automatically make another model request. Save partial output and restore interrupted runs as interrupted, with an explicit retry. Regeneration preserves the previous answer until the reader chooses to replace it and never overwrites reader edits. Writing an answer into a newly requested inline exchange is distinct from rewriting existing prose, which still requires a proposal and acceptance.

Source facts, reader assertions, and earlier AI text must remain distinguishable in model context. Existing reader writing is context, not documentary evidence. Grounded answers cite original passages; references to a notebook entry are labeled as references to the reader's notes. Expose which entries and passages were used in the Ask area.

Keep provenance on the relevant saved block, rather than labeling an entire mixed note as AI-authored. A quiet AI-assisted label opens its original answer, sources, and generation details. Editing a block retains its origin while recording that the reader changed it. Verbatim AI excerpts, generated takeaways, and the reader's own text stay distinguishable.

AI tools cannot silently rewrite a note, move entries, merge duplicates, or strengthen the claim that a source supports. Preserve cancellation, retry, and the original writing. Bind proposals to the originating document, entry, selection, and content revision. If writing changes while a proposal is generated, retain the proposal for explicit insertion and prevent stale replacement.

Saving selected AI content must retain its formatted Markdown fragment, stable turn identity, and resolved source snapshots. Do not flatten equations/code through plain DOM text extraction. Request-local labels such as S1 must be converted into stable notebook source IDs before passages from several answers are combined. When the evidence for a saved fragment cannot be identified precisely, retain its broader answer context and describe it as answer sources, rather than implying a narrower verified relationship.

All ordinary writing, capture, search, source navigation, and export work without an AI provider. Notebook AI reuses the reader's configured providers and current grounding pipeline.

**8. Data and component architecture**

Introduce a versioned notebook document, with one canonical owner for captures, written content, and persistent annotation presentation:

```text
NotebookDocument
  schemaVersion, revision, migration metadata
  sections[]              stable IDs, titles, manual order, optional source section
  entries[]               stable IDs, section/order, rich text and inline AI exchanges
  captures[]              stable IDs, excerpt/image snapshots, exact anchors, mark style
  trash[]                 deleted entries and restoration metadata

ReaderDrafts
  document/entry/conversation keys, editor snapshots, pending question attachments

Notebook assets
  content-addressed images, referenced by captures and note blocks
```

Each rich-text block and capture can carry its own origin. A capture anchor can contain existing PDF rectangles/text ranges, native text/object anchors, or an AI conversation/turn/occurrence reference. Store the document identity and fallback excerpt/location alongside the anchor. Keep organizational position separate from source position.

The primary saved format is a versioned structured JSON document plus separately stored image/file assets. The document tree represents paragraphs, formatting marks, images, tables, math, source references, and AI exchanges as typed nodes. User-facing content is rich text. Markdown, HTML, and possible DOCX exports are representations of that document; generic external editors can display exported questions/answers but do not acquire Knowbel's live AI behavior. A portable notebook bundle includes JSON, referenced assets, and the metadata required to reopen it losslessly in Knowbel.

Reuse the existing PDF and native anchoring/rendering engines through adapters. Derive `CommentedHighlight`, `DocumentAnnotation`, and `DiveHighlight` view objects from notebook captures using stable mark IDs. Route edits back through shared notebook commands. Preserve existing IDs referenced by dive roots. Transient glossary/search flashes remain transient overlays.

After successful migration, stop separately writing highlight comments, sticky bodies, pins, and general-note text to legacy collections. Keeping multiple editable copies would make reliable synchronization unnecessarily fragile. Notebook content, annotation presentation, and links are committed together as one versioned notebook record; conversations and glossary history remain in their existing stores.

Use a shared session/store that survives panel changes, plus small components for the dock, entry editor, source excerpt, source preview, Ask area, and contextual AI proposal. Readers provide location/selection adapters. Keep capture, notebook editing, AI jobs, and layout state out of the already large `PdfReader.tsx` where possible.

Use a headless Tiptap editor for entry bodies with a deliberately bounded schema, while retaining Knowbel's existing styling and KaTeX rendering conventions. Its [StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit) provides core editing and undo; its [math extension](https://tiptap.dev/docs/editor/extensions/nodes/mathematics) supports technical notation. Persist versioned [editor JSON](https://tiptap.dev/docs/guides/output-json-html) and implement explicit import/export for Knowbel's supported content and source nodes. [Markdown support](https://tiptap.dev/docs/editor/markdown) can assist conversion, but custom source/provenance nodes require tested serializers.

Tiptap is the implemented editor. React node views provide inline questions,
source chips, image assets, and individual AI contribution origins. The native
JSON envelope remains Knowbel-owned; custom source and AI nodes have explicit
portable serializers. Markdown is an export representation, with complete JSON
and assets retained in the portable notebook bundle.
Prototype composition, undo, tables, equations, citation nodes, and partial-answer paste in macOS WebKit before building the full surface. Keep only the active entry's editor mounted; render inactive entries cheaply. Lazy-load editing code. Large notebooks must not remount the document, rebuild its text index, or instantiate hundreds of editors.

Add a notebook data kind and a recovery-draft kind to both backends and reader loading. Store image assets separately from frequently rewritten notebook JSON. Persist a new image before acknowledging a capture that references it, and include referenced images in backups and notebook export.

Extend `DocDataWriter` to expose per-revision acknowledgement, retain failed dirty work, propagate failures to flush callers, and support retry. Its current internal catch reports an error but resolves the queued write, so a successful `flush()` alone is insufficient evidence for Saved.

**9. Migration, backups, and compatibility**

| Existing material | Notebook representation |
| --- | --- |
| PDF/native highlight | Capture with original location, mark ID, color/style, and an entry containing its comment. |
| Area highlight or image/table annotation | Image/object capture, text where available, and attached writing. |
| Sticky note | Written entry with its original anchor and sticky presentation. |
| General note | Written entry under Document notes. |
| Pin | Saved excerpt retaining its recorded context/comment; source marked unrecorded unless genuinely recoverable. |
| Dive highlight | AI-answer capture retaining panel/turn/occurrence, writing, and associated dive relationship. |
| Existing dive summary | Keep attached to its conversation, with Add to notebook available; do not automatically add every summary. |

Migration must be deterministic and idempotent. Read legacy collections, build the complete notebook in memory, validate references/counts, write it atomically, and mark completion inside that same notebook record. Keep legacy data intact as migration input/recovery material; do not run two active writing paths after migration. Prevent later opens from resurrecting deleted entries through repeated legacy import.

Back up all migrated bodies and source snapshots, including missing-file documents and images. Import existing version-1 notes backups. For new backups, introduce a versioned notebook/asset payload and notebook-aware merge. The existing `mergeById` only merges arrays; passing a notebook object to it would ignore incoming material when stored material already exists. Merge entries, captures, sections, provenance, and tombstones explicitly. Preserve conflicting content as a recoverable copy instead of silently overwriting it.

If several incoming source registries use the same request-local citation label, remap references before combining entries. Retain malformed/unresolved legacy items in a recoverable import report rather than dropping them. A failed migration must leave the previous reader data available.

Support Copy selection and Export notebook as Markdown with readable source references, math, code, and relative image files in a portable bundle when images are present. The complete notes backup also retains exact anchors, provenance, and recovery metadata. Existing annotated-PDF export must continue to work through the adapter's derived mark list.

**10. Implementation sequence**

Each phase ends with a reviewable behavior, and later phases depend on the preceding data and capture contracts.

| Phase | Work | Reviewable result |
| --- | --- | --- |
| 1. Reliable drafts and writes | Shared draft/session layer for notes, Ask, and Dive; acknowledgement/error handling; consistent Enter/Escape behavior; flush/recovery checks. | Switching panels, threads, and documents preserves writing and correctly reports save state. |
| 2. Notebook model and migration | Capture/entry schema, commands, revision handling, asset storage, stable conversation turn IDs, legacy adapters, backup merge, migration fixtures. | Existing library material opens with equivalent text, anchors, style, and links in the new model. |
| 3. Notebook reading surface | Right dock, compact excerpts, active entry editor, section organization, search/filters, source previews, keyboard access, move/combine, Trash, responsive layout. | A reader can keep Notebook open, write continuously, and navigate between notes and sources. |
| 4. Capture integration | Simplified toolbar, linked inline note editor, exact deduplication, figures/regions, answer fragments, shared sticky editing, Add to notebook in place of Pin. | Every supported capture path creates useful, correctly attributed notebook content without disrupting reading. |
| 5. Inline AI and persistent workspace | Inline question/answer nodes, scoped context, streaming/cancel/retry/recovery, optional Ask lower area, existing conversation history, notebook available in Deep Dive, citation/return navigation. | Ask a question inside a note, read and edit its answer there, and continue writing or reading without leaving the notebook. |
| 6. Contextual AI writing tools | Save takeaway, Clarify/Shorten previews, Ask about note with sources, local related-note suggestions, cancellation/stale-proposal handling. | AI helps develop selected material and changes writing only through explicit insertion/replacement. |
| 7. Polish and cutover | Migration/backup round trips, large-notebook performance, WebKit/browser accessibility checks, updated README/docs, removal of the redundant Annotations UI. | Notebook is the sole shipped annotation/notes surface, with parity across PDF and Markdown. |

Primary implementation areas:

- New `src/notebook/`: model, commands, session/store, migration, editor schema, source/citation conversion, dock/components, export, and AI proposals.
- `src/components/HighlightToolbar.tsx` and `NoteControl.tsx`: capture entry points and consistent attached editing.
- `src/PdfReader.tsx`, `src/document/NativeReader.tsx`, and `src/deepdive/DeepDiveView.tsx`: adapters and persistent workspace mounting.
- `src/ask/AskPanel.tsx`, `src/ask/types.ts`, `src/deepdive/DivePanelPane.tsx`, and `TreeSummaryPanel.tsx`: stable turns, fragment capture, shared drafts, and save actions.
- `src/components/AppRail.tsx`, `Sidebar.tsx`, `SidebarFrame.tsx`, and CSS: Notebook navigation, dock, and temporary source-navigation panels.
- `src/storage/` and `src/library/library.ts`: new records/assets, reliable saves, backup versions, merge, and missing-file restoration.
- `src/grounding/` and existing AI request/provider helpers: preserve citation identity, rich fragments, source/context boundaries, and bounded contextual generation.
- Browser and desktop reader scripts: extend the existing synthetic-document and mocked-AI checks for the complete capture loop.

**11. Acceptance checks**

Use meaningful model/persistence tests and a small number of full reader journeys. Extend the existing browser script and desktop WebKit checks; avoid a separate assertion for every presentational detail.

1. Type a note; switch panels, Ask threads, Deep Dive branches, and documents; return with exact content, attachments, and an appropriate cursor/scroll restoration.
2. Slow or fail storage writes; Saved never appears for an unacknowledged revision, Retry retains the newest work, and controlled document switches do not discard it.
3. Reload after Saved; restore the note and its links. Recover a completed draft checkpoint after an interrupted session. Include out-of-order save completions.
4. Highlight several passages while Notebook is closed and while another entry is being edited. Each capture appears once, with no focus theft or scroll jump.
5. Save identical words at two source locations; preserve both. Save the same exact selection again; reuse it. Include a selection crossing native blocks or PDF pages.
6. Edit the same linked note through the inline editor, sticky presentation, and notebook. There is one canonical body and coherent undo behavior.
7. Save an AI fragment containing an equation, code, and citations. Reopen it and navigate to the correct answer occurrence and original document sources. Combine material from two answers whose sources both use S1.
8. Remove a highlight and delete its conversation; previously saved writing and source snapshots remain readable. Delete/restore an entry and verify shared-source marks remain coherent.
9. Move and combine notes, filter/search, and capture while filtered. Manual organization and unfinished writing survive; no material is silently inserted into the live cursor.
10. Export/import a mixed legacy and new notebook, including images and a missing source document. Repeat migration/import without duplicate entries or resurrecting tombstones; preserve conflict copies.
11. Generate an AI proposal, continue editing, switch documents, cancel, and retry. Proposals remain attached to the right context and cannot overwrite a newer selection.
12. Read with hundreds of captures, a long technical note, and many figures. Inactive entries remain cheap, editing does not rerender the entire reader, and the document/Notebook positions remain stable.
13. Complete capture, editing, source navigation, move/combine, and recovery with keyboard only. Check screen-reader labels, focus return, IME, touch controls, narrow layouts, light/dark themes, and reduced motion.
14. Insert an inline AI question between two paragraphs, run it, and keep writing elsewhere while its answer streams. Move, cancel, delete/undo, regenerate, and reopen the exchange; output remains attached to the right block, user edits survive, and interrupted jobs never restart automatically.

The final walkthrough is a reader studying a difficult passage: highlight it, write a tentative interpretation, ask about the source, save a cited explanation, add a personal clarification, combine it with a second passage, and continue reading. Repeat it in PDF and Markdown, then reopen the document and export its notebook.


**Implementation notes**

The primary Note action opens the linked rich editor in Notebook immediately.
This keeps one editing surface, formatting behavior, and save indicator across
PDF and native documents. Source tooltips retain their short editing fallback
for existing integrations. Attaching a second passage is explicit in Note
actions → Attach a saved passage; combining notes retains each AI block's origin.
The notebook is a sectioned writing surface with one active entry editor.
Entry boundaries use ordinary Tab/Enter navigation rather than a single
ProseMirror instance for the entire notebook.

Notebook writes use a shared serial drain, asset-first persistence, backend
acknowledgements, retry state, and lightweight recovery checkpoints. Workspace
scroll, active entry, and selection are local view preferences, independent of
content revisions. Reader AI drafts and attachments are durable data.

Tests cover migration and backups, source deduplication, retained writing after
mark removal, shared sticky bodies, formatting/math/tables/images, inline
questions and interruption, source/conversation links, section commands, rich
export, and lazy rendering with 1,000 mixed entries. Browser and desktop checks
use synthetic libraries and mocked AI; they do not evaluate live model quality.
No learning, quizzes, reminders, or spaced review features were added.

**Verification completed — November 5, 2026**

- Production TypeScript/Vite build and lint pass; `git diff --check` is clean.
- All 374 automated tests pass, including migration failure isolation,
  concurrent saves, source ownership, provenance, asset conflicts, and backups.
- Production browser journeys pass for PDF/native switching, rich writing,
  inline AI, edited-answer regeneration, cancellation/reopening, source links,
  scoped drafts, search/filters, and reading/notebook/caret restoration.
- The synthetic 1,000-entry rich notebook rendered eight entries initially,
  kept one editor active, and produced no source DOM mutations while typing.
  Its measured edit/save journey was 404 ms with no recorded main-thread long
  tasks in that run. The separate 3,503-block source opened in 195 ms.
  These are local regression-fixture measurements, not network benchmarks.
- Desktop WebKit journeys pass for PDF, converted EPUB, saved web articles,
  and native Markdown, including images, math, rich notes, and inline AI.
  The remote macOS harness drives frame callbacks and snapshots because the
  host display link can be unavailable; rendering/editing still use WebKit.
- AI responses are mocked for repeatability. Live provider answer quality,
  exhaustive assistive-technology/IME coverage, and non-macOS desktop builds
  are outside these automated checks.
