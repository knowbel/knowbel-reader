import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorContent, NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer, useEditor, useEditorState, type NodeViewProps } from "@tiptap/react";
import { Node as TiptapNode, mergeAttributes, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import Mathematics from "@tiptap/extension-mathematics";
import { Markdown } from "@tiptap/markdown";
import { Bold, Italic, List, Code, ImagePlus, Table2, Sigma, Sparkles, Undo2, Redo2, Link, Quote, Heading2, Trash2 } from "lucide-react";
import katex from "katex";
import "katex/dist/katex.min.css";
import CitationChip, { type ResolvedRef } from "../grounding/CitationChip";
import AnswerMarkdown from "../grounding/AnswerMarkdown";
import { safeDocumentUrl } from "../document/model";
import { showNotice } from "../components/notices";
import { fingerprint, newExchange, type RichNode } from "./model";
import { useNotebook, type NotebookBindings } from "./context";
import { runInlineQuestion, writingProposal } from "./ai";
import { parseRichMarkdown } from "./codec";
import { notebookView, rememberNotebookView } from "./view";

function jsonAttribute(element: HTMLElement, name: string): Record<string, any> {
  try { return JSON.parse(element.getAttribute(name) ?? "{}"); } catch { return {}; }
}
function citationLabel(refs: ResolvedRef[], bindings: NotebookBindings) { return [...new Set(refs.map((ref) => ref.source.locationLabel ?? `p. ${bindings.pageLabel(ref.source.pageNumber)}`))].join(", "); }
function CitationView({ node }: NodeViewProps) {
  const bindings = useNotebook(); if (!bindings) return null;
  const refs = node.attrs.refs as ResolvedRef[];
  return <NodeViewWrapper as="span" contentEditable={false}><CitationChip kind={node.attrs.kind} quoteMissing={node.attrs.quoteMissing} refs={refs} label={citationLabel(refs, bindings) || node.attrs.kind} pageLabel={bindings.pageLabel} onJump={bindings.onJumpToSource} /></NodeViewWrapper>;
}
const SourceCitation = TiptapNode.create({
  name: "sourceCitation", group: "inline", inline: true, atom: true,
  addAttributes: () => ({ refs: { default: [], parseHTML: (element: HTMLElement) => jsonAttribute(element, "data-notebook-citation").refs ?? [] }, kind: { default: "stated", parseHTML: (element: HTMLElement) => jsonAttribute(element, "data-notebook-citation").kind ?? "stated" }, quoteMissing: { default: false, parseHTML: (element: HTMLElement) => !!jsonAttribute(element, "data-notebook-citation").quoteMissing } }),
  parseHTML: () => [{ tag: 'span[data-notebook-citation]' }],
  renderHTML: ({ HTMLAttributes }) => ["span", { "data-notebook-citation": JSON.stringify(HTMLAttributes) }, "[Source]"],
  addNodeView: () => ReactNodeViewRenderer(CitationView),
});
const NotebookImage = Image.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    const store = (this.options as unknown as { store: NotebookBindings["store"] }).store;
    const importAsset = (element: HTMLElement) => {
      const src = element.getAttribute("src") ?? "";
      return /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src) ? store.addImageDataUrl(src, element.getAttribute("data-asset-id") ?? crypto.randomUUID()) : element.getAttribute("data-asset-id");
    };
    return { ...parent, src: { default: null, parseHTML: (element: HTMLElement) => { const id = importAsset(element); return id ? `asset:${id}` : element.getAttribute("src"); } }, assetId: { default: null, parseHTML: importAsset, renderHTML: (attrs: Record<string, unknown>) => ({ "data-asset-id": attrs.assetId }) } };
  },
  renderHTML({ HTMLAttributes }) {
    const store = (this.options as unknown as { store: NotebookBindings["store"] }).store;
    return ["img", { ...HTMLAttributes, src: HTMLAttributes["data-asset-id"] ? store.assetDataUrl(HTMLAttributes["data-asset-id"]) ?? HTMLAttributes.src : HTMLAttributes.src }];
  },
  addNodeView() {
    const store = (this.options as unknown as { store: NotebookBindings["store"] }).store;
    return ({ node }) => {
      const img = document.createElement("img");
      const apply = (current: typeof node) => { img.src = current.attrs.assetId ? store.assetUrl(current.attrs.assetId) ?? "" : safeDocumentUrl(current.attrs.src ?? "", true) ?? ""; img.alt = current.attrs.alt ?? "Image"; img.loading = "eager"; };
      apply(node); return { dom: img, update: (next: typeof node) => { if (next.type !== node.type) return false; apply(next); return true; } };
    };
  },
}).extend<{ store: NotebookBindings["store"]; allowBase64: boolean; inline: boolean; resize: false; HTMLAttributes: Record<string, unknown> }>({});

