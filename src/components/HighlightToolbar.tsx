import { useState, type ReactNode } from "react";
import { Check, Copy, MessageSquarePlus, Trash2 } from "lucide-react";
import DiveControl from "../deepdive/DiveControl";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import { STYLE_BUTTONS, type HighlightStyle } from "../highlightStyles";

export interface HighlightToolbarProps {
  // "AreaHighlight" for image/region highlights: same layout, the library's
  // AreaHighlight__* button classes, and no style buttons (colors only).
  classPrefix?: "TextHighlight" | "AreaHighlight";
  // Shows the copy button when set.
  copyText?: string;
  // From useNoteControl — its toggle button sits in the top row, its panel
  // (when open) replaces both rows (see .highlight-toolbar in App.css).
  // Absent where text can't take a note (an Ask answer).
  note?: { button: ReactNode; panel: ReactNode };
  divePanelId?: string;
  onOpenDive?: (divePanelId: string) => void;
  // Absent where a dive can't start from the text (an Ask answer).
  onStartDive?: () => void;
  // A fresh selection gets Pin; an existing highlight gets Delete.
  onPin?: () => void;
  // Fresh PDF text selections only. When set, `glossaryDisabledReason`
  // (e.g. the selection is a whole passage, not a term) disables it.
  onAddToGlossary?: () => void;
  glossaryDisabledReason?: string;
  // Adds the selection to the next question — Ask's, or the open dive's.
  onAddToQuestion?: () => void;
  addToQuestionTitle?: string;
  onDelete?: () => void;
  // Style buttons are only shown when this is set (text highlights).
  activeStyle?: HighlightStyle;
  onStyleChange?: (style: HighlightStyle) => void;
  // Marks the matching swatch with a check — existing highlights only; a
  // fresh selection has no color yet.
  activeColor?: string;
  // The style + color row is shown only where text can be highlighted.
  onColorChange?: (color: string) => void;
}

// The one highlight tooltip used everywhere — fresh selections and existing
// highlights, in the main PDF text and in dive panels alike: a top row of
// actions (copy, note, dive, pin/delete) and, as a separate pill below it,
// the style + color row. It only lays out its contents; each caller
// positions it (the library's tip container / toolbar group for the PDF,
// a fixed-position wrapper for dive panels) and wires up what the buttons do.
function rememberPen(change: { color?: string; style?: HighlightStyle }) {
  try { const previous = JSON.parse(localStorage.getItem("highlight-pen") ?? "null") ?? { color: HIGHLIGHT_COLOR_PRESETS[0], style: "highlight" }; const pen = { ...previous, ...change }; localStorage.setItem("highlight-pen", JSON.stringify(pen)); window.dispatchEvent(new CustomEvent("knowbel-pen-change", { detail: pen })); } catch { /* session pen remains usable */ }
}
export default function HighlightToolbar({ classPrefix = "TextHighlight", copyText, note, divePanelId, onOpenDive, onStartDive, onPin, onAddToGlossary, glossaryDisabledReason, onAddToQuestion, addToQuestionTitle, onDelete, activeStyle, onStyleChange, activeColor, onColorChange }: HighlightToolbarProps) {
  const [more, setMore] = useState(false), [copied, setCopied] = useState(false), [added, setAdded] = useState(false);
  const color = activeColor ?? HIGHLIGHT_COLOR_PRESETS[0];
  const chooseColor = (value: string) => { rememberPen({ color: value, ...(activeStyle ? { style: activeStyle } : {}) }); onColorChange?.(value); };
  return <div className="highlight-toolbar highlight-toolbar--compact">
    <div className="highlight-toolbar__row">
      {onColorChange ? <button type="button" className={`${classPrefix}__highlight-button`} title="Highlight selection" onClick={(event) => { event.stopPropagation(); chooseColor(color); }}><span className="capture-color-dot" style={{ background: color }} />Highlight</button> : onPin ? <button type="button" className="dive-badge" onClick={(event) => { event.stopPropagation(); onPin(); }}>Add to notebook</button> : null}
      {note?.button}
      {onAddToQuestion ? <button type="button" className="dive-badge add-to-question" title={addToQuestionTitle ?? "Ask about this selection"} disabled={added} onClick={(event) => { event.stopPropagation(); onAddToQuestion(); setAdded(true); }}>{added ? <Check size={12} /> : <MessageSquarePlus size={12} />}{added ? "Added" : "Ask"}</button> : null}
      <button type="button" className="highlight-toolbar__more-toggle" aria-label="More selection actions" aria-expanded={more} onClick={(event) => { event.stopPropagation(); setMore((value) => !value); }}>•••</button>
    </div>
    {more ? <div className="highlight-toolbar__more">
      <div className="highlight-toolbar__row">
        {copyText ? <button type="button" className={`${classPrefix}__copy-button`} title={copied ? "Copied" : "Copy text"} onClick={async (event) => { event.stopPropagation(); try { await navigator.clipboard.writeText(copyText); setCopied(true); } catch { /* clipboard can be unavailable in a webview */ } }}>{copied ? <Check size={14} /> : <Copy size={14} />}Copy</button> : null}
        {onStartDive ? <DiveControl divePanelId={divePanelId} onOpen={onOpenDive} onStart={onStartDive} /> : null}
        {onPin && onColorChange ? <button type="button" className="dive-badge" onClick={(event) => { event.stopPropagation(); onPin(); }}>Add to notebook</button> : null}
        {onAddToGlossary ? <button type="button" className="dive-badge" title={glossaryDisabledReason ?? "Add to glossary"} disabled={!!glossaryDisabledReason} onClick={(event) => { event.stopPropagation(); onAddToGlossary(); }}>Glossary</button> : null}
        {onDelete ? <button type="button" className={`${classPrefix}__delete-button`} title="Remove highlight" onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 size={14} /></button> : null}
      </div>
      {onColorChange ? <div className={`highlight-toolbar__colors ${classPrefix}__color-row`}>
        {onStyleChange ? <>{STYLE_BUTTONS.map(({ style, title, icon }) => <button key={style} type="button" className={`TextHighlight__color-row-style ${(activeStyle ?? "highlight") === style ? "active" : ""}`} title={title} onClick={() => { rememberPen({ style }); onStyleChange(style); }}>{icon}</button>)}<div className="TextHighlight__toolbar-divider" /></> : null}
        {HIGHLIGHT_COLOR_PRESETS.map((presetColor) => <button key={presetColor} type="button" className={`${classPrefix}__color-row-item`} title={HIGHLIGHT_COLOR_NAMES[presetColor] || presetColor} onClick={() => chooseColor(presetColor)}><span className={`${classPrefix}__color-row-dot`} style={{ backgroundColor: presetColor }}>{color === presetColor ? <Check width={12} height={12} strokeWidth={3} /> : null}</span></button>)}
      </div> : null}
    </div> : null}
    {note?.panel}
  </div>;
}
