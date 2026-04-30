export function isUnusableHomeGraphExtractionText(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  if (!text) return true;
  const normalized = text.toLowerCase();
  if (normalized.includes('pdf extraction produced limited text')
    || normalized.includes('no readable text streams')
    || normalized.includes('no specialized extractor matched')
    || normalized.includes('has no specialized in-core extractor')) {
    return true;
  }
  if (looksLikeRawPdfPayload(text)) return true;
  return looksBinaryLike(text);
}

function looksLikeRawPdfPayload(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('%pdf')
    || /\b\d+\s+\d+\s+obj\b/.test(lower)
    || (lower.includes(' endobj') && lower.includes(' stream'))
    || (lower.includes('/filter') && lower.includes('/flatedecode'));
}

function looksBinaryLike(value: string): boolean {
  const sample = value.slice(0, 4_096);
  if (sample.length < 120) return false;
  let control = 0;
  let extended = 0;
  let letters = 0;
  let whitespace = 0;
  let punctuation = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if ((code < 32 && char !== '\n' && char !== '\r' && char !== '\t') || code === 65533) control += 1;
    if (code > 126) extended += 1;
    if (/[a-z0-9]/i.test(char)) letters += 1;
    if (/\s/.test(char)) whitespace += 1;
    if (/[^a-z0-9\s]/i.test(char)) punctuation += 1;
  }
  const length = sample.length;
  const extendedRatio = extended / length;
  const usefulRatio = (letters + whitespace) / length;
  const punctuationRatio = punctuation / length;
  return control > 0
    || (extendedRatio > 0.18 && usefulRatio < 0.78)
    || (punctuationRatio > 0.42 && whitespace / length < 0.08);
}
