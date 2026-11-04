import { memo, useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

// Imported only when a document actually contains math. The generated HTML
// comes exclusively from KaTeX with trust disabled, never from the document.
export default memo(function MathRun({ value, display }: { value: string; display: boolean }) {
  const html = useMemo(() => katex.renderToString(value, { displayMode: display, throwOnError: false, trust: false, strict: false,
    maxExpand: 1000, maxSize: 20 }), [value, display]);
  return <span className={display ? "flow-math-display" : "flow-math"} dangerouslySetInnerHTML={{ __html: html }} />;
});
