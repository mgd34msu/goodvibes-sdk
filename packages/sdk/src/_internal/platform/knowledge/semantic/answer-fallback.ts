import type { KnowledgeNodeRecord } from '../types.js';
import { isLowValueFeatureOrSpecText } from './fact-quality.js';
import { clampText, normalizeWhitespace, readString } from './utils.js';

export interface AnswerFallbackEvidence {
  readonly title: string;
  readonly excerpt?: string;
}

export interface FallbackAnswer {
  readonly text: string;
  readonly synthesized: boolean;
}

export function renderFallbackAnswer(
  query: string,
  mode: string,
  evidence: readonly AnswerFallbackEvidence[],
  facts: readonly KnowledgeNodeRecord[],
): FallbackAnswer {
  const factLimit = mode === 'detailed' ? 12 : mode === 'concise' ? 3 : 8;
  const factPhrases = facts.slice(0, factLimit).map(renderFactPhrase).filter(Boolean);
  const profile = renderFeatureProfile(query, facts, evidence);
  if (profile) {
    return {
      synthesized: true,
      text: profile,
    };
  }
  if (factPhrases.length > 0) {
    return {
      synthesized: true,
      text: `${joinFactPhrases(factPhrases)}.`,
    };
  }
  const sourceTitles = evidence
    .slice(0, mode === 'detailed' ? 6 : mode === 'concise' ? 2 : 4)
    .map((item) => normalizeWhitespace(item.title))
    .filter(Boolean);
  if (sourceTitles.length > 0) {
    return {
      synthesized: false,
      text: `I found matching sources (${joinFactPhrases(sourceTitles)}), but they have not produced enough source-backed facts to answer "${query}" yet.`,
    };
  }
  return {
    synthesized: false,
    text: `No knowledge matched "${query}".`,
  };
}

function renderFactPhrase(fact: KnowledgeNodeRecord): string {
  const value = readString(fact.metadata.value);
  const summary = fact.summary ?? readString(fact.metadata.evidence);
  const phrase = value ? `${fact.title}: ${value}` : summary ? `${fact.title}: ${summary}` : fact.title;
  const cleaned = normalizeWhitespace(clampText(phrase, 220));
  if (isRawSourceFragment(cleaned)) return '';
  return isLowValueFeatureOrSpecText(cleaned) ? '' : cleaned;
}

function renderFeatureProfile(
  query: string,
  facts: readonly KnowledgeNodeRecord[],
  evidence: readonly AnswerFallbackEvidence[],
): string | null {
  if (!/\b(feature|features|capabilit|spec|specs|specification|specifications|support|supports)\b/i.test(query)) return null;
  const phrases = collectProfilePhrases(facts, evidence);
  const combined = phrases.join(' ');
  const details = {
    display: featureProfileTerms(combined, 'display').slice(0, 8),
    smart: featureProfileTerms(combined, 'smart').slice(0, 5),
    connectivity: featureProfileTerms(combined, 'connectivity').slice(0, 6),
    audio: featureProfileTerms(combined, 'audio').slice(0, 5),
    gaming: featureProfileTerms(combined, 'gaming').slice(0, 5),
  };
  const sentences: string[] = [];
  if (details.display.length > 0) sentences.push(`Display: ${joinFactPhrases(details.display)}.`);
  if (details.smart.length > 0) sentences.push(`Smart TV features: ${joinFactPhrases(details.smart)}.`);
  if (details.connectivity.length > 0) sentences.push(`Connectivity and ports: ${joinFactPhrases(details.connectivity)}.`);
  if (details.audio.length > 0) sentences.push(`Audio: ${joinFactPhrases(details.audio)}.`);
  if (details.gaming.length > 0) sentences.push(`Gaming-related capabilities: ${joinFactPhrases(details.gaming)}.`);
  if (sentences.length >= 2) return sentences.join(' ');
  if (sentences.length === 1 && hasSpecificFeatureProfileIntent(query)) return sentences[0] ?? null;
  return null;
}

function collectProfilePhrases(
  facts: readonly KnowledgeNodeRecord[],
  evidence: readonly AnswerFallbackEvidence[],
): string[] {
  const phrases: string[] = [];
  for (const fact of facts) {
    const phrase = renderFactPhrase(fact);
    if (phrase) phrases.push(phrase);
  }
  if (phrases.length < 2) return uniqueCaseInsensitive(phrases);
  for (const item of evidence) {
    const excerpt = readEvidenceExcerpt(item);
    if (excerpt) phrases.push(excerpt);
  }
  return uniqueCaseInsensitive(phrases);
}

function readEvidenceExcerpt(item: AnswerFallbackEvidence): string {
  const raw = normalizeWhitespace(item.excerpt ?? '');
  if (!raw) return '';
  const cleaned = normalizeWhitespace(clampText(stripSourceAddressFragments(raw), 260));
  if (isRawSourceFragment(cleaned)) return '';
  return isLowValueFeatureOrSpecText(cleaned) ? '' : cleaned;
}

