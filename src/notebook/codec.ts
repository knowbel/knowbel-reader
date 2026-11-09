import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import Mathematics from "@tiptap/extension-mathematics";
import { localizeClaim, parseAnswer } from "../grounding/citations.ts";
import { normalizeMathNotation } from "../deepdive/mathNotation.ts";
import type { SourceRef } from "../grounding/types";
import type { RichNode } from "./model";

let manager: MarkdownManager | undefined;
export function parseRichMarkdown(markdown: string, sources: SourceRef[] = []): RichNode {
  manager ??= new MarkdownManager({ extensions: [StarterKit, Image, TableKit, Mathematics] });
  const text = normalizeMathNotation(markdown, { promote: true });
  const groups = parseAnswer(text, sources).groups;
  let replaced = text;
  for (let i = groups.length - 1; i >= 0; i--) replaced = replaced.slice(0, groups[i].start) + `KNOWBELCITATION${i}TOKEN` + replaced.slice(groups[i].end);
  const parsed = manager.parse(replaced) as RichNode;
  const transform = (node: RichNode): RichNode[] => {
    if (node.text?.includes("KNOWBELCITATION")) {
      return node.text.split(/(KNOWBELCITATION\d+TOKEN)/g).filter(Boolean).map((part): RichNode => {
        const match = /^KNOWBELCITATION(\d+)TOKEN$/.exec(part);
        if (!match) return { ...node, text: part };
        const group = groups[Number(match[1])];
        const refs = sources.filter((source) => group.labels.includes(source.label.toUpperCase())).map((source) => ({ source, range: localizeClaim(group.claim, source) }));
        return { type: "sourceCitation", attrs: { refs, kind: group.kind, quoteMissing: group.quoteMissing } };
      });
    }
    return [{ ...node, ...(node.content ? { content: node.content.flatMap(transform) } : {}) }];
  };
  return transform(parsed)[0];
}
