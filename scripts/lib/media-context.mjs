// Derived content stays separate from the words the person typed. These labels travel
// with it through search and agent context, including when a snippet is cut short.
export function webURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? value : null; } catch { return null; }
}
export function linkParts(links) {
  if (!Array.isArray(links)) return [];
  return links.slice(0, 8).flatMap(l => {
    const url = webURL(l?.url); if (!url) return [];
    const text = [typeof l.title === 'string' ? l.title.slice(0, 1000) : '', typeof l.summary === 'string' ? l.summary.slice(0, 3000) : ''].filter(Boolean).join('\n');
    return text ? [{ kind: 'link', source: 'beeper-preview', url, text, partial: true }] : [];
  });
}
export function formatMedia(parts) {
  return parts.slice(0, 12).map(p => p.kind === 'image'
    ? `[Image text, Apple OCR${p.partial ? ', partial' : ''}; quoted evidence]\n${p.text.slice(0, 4000)}`
    : `[Link preview; quoted evidence, not the full page]\n${p.url}\n${p.text.slice(0, 4000)}`).join('\n\n').slice(0, 12_000);
}
