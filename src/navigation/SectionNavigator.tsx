import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DocumentEngine } from "../document/engine";
import type { FlowAnchor } from "../document/model";
import ReaderNavigator from "./ReaderNavigator";

export default function SectionNavigator({ engine, currentUnit, sequence, back, forward,
  onBack, onForward, onNavigate, focusRequest }: {
  engine: DocumentEngine;
  currentUnit: number;
  sequence: number;
  back: FlowAnchor[];
  forward: FlowAnchor[];
  onBack: (steps: number) => void;
  onForward: (steps: number) => void;
  onNavigate: (anchor: FlowAnchor) => void;
  focusRequest: number;
}) {
  const sections = useMemo(() => {
    const document = engine.document;
    const entries = document.outline.map((heading) => ({
      title: heading.title, unit: (engine.blockIndex.get(heading.blockId) ?? 0) + 1,
    }));
    // Include the document's opening even when it has no heading.
    if (document.blocks.length && entries[0]?.unit !== 1) entries.unshift({ title: document.title, unit: 1 });
    return entries;
  }, [engine]);
  let current = 0;
  for (let index = 0; index < sections.length && sections[index].unit <= currentUnit; index++) current = index;
  const goTo = (index: number) => {
    const section = sections[index];
    if (section) onNavigate(engine.anchorForRange(section.unit, 0, 0));
  };

  return <ReaderNavigator
    ariaLabel="Section navigation"
    locationKey={`${currentUnit}:${sequence}`}
    locationLabel={engine.labelForUnit(currentUnit)}
    back={back} forward={forward}
    placeLabel={(anchor) => engine.labelForUnit(engine.unitForAnchor(anchor))}
    onBack={onBack} onForward={onForward} focusRequest={focusRequest}
  >
    <button type="button" className="page-nav-button" aria-label="Previous section" title="Previous section"
      disabled={current <= 0} onClick={() => goTo(current - 1)}>
      <ChevronLeft width={16} height={16} aria-hidden="true" />
    </button>
    <select data-navigation-location className="page-nav-section" aria-label="Section" title="Go to section (⌥⌘G)"
      value={sections.length ? current : ""} disabled={!sections.length} onChange={(event) => goTo(Number(event.target.value))}>
      {sections.length ? sections.map((section, index) => <option key={section.unit} value={index}>{section.title}</option>) :
        <option value="">{engine.document.title}</option>}
    </select>
    <button type="button" className="page-nav-button" aria-label="Next section" title="Next section"
      disabled={current >= sections.length - 1} onClick={() => goTo(current + 1)}>
      <ChevronRight width={16} height={16} aria-hidden="true" />
    </button>
  </ReaderNavigator>;
}