function ContributionView({ node }: NodeViewProps) {
  const bindings = useNotebook();
  const origin = node.attrs.origin;
  const edited = node.attrs.originalHash !== fingerprint(node.toJSON().content ?? []);
  return <NodeViewWrapper className="nb-contribution"><div className="nb-contribution-origin" contentEditable={false}>
    <Sparkles size={11} /><span title={origin?.context}>AI-assisted{edited ? " · edited" : ""}</span>
    {origin?.conversationId && bindings?.onOpenConversation ? <button type="button" onClick={() => { if (!bindings.onOpenConversation!(origin.conversationId, origin.turnId)) showNotice("The conversation is no longer available. The saved sources are kept here."); }}>Original answer</button> : null}
  </div><NodeViewContent /></NodeViewWrapper>;
}
const Contribution = TiptapNode.create({
  name: "contribution", group: "block", content: "block+", defining: true,
  addAttributes: () => ({ origin: { default: null, parseHTML: (element: HTMLElement) => jsonAttribute(element, "data-notebook-origin") }, originalHash: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("data-original-hash") ?? "" } }),
  parseHTML: () => [{ tag: "div[data-notebook-origin]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", { "data-notebook-origin": JSON.stringify(HTMLAttributes.origin), "data-original-hash": HTMLAttributes.originalHash }, 0],
  addNodeView: () => ReactNodeViewRenderer(ContributionView),
});

function ExchangeView({ node, updateAttributes, extension, deleteNode, editor }: NodeViewProps) {
  const bindings = useNotebook();
  if (!bindings) return null;
  return <NodeViewWrapper contentEditable={false} className="nb-ai-node"><InlineExchange attrs={node.attrs} entryId={extension.options.entryId} bindings={bindings} onChange={updateAttributes} onDelete={() => {
    editor.view.dispatch(closeHistory(editor.state.tr));
    deleteNode();
    editor.commands.focus();
  }} /></NodeViewWrapper>;
}
const AiExchange = TiptapNode.create<{ entryId: string }>({
  name: "aiExchange", group: "block", atom: true, draggable: true,
  addOptions: () => ({ entryId: "" }),
  addAttributes: () => Object.fromEntries(Object.entries({ id: "", question: "", answer: "", pendingAnswer: "", previousAnswer: "", editedBody: null, sources: [], pendingSources: [], pendingAt: "", status: "idle", error: "", scope: "note", at: "", collapsed: false }).map(([name, value]) => [name, { default: value, parseHTML: (element: HTMLElement) => {
    if (name === "id") return crypto.randomUUID();
    const saved = jsonAttribute(element, "data-notebook-ai")[name] ?? value;
    return name === "status" && ["streaming", "preparing"].includes(saved) ? "interrupted" : saved;
  } }])),
  parseHTML: () => [{ tag: "section[data-ai-exchange]" }],
  renderHTML: ({ HTMLAttributes }) => ["section", mergeAttributes({ "data-ai-exchange": "" }, { "data-id": HTMLAttributes.id, "data-notebook-ai": JSON.stringify(HTMLAttributes) }), `Question: ${HTMLAttributes.question}\n\n${HTMLAttributes.answer}`],
  addNodeView: () => ReactNodeViewRenderer(ExchangeView),
});


