import type { SourceRef } from "./types.ts";

// The sources block and evidence rules shared by grounded answers. Reply
// style stays separate so Ask and Deep Dive can choose their own depth.

export function renderSources(sources: SourceRef[], pageLabel: (pageNumber: number) => string): string {
  return sources
    .map((source) => {
      // Only the dive context experiments set these; without them the
      // block is exactly as before.
      const is = source.is ? ` is="${source.is.replace(/"/g, "'")}"` : "";
      const sec = source.section ? ` sec="${source.section.replace(/"/g, "'")}"` : "";
      const where = source.locationLabel ? `at="${source.locationLabel.replace(/["<>]/g, "'")}"` : `p="${pageLabel(source.pageNumber)}"`;
      return `<source id="${source.label}" ${where}${is}${sec}>${source.text}</source>`;
    })
    .join("\n");
}

export const CITATION_RULES = `- Cite document claims by source id: [S2] (several: [S2][S5]). One citation at the end of a paragraph or list item can cover nearby claims supported by the same passage. Cite separately when the supporting passage changes.
- Mark inferences from the document with [inferred: S2] and outside knowledge with [general].
- Quote only when the original wording matters. Quote prose word for word, in quotation marks, with its own citation. Write formulas in LaTeX.`;

export const SOURCE_RULES = `${CITATION_RULES}
- Never cite an id that isn't listed above.
- If the sources don't address the question at all, reply only "[not-covered]" and one sentence saying so.`;

// Deep Dive's default answer style; Ask supplies its own style with SOURCE_RULES.
export const GROUNDING_RULES = `How to answer:
- Answer first, in one to three plain sentences. Add short steps or bullets only if the question truly needs them. Stay under about 120 words unless the reader asks for more. No preamble, no recap, don't restate the question.
${SOURCE_RULES}`;

// How answers write math — every grounded surface (Deep Dive, Ask) uses it,
// so equations render the same everywhere. The sources are text extracted
// from the PDF, where formulas often come out garbled (superscripts
// flattened, symbols split: "e−|α|2/2" for e^{-|α|^2/2}); copied as is, they
// can't be rendered as math at all.
export const MATH_RULES = `Formatting: markdown with KaTeX math.
- Write every mathematical expression, even a lone variable, as LaTeX in $...$ — never raw ^, unicode superscripts or subscripts, √, Σ, ⟩, or bare Greek letters.
- Put any equation that matters on its own line as $$...$$, with a blank line before and after.
- Preserve valid TeX from native text sources. Formulas extracted from PDFs may be garbled (superscripts flattened, symbols split apart); reconstruct their intended notation as proper LaTeX.`;
