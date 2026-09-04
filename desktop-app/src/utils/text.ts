export function countNovelCharacters(content: string): number {
  return [...content.replace(/[\s\u200B-\u200D\uFEFF]/gu, '')].length;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function sliceToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return '';
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** Normalize and bound text included in prompts sent from the desktop app. */
export function compactText(value: unknown, maxBytes: number): string {
  const text = String(value ?? '').replace(/[\t ]+/gu, ' ').replace(/\r\n?/gu, '\n').trim();
  if (!text || maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n…\n';
  if (maxBytes <= byteLength(marker) + 24) return sliceToBytes(text, maxBytes);
  const available = maxBytes - byteLength(marker);
  const head = sliceToBytes(text, Math.floor(available * 0.62));
  const reversed = Array.from(text).reverse().join('');
  const tail = Array.from(sliceToBytes(reversed, Math.max(0, available - byteLength(head))))
    .reverse().join('');
  return `${head}${marker}${tail}`;
}
