import { DomUtils, parseDocument } from "htmlparser2";

const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "title", "desc", "use"]);
const attributes = new Set(["id", "xmlns", "viewbox", "width", "height", "preserveaspectratio", "d", "points", "x", "y", "x1", "x2", "y1", "y2", "dx", "dy", "cx", "cy", "r", "rx", "ry", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "transform", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "clippathunits", "clip-path", "mask", "href", "xlink:href"]);
const caseNames: Record<string, string> = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath", viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits", gradienttransform: "gradientTransform", clippathunits: "clipPathUnits" };

export function inertSvg(source: string): string | null {
  const tree = parseDocument(source);
  const root = DomUtils.findOne((node) => node.name === "svg", tree.children);
  if (!root) return null;
  const sanitize = (node: typeof root) => {
    for (const child of [...node.children]) {
      if (!("attribs" in child)) { if (child.type !== "text") DomUtils.removeElement(child); continue; }
      if (!tags.has(child.name)) DomUtils.removeElement(child);
      else sanitize(child);
    }
    for (const [name, value] of Object.entries(node.attribs)) {
      if (!attributes.has(name) || ((name === "href" || name === "xlink:href") && !/^#[\w.-]+$/.test(value)) || /url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) delete node.attribs[name];
      else if (Object.hasOwn(caseNames, name)) { delete node.attribs[name]; node.attribs[caseNames[name]] = value; }
    }
    if (Object.hasOwn(caseNames, node.name)) node.name = caseNames[node.name];
  };
  sanitize(root);
  root.attribs.xmlns = "http://www.w3.org/2000/svg";
  return DomUtils.getOuterHTML(root, { xmlMode: true });
}
