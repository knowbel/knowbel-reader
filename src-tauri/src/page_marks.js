/* oxlint-disable no-unused-expressions */
// Painting, quotation matching and repainting after the site re-renders live
// in page_bridge.js, which the page loads before its own scripts.
(marks, focus, settings) => {
  const page = window.__knowbelPage;
  if (!page) return { marked: 0, found: false };
  if (settings && typeof settings === 'object') page.configure(settings);
  return page.paint(marks, focus);
}
