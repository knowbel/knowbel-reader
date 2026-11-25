import { memo } from "react";
import MathRun from "../document/MathRun";
import { inlineMathParts } from "./mathNotation";

// These strings also appear inside labels and buttons. Render equations as
// inline spans, with the surrounding text passed through as plain text.
export default memo(function InlineDiveMath({ text }: { text: string }) {
  return <span className="dive-inline-math">
    {inlineMathParts(text).map(({ text, tex }, index) =>
      tex ? <MathRun key={index} value={tex} display={false} fallback={text} /> : text)}
  </span>;
});