export function InlineExchange({ attrs, entryId, bindings, onChange, onDelete }: { attrs: Record<string, any>; entryId: string; bindings: NotebookBindings; onChange: (attrs: Record<string, unknown>) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const busy = ["preparing", "streaming"].includes(attrs.status);
  const hasPrevious = !!attrs.answer || !!attrs.editedBody;
  const answer = hasPrevious ? attrs.answer : attrs.pendingAnswer || attrs.answer;
  const answerSources = hasPrevious ? attrs.sources : attrs.pendingSources?.length ? attrs.pendingSources : attrs.sources;
  const run = () => { setEditing(false); void runInlineQuestion(bindings, entryId, attrs.id); };
  return <section className={`nb-ai-exchange${busy ? " is-running" : ""}`} data-exchange-id={attrs.id} aria-label="AI question and answer">
    <div className="nb-ai-heading"><Sparkles width={13} height={13} /><span>Ask AI here</span><select aria-label="Question context" value={attrs.scope ?? "note"} disabled={busy} onChange={(event) => onChange({ scope: event.target.value })}><option value="note">This note + sources</option><option value="document">Document</option></select>
      {answer ? <button type="button" onClick={() => onChange({ collapsed: !attrs.collapsed })}>{attrs.collapsed ? "Expand" : "Collapse"}</button> : null}
      <button type="button" className="nb-icon nb-delete-exchange" aria-label="Delete AI question" title="Delete question and answer" onMouseDown={(event) => event.preventDefault()} onClick={() => {
        // Undo can restore a stopped answer, but must never restore a running state.
        if (busy) bindings.store.patchNode(entryId, attrs.id, { status: "interrupted" });
        onDelete();
      }}><Trash2 size={13} aria-hidden="true" /></button></div>
    <textarea className="nb-ai-question" aria-label="AI question" placeholder="Ask about this passage or your notes…" value={attrs.question} rows={2} disabled={busy} onChange={(event) => onChange({ question: event.target.value })} onKeyDown={(event) => {
      event.stopPropagation(); if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (attrs.question.trim()) run(); }
    }} />
    {!attrs.collapsed ? <>
      {answer ? <div className="nb-inline-answer">
        {editing ? <RichEditor entryId={entryId} body={attrs.editedBody ?? parseRichMarkdown(attrs.answer, attrs.sources)} onChange={(body) => onChange({ editedBody: body })} nested /> : attrs.editedBody ? <RichContent node={attrs.editedBody} entryId={entryId} /> : <AnswerMarkdown content={answer} sources={answerSources ?? []} onJump={bindings.onJumpToSource} pageLabel={bindings.pageLabel} streaming={busy && !hasPrevious} />}
      </div> : null}
      {hasPrevious && attrs.pendingAnswer ? <div className="nb-proposal"><span className="nb-eyebrow">New explanation · your current answer is kept above</span><AnswerMarkdown content={attrs.pendingAnswer} sources={attrs.pendingSources ?? []} onJump={bindings.onJumpToSource} pageLabel={bindings.pageLabel} streaming={busy} />{!busy ? <div><button type="button" onClick={() => onChange({ answer: attrs.pendingAnswer, sources: attrs.pendingSources ?? [], editedBody: null, pendingAnswer: "", pendingSources: [], status: "complete", at: attrs.pendingAt || new Date().toISOString() })}>Use new answer</button><button type="button" onClick={() => onChange({ pendingAnswer: "", pendingSources: [], status: "complete", error: "" })}>Keep current answer</button></div> : null}</div> : null}
      {busy && !answer ? <p className="nb-ai-status" role="status">Reading the relevant passages…</p> : null}
      {attrs.error ? <p className="nb-ai-error" role="status">{attrs.error}</p> : null}
      {attrs.status === "interrupted" && !attrs.error ? <p className="nb-ai-status">Interrupted. Retry when you’re ready.</p> : null}
    </> : null}
    <div className="nb-ai-actions">
      {busy ? <button type="button" onClick={() => bindings.store.stopJob(attrs.id)}>Stop</button> : <button type="button" className="nb-primary" onClick={run} disabled={!attrs.question?.trim()}>{attrs.answer ? "Regenerate" : attrs.status === "error" || attrs.status === "interrupted" ? "Retry" : "Ask"}</button>}
      {attrs.answer && !busy ? <button type="button" onClick={() => setEditing((value) => !value)}>{editing ? "Done editing" : "Edit answer"}</button> : null}
      {attrs.answer && !busy ? <button type="button" onClick={() => {
        const entry = bindings.store.getEntry(entryId); if (!entry) return;
        const followup = newExchange();
        bindings.store.updateBody(entryId, { ...entry.body, content: [...(entry.body.content ?? []), followup, { type: "paragraph" }] });
        bindings.store.reveal(entryId);
      }}>Follow up</button> : null}
      {attrs.at ? <span className="nb-ai-origin">AI-assisted{attrs.editedBody ? " · edited" : ""}</span> : null}
    </div>
  </section>;
}

