import { memo, useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

// KaTeX generates the HTML with trust disabled.
export default memo(function MathRun({ value, display, fallback }: { value: string; display: boolean; fallback?: string }) {
  const hasFallback = fallback !== undefined;
  const html = useMemo(() => {
    try {
      return katex.renderToString(value, { displayMode: display, throwOnError: hasFallback, trust: false, strict: false,
        maxExpand: 1000, maxSize: 20 });
    } catch (error) {
      if (hasFallback && error instanceof katex.ParseError) return null;
      throw error;
    }
  }, [value, display, hasFallback]);
  return html === null ? <span>{fallback}</span> :
    <span className={display ? "flow-math-display" : "flow-math"} dangerouslySetInnerHTML={{ __html: html }} />;
});