type FeatureProfileCategory = 'display' | 'smart' | 'connectivity' | 'audio' | 'gaming';

function featureProfileTerms(value: string, category: FeatureProfileCategory): string[] {
  const termMap: Record<FeatureProfileCategory, readonly [string, RegExp][]> = {
    display: [
      ['screen size/class', /\b\d{2,3}(?:\.0)?\s*(?:inch|inches|in\.|")\b/i],
      ['4K UHD resolution', /\b4k\b|\buhd\b|\b3840\s*(?:x|×)\s*2160\b/i],
      ['display panel technology', /\boled\b|\bqled\b|\bmini[- ]?led\b|\bled\b|\blcd\b/i],
      ['LCD/LED display', /\blcd\b|\bled\b/i],
      ['100/120 Hz refresh rate', /\b(?:100|120)\s*hz\b|\btrumotion\s*240\b/i],
      ['HDR10', /\bhdr10\b/i],
      ['Dolby Vision', /\bdolby vision\b/i],
      ['HLG', /\bhlg\b/i],
      ['Filmmaker Mode', /\bfilmmaker mode\b/i],
    ],
    smart: [
      ['webOS smart TV platform', /\bwebos\b/i],
      ['vendor smart-home integration', /\bsmartthings\b|\bhomekit\b|\bgoogle home\b|\balexa\b/i],
      ['Apple AirPlay 2', /\bairplay\s*2?\b/i],
      ['Apple HomeKit', /\bhomekit\b/i],
      ['voice assistant support', /\bvoice\b|\balexa\b|\bgoogle assistant\b/i],
      ['streaming app support', /\bapps?\b|\bstreaming\b/i],
    ],
    connectivity: [
      ['HDMI inputs', /\bhdmi\b/i],
      ['HDMI ARC/eARC', /\bearc\b|\barc\b/i],
      ['USB ports', /\busb\b/i],
      ['Ethernet/LAN', /\bethernet\b|\blan\b|\brj-?45\b/i],
      ['Wi-Fi/wireless LAN', /\bwi-?fi\b|\bwireless lan\b/i],
      ['Bluetooth', /\bbluetooth\b/i],
      ['Optical audio output', /\boptical\b|\btoslink\b/i],
      ['RF/antenna input', /\brf\b|\bantenna\b/i],
      ['ATSC/Clear QAM tuner support', /\batsc\b|\bclear qam\b|\bqam\b|\btuner\b/i],
      ['RS-232C/external control', /\brs-?232c?\b|\bexternal control\b/i],
    ],
    audio: [
      ['speaker/audio output', /\bspeakers?\b|\b(?:10|20|40)\s*w\b|\b2(?:\.0)?\s*ch\b/i],
      ['Dolby audio formats', /\bdolby atmos\b|\bdolby digital\b|\bdolby audio\b|\btruehd\b|\bpcm\b/i],
      ['HDMI ARC/eARC audio', /\bearc\b|\barc\b/i],
    ],
    gaming: [
      ['FreeSync/VRR support', /\bfreesync\b|\bvrr\b/i],
      ['ALLM/low-latency support', /\ballm\b|\blow latency\b/i],
      ['Game Optimizer/game mode', /\bgame optimizer\b|\bgame mode\b|\bgaming\b/i],
      ['4K/120 Hz or high-bandwidth HDMI', /\bhdmi\s*2\.1\b|\b4k\s*(?:at|@)?\s*120\b|\b120\s*hz\b/i],
    ],
  };
  return termMap[category]
    .filter(([, pattern]) => pattern.test(value))
    .map(([label]) => label);
}

function uniqueCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function hasSpecificFeatureProfileIntent(query: string): boolean {
  return /\b(hdr|display|screen|refresh|ports?|hdmi|earc|arc|usb|ethernet|optical|rf|antenna|rs-?232c?|audio|speaker|wireless|wi-?fi|bluetooth|gaming|vrr|allm|freesync|smart|webos|tuner|atsc|qam|dolby vision|hlg)\b/i.test(query);
}

function isRawSourceFragment(value: string): boolean {
  const lower = value.toLowerCase();
  return /\bsemantic-gap-repair\b/.test(lower)
    || /\bsource-backed facts identify\b/.test(lower)
    || /\b(manual\.nz|current page|loading)\b/.test(lower)
    || /\b[a-z0-9-]+\.(com|net|org|io|dev|tv|ca)\/[a-z0-9/_?=&.#-]+/.test(lower)
    || /\b[a-z]{2}\/[a-z0-9/_-]+\/[a-z0-9._-]+/.test(lower);
}

function stripSourceAddressFragments(value: string): string {
  return value
    .replace(/homegraph:\/\/\S+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bsemantic-gap-repair\b/gi, ' ')
    .replace(/\bgenerated-page\b/gi, ' ')
    .replace(/\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)(?:\/\S*)?/gi, ' ')
    .replace(/\b(?:com|net|org|io|dev|tv|ca|co\.uk)\/\S+/gi, ' ');
}

function joinFactPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join('; ')}; and ${phrases[phrases.length - 1]}`;
}