export const RichContent = memo(function RichContent({ node, entryId }: { node: RichNode; entryId: string }) {
  const bindings = useNotebook();
  if (node.type === "aiExchange" && bindings) return <InlineExchange attrs={node.attrs ?? {}} entryId={entryId} bindings={bindings} onChange={(attrs) => bindings.store.patchNode(entryId, node.attrs!.id, attrs)} onDelete={() => bindings.store.removeExchange(entryId, node.attrs!.id)} />;
  if (node.type === "sourceCitation" && bindings) { const refs = node.attrs?.refs ?? []; return <CitationChip kind={node.attrs?.kind ?? "stated"} quoteMissing={!!node.attrs?.quoteMissing} label={citationLabel(refs, bindings)} refs={refs} onJump={bindings.onJumpToSource} pageLabel={bindings.pageLabel} />; }
  if (node.text !== undefined) {
    let content: ReactNode = node.text;
    for (const [i, mark] of (node.marks ?? []).entries()) {
      if (mark.type === "bold") content = <strong key={i}>{content}</strong>;
      else if (mark.type === "italic") content = <em key={i}>{content}</em>;
      else if (mark.type === "strike") content = <s key={i}>{content}</s>;
      else if (mark.type === "underline") content = <u key={i}>{content}</u>;
      else if (mark.type === "code") content = <code key={i}>{content}</code>;
      else if (mark.type === "link") content = <a key={i} href={safeDocumentUrl(mark.attrs?.href ?? "") ?? undefined} target="_blank" rel="noreferrer">{content}</a>;
    }
    return <>{content}</>;
  }
  const children = node.content?.map((child, i) => <RichContent key={child.attrs?.id ?? i} node={child} entryId={entryId} />);
  switch (node.type) {
    case "doc": return <>{children}</>;
    case "contribution": return <div className="nb-contribution"><div className="nb-contribution-origin"><Sparkles size={11} /><span title={node.attrs?.origin?.context}>AI-assisted{node.attrs?.originalHash !== fingerprint(node.content ?? []) ? " · edited" : ""}</span>{node.attrs?.origin?.conversationId ? <button type="button" onClick={() => { if (!bindings?.onOpenConversation?.(node.attrs!.origin.conversationId, node.attrs!.origin.turnId)) showNotice("The original conversation is no longer available. Your saved excerpt is kept here."); }}>Original answer</button> : null}</div>{children}</div>;
    case "paragraph": return <p>{children?.length ? children : <br />}</p>;
    case "heading": { const Tag = `h${Math.max(1, Math.min(6, node.attrs?.level ?? 2))}` as "h2"; return <Tag>{children}</Tag>; }
    case "bulletList": return <ul>{children}</ul>;
    case "orderedList": return <ol start={node.attrs?.start}>{children}</ol>;
    case "listItem": return <li>{children}</li>;
    case "blockquote": return <blockquote>{children}</blockquote>;
    case "codeBlock": return <pre><code>{children}</code></pre>;
    case "hardBreak": return <br />;
    case "horizontalRule": return <hr />;
    case "image": return <figure><img loading="lazy" src={node.attrs?.assetId ? bindings?.store.assetUrl(node.attrs.assetId) : safeDocumentUrl(node.attrs?.src ?? "", true) ?? undefined} alt={node.attrs?.alt ?? "Image"} /></figure>;
    case "inlineMath": case "blockMath": { const html = katex.renderToString(node.attrs?.latex ?? "", { displayMode: node.type === "blockMath", throwOnError: false, strict: false }); return node.type === "blockMath" ? <div className="nb-math" dangerouslySetInnerHTML={{ __html: html }} /> : <span dangerouslySetInnerHTML={{ __html: html }} />; }
    case "table": return <div className="nb-table-wrap"><table><tbody>{children}</tbody></table></div>;
    case "tableRow": return <tr>{children}</tr>;
    case "tableHeader": return <th colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>{children}</th>;
    case "tableCell": return <td colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>{children}</td>;
    default: return <>{children}</>;
  }
});

export default function RichEditor({ entryId, body, onChange, autoFocus = false, nested = false, onFinish }: { entryId: string; body: RichNode; onChange: (body: RichNode) => void; autoFocus?: boolean; nested?: boolean; onFinish?: () => void }) {
  const bindings = useNotebook()!;
  const callbacks = useRef({ onChange, onFinish }); callbacks.current = { onChange, onFinish };
  const lastBody = useRef(body);
  const ownUpdate = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const mathTarget = useRef<{ pos: number; block: boolean } | null>(null);
  const editorSelection = useRef<{ from: number; to: number } | null>(null);
  const [displayMath, setDisplayMath] = useState(false);
  const [input, setInput] = useState<"link" | "math" | null>(null), [inputText, setInputText] = useState("");
  const [proposal, setProposal] = useState<{ text: string; from: number; to: number; original: string; version: string } | null>(null);
  const [proposing, setProposing] = useState(false);
  const proposalController = useRef<AbortController | null>(null);
  const extensions = useMemo(() => [StarterKit.configure({ link: { openOnClick: false } }), NotebookImage.configure({ store: bindings.store, allowBase64: true }), TableKit, Mathematics.configure({ katexOptions: { throwOnError: false, strict: false },
    inlineOptions: { onClick: (node, pos) => { mathTarget.current = { pos, block: false }; setInputText(node.attrs.latex); setDisplayMath(false); setInput("math"); } },
    blockOptions: { onClick: (node, pos) => { mathTarget.current = { pos, block: true }; setInputText(node.attrs.latex); setDisplayMath(true); setInput("math"); } },
  }), Markdown, SourceCitation, Contribution, AiExchange.configure({ entryId })], [bindings.store, entryId]);
  const insertImage = useCallback(async (file: File, editor: Editor) => {
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("Choose an image smaller than 25 MB.");
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const assetId = bindings.store.addImageDataUrl(data);
      if (!editor.isDestroyed) editor.chain().focus().insertContent({ type: "image", attrs: { assetId, src: `asset:${assetId}`, alt: file.name } }).run();
    } catch (error) { showNotice(error instanceof Error ? error.message : "Couldn't add the image."); }
  }, [bindings.store]);
  const editor = useEditor({ extensions, content: body, immediatelyRender: true, shouldRerenderOnTransaction: false, autofocus: false,
    editorProps: { attributes: { class: "nb-rich-editor", role: "textbox", "aria-label": nested ? "Edit AI answer" : "Note text", "aria-multiline": "true", spellcheck: "true" },
      handlePaste: (_view, event) => { const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/")); if (!files.length) return false; event.preventDefault(); event.stopPropagation(); for (const file of files) void insertImage(file, editor!); return true; },
      handleDrop: (_view, event, _slice, moved) => { if (moved) return false; const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/")); if (!files.length) return false; event.preventDefault(); event.stopPropagation(); for (const file of files) void insertImage(file, editor!); return true; },
      handleKeyDown: (_view, event) => {
        if (event.isComposing) return false;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); bindings.store.checkpoint(); callbacks.current.onFinish?.(); return true; }
        if (event.key === "Escape") { event.preventDefault(); callbacks.current.onFinish?.(); return true; }
        if (event.key === "Enter" && editor?.state.selection.$from.parent.textContent.trim() === "/ask") {
          event.preventDefault(); editor.chain().deleteRange({ from: editor.state.selection.$from.start(), to: editor.state.selection.$from.end() }).insertContent(newExchange()).run(); return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => { if (ownUpdate.current) return; const value = current.getJSON() as RichNode; lastBody.current = value; callbacks.current.onChange(value); },
    onSelectionUpdate: ({ editor: current }) => { editorSelection.current = { from: current.state.selection.from, to: current.state.selection.to }; },
    onBlur: () => bindings.store.checkpoint(),
  });
  useEffect(() => {
    if (!editor || nested) return;
    const docId = bindings.store.docId;
    const selection = notebookView(docId).selections?.[entryId];
    if (autoFocus) {
      if (selection) editor.commands.setTextSelection({ from: Math.min(selection.from, editor.state.doc.content.size), to: Math.min(selection.to, editor.state.doc.content.size) });
      else editor.commands.setTextSelection(Math.max(0, editor.state.doc.content.size - 1));
      // Focus synchronously. A delayed editor.focus() frame can steal focus
      // after a reader has already started typing into an inline question.
      const question = editor.view.dom.querySelector<HTMLTextAreaElement>('.nb-ai-question');
      if (!selection && question && !question.value) question.focus();
      else editor.view.focus();
    }
    return () => { if (editorSelection.current) rememberNotebookView(docId, { selections: { ...notebookView(docId).selections, [entryId]: editorSelection.current } }); };
  }, [editor, nested, entryId, bindings.store, autoFocus]);
  useEffect(() => {
    if (!editor || nested) return;
    return bindings.store.subscribePatches((patch) => {
      if (patch.entryId !== entryId || editor.isDestroyed) return;
      ownUpdate.current = true;
      try {
        editor.state.doc.descendants((node, pos) => {
          if (node.attrs.id !== patch.nodeId) return;
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch.attrs }).setMeta("addToHistory", false));
          return false;
        });
        lastBody.current = bindings.store.getEntry(entryId)?.body ?? lastBody.current;
      } finally { ownUpdate.current = false; }
    });
  }, [bindings.store, editor, entryId, nested]);
  useEffect(() => {
    if (!editor || editor.isDestroyed || body === lastBody.current) return;
    // External structural operations (combine, follow-up, restore) preserve
    // the current caret. Streaming uses targeted transactions above.
    const selection = editor.state.selection;
    ownUpdate.current = true;
    editor.commands.setContent(body, { emitUpdate: false });
    editor.commands.setTextSelection({ from: Math.min(selection.from, editor.state.doc.content.size), to: Math.min(selection.to, editor.state.doc.content.size) });
    lastBody.current = body; ownUpdate.current = false;
  }, [body, editor]);
  useEffect(() => () => { proposalController.current?.abort(); }, []);
  const state = useEditorState({ editor, selector: ({ editor: current }) => ({ bold: current?.isActive("bold"), italic: current?.isActive("italic"), undo: current?.can().undo(), redo: current?.can().redo(), table: current?.isActive("table"), selected: current ? !current.state.selection.empty : false }) });
  if (!editor) return null;
  const tool = (label: string, icon: ReactNode, action: () => void, active = false, disabled = false) => <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={action}>{icon}</button>;
  const propose = async (operation: "clarify" | "shorten") => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "\n"); if (!text.trim()) return;
    const original = JSON.stringify(editor.getJSON());
    const controller = new AbortController(); proposalController.current?.abort(); proposalController.current = controller; setProposing(true);
    try { const result = await writingProposal(text, operation, [], controller.signal); if (!controller.signal.aborted) setProposal({ text: result, from, to, original: text, version: original }); }
    catch (error) { if (!controller.signal.aborted) showNotice(error instanceof Error ? error.message : "Couldn't prepare a suggestion."); }
    finally { if (proposalController.current === controller) setProposing(false); }
  };
  return <div className={`nb-editor-shell${nested ? " is-nested" : ""}`}>
    <div className="nb-format-toolbar" role="toolbar" aria-label="Note formatting">
      {tool("Bold", <Bold size={14} />, () => editor.chain().focus().toggleBold().run(), state?.bold)}
      {tool("Italic", <Italic size={14} />, () => editor.chain().focus().toggleItalic().run(), state?.italic)}
      {tool("Heading", <Heading2 size={14} />, () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
      {tool("Bullet list", <List size={14} />, () => editor.chain().focus().toggleBulletList().run())}
      {tool("Quote", <Quote size={14} />, () => editor.chain().focus().toggleBlockquote().run())}
      {tool("Code block", <Code size={14} />, () => editor.chain().focus().toggleCodeBlock().run())}
      {tool("Link", <Link size={14} />, () => { setInput("link"); setInputText(editor.getAttributes("link").href ?? ""); })}
      {tool("Insert image", <ImagePlus size={14} />, () => imageInput.current?.click())}
      {tool("Insert table", <Table2 size={14} />, () => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run())}
      {tool("Insert equation", <Sigma size={14} />, () => { mathTarget.current = null; setDisplayMath(false); setInput("math"); setInputText(""); })}
      {!nested ? tool("Ask AI here", <Sparkles size={14} />, () => editor.chain().focus().insertContent([newExchange(), { type: "paragraph" }]).run()) : null}
      {tool("Undo", <Undo2 size={14} />, () => editor.chain().focus().undo().run(), false, !state?.undo)}
      {tool("Redo", <Redo2 size={14} />, () => editor.chain().focus().redo().run(), false, !state?.redo)}
    </div>
    {input ? <form className="nb-insert-form" onSubmit={(event) => { event.preventDefault(); if (input === "math") {
      const target = mathTarget.current;
      if (target && editor.state.doc.nodeAt(target.pos)?.type.name === (target.block ? "blockMath" : "inlineMath")) {
        if (target.block) editor.chain().focus().updateBlockMath({ latex: inputText, pos: target.pos }).run();
        else editor.chain().focus().updateInlineMath({ latex: inputText, pos: target.pos }).run();
      } else if (displayMath) editor.chain().focus().insertBlockMath({ latex: inputText }).run();
      else editor.chain().focus().insertInlineMath({ latex: inputText }).run();
    } else if (safeDocumentUrl(inputText)) editor.chain().focus().extendMarkRange("link").setLink({ href: inputText }).run(); setInput(null); }}><input autoFocus aria-label={input === "math" ? "LaTeX equation" : "Link URL"} placeholder={input === "math" ? "E = mc^2" : "https://…"} value={inputText} onChange={(event) => setInputText(event.target.value)} /><button type="submit">{mathTarget.current && input === "math" ? "Update" : "Insert"}</button>{input === "math" && !mathTarget.current ? <label><input type="checkbox" checked={displayMath} onChange={(event) => setDisplayMath(event.target.checked)} /> Display</label> : null}<button type="button" onClick={() => setInput(null)}>Cancel</button></form> : null}
    {state?.table ? <div className="nb-table-tools" role="toolbar" aria-label="Table editing"><button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button><button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</button><button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</button><button type="button" onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</button><button type="button" onClick={() => editor.chain().focus().deleteTable().run()}>Remove table</button></div> : null}
    <EditorContent editor={editor} />
    {state?.selected && !nested ? <div className="nb-writing-actions"><button type="button" disabled={proposing} onClick={() => void propose("clarify")}>Clarify</button><button type="button" disabled={proposing} onClick={() => void propose("shorten")}>Shorten</button>{proposing ? <button type="button" onClick={() => proposalController.current?.abort()}>Stop</button> : null}</div> : null}
    {proposal ? <div className="nb-proposal"><span className="nb-eyebrow">Suggested wording</span><AnswerMarkdown content={proposal.text} sources={[]} onJump={bindings.onJumpToSource} pageLabel={bindings.pageLabel} /><div><button type="button" disabled={JSON.stringify(editor.getJSON()) !== proposal.version} onClick={() => { editor.chain().focus().insertContentAt({ from: proposal.from, to: proposal.to }, parseRichMarkdown(proposal.text).content ?? []).run(); setProposal(null); }}>Replace selection</button><button type="button" onClick={() => { editor.chain().focus("end").insertContent(parseRichMarkdown(proposal.text).content ?? []).run(); setProposal(null); }}>Insert below</button><button type="button" onClick={() => setProposal(null)}>Dismiss</button></div></div> : null}
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => { for (const file of Array.from(event.target.files ?? [])) void insertImage(file, editor); event.target.value = ""; }} />
    {!nested ? <div className="nb-editor-footer"><span>⌘↵ to finish · changes save automatically</span><button type="button" onClick={() => { bindings.store.checkpoint(); onFinish?.(); }}>Done</button></div> : null}
  </div>;
}
