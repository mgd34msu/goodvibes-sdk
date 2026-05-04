import type { KnowledgeNodeRecord } from '../types.js';
import { readString } from './utils.js';

const USEFUL_PAGE_FACT_KINDS = new Set([
  'feature',
  'capability',
  'specification',
  'identity',
  'maintenance',
  'compatibility',
  'configuration',
  'troubleshooting',
]);

export interface KnowledgePageFactQualityOptions {
  readonly allowedFactKinds?: ReadonlySet<string> | undefined;
  readonly rejectRemoteAccessoryDetails?: boolean | undefined;
}

export function isSemanticAnswerLinkedObject(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  const semanticKind = readString(node.metadata.semanticKind);
  if (semanticKind) return false;
  return node.kind !== 'fact' && node.kind !== 'wiki_page' && node.kind !== 'knowledge_gap';
}

export function semanticFactText(fact: KnowledgeNodeRecord): string {
  const parts = [
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    readString(fact.metadata.evidence),
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ].filter(Boolean) as string[];
  const uniqueParts: string[] = [];
  for (const part of parts) {
    const normalized = normalizeComparableFactPart(part);
    if (!normalized) continue;
    if (uniqueParts.some((existing) => {
      const existingNormalized = normalizeComparableFactPart(existing);
      return existingNormalized === normalized
        || normalized.startsWith(`${existingNormalized} `)
        || existingNormalized.startsWith(`${normalized} `);
    })) continue;
    uniqueParts.push(part);
  }
  return uniqueParts.join(' ').toLowerCase();
}

function normalizeComparableFactPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|this|these|a|an)\s+/, '');
}

export function isLowValueFeatureOrSpecText(text: string): boolean {
  const lower = text.toLowerCase();
  const remoteAccessoryDetail = /\bremote(?: control)?\b/.test(lower) || /\bbluetooth\b/.test(lower);
  const nonRemoteFeatureSignal = hasNonRemoteFeatureSignal(lower);
  if (/\?\s*$/.test(text.trim())) return true;
  if (/\b(?:semantic-gap-repair|source-backed facts identify|matching sources? (?:exist|identify)|available source-backed details|canonical fact|routing fragments?)\b/.test(lower)) return true;
  if (isUrlOrPathFragment(lower) && !hasConcreteFeatureSignal(lower)) return true;
  if (isUrlOrPathFragment(lower) && /\b(source-backed facts identify|current page|database|manuals? database|loading|semantic-gap-repair)\b/.test(lower)) return true;
  if (isTruncatedManualFragment(lower)) return true;
  if (/\b(items? supplied|supplied items?|included accessories|optional extras?|sold separately|separate purchase|accessories may vary|contents? of (this )?manual|may be changed|may change|subject to change|without prior notice|available menus? and options?|certified cable|unapproved items?)\b/.test(lower)) {
    return true;
  }
  if (/\b(new features? may be added|features? may be added|specifications? may change|product upgrades?|due to product upgrades?)\b/.test(lower)) {
    return true;
  }
  if (/\b(recommended hdmi cable types?|hdmi cable types?|ultra high speed hdmi cables?|usb extension cable|extension cable|physically fit)\b/.test(lower)) {
    return true;
  }
  if (/^\s*\d+\s*(yes|no)\b/.test(lower)
    || /^\s*0?\d+\s*x\s+(?:ethernet|audio|features?|os|webos|ports?)\b/.test(lower)
    || /^\s*\d+\s*m\s*\(/.test(lower)
    || /^\s*\d+(hdmi|usb|audio|ports?|features?|smart)\b/.test(lower)
    || /^\s*0\s+ports\b/.test(lower)
    || /\b\d+\s+features such as\b/.test(lower)
    || /\b(case color|hardware cpu cores|hardware gpu cores)\b/.test(lower)
    || /^\s*\d+\s*kg\d*/.test(lower)) {
    return true;
  }
  if (/\b(series_url|exhibition display|supported audio formats|supported video formats|supported picture formats)\b/.test(lower)) {
    return true;
  }
  if (/\.\.\.|…/.test(text)) {
    return true;
  }
  if (hasRepeatedLeadingPhrase(lower)) {
    return true;
  }
  if (/\b(?:amd\s+freesync|motion interpolation|selected features?|nano cell technology|hdmi quantity|ports quantity)\b[\s\S]{0,220}\b(?:amd\s+freesync|motion interpolation|selected features?|nano cell technology|hdmi quantity|ports quantity)\b/.test(lower)) {
    return true;
  }
  if (/\b(selected features?|ranking system|ranked by|affiliate|associate program|latest price|view latest|buy now|add to cart|marketplace|retailer|store listing|seller listing|sponsored listing)\b/.test(lower)) {
    return true;
  }
  if (/(^|\.)amazon\.[a-z.]+\b|(^|\.)ebay\.[a-z.]+\b|(^|\.)walmart\.[a-z.]+\b|(^|\.)bestbuy\.[a-z.]+\b|(^|\.)target\.[a-z.]+\b/.test(lower)) {
    return true;
  }
  if (/\b(energy monitoring cutoff|quantity table|table fragment|table debris)\b/.test(lower)) {
    return true;
  }
  if (/\bquantity\b/.test(lower) && /\b(table|cutoff|energy monitoring|source list|series_url)\b/.test(lower)) {
    return true;
  }
  if (/\bwf:\s*\d+\s*w\b|\b\d+\s*w\/wf:\s*\d+\s*w\b|\bcompatibility line\b.*\bper channel\b/.test(lower)) {
    return true;
  }
  if (hasConcreteFeatureSignal(lower)
    && /\b(history|historical|introduced|developed by|royalty[- ]free|consumer technology association|generic)\b/.test(lower)) {
    return true;
  }
  if (/\b(button|buttons|remote control)\b/.test(lower) && /[\u25b2\u25bc\u25c4\u25ba]|[▲▼◄►]|\\u25/.test(text)) {
    return true;
  }
  if (!remoteAccessoryDetail && /\b(may vary|depending (upon|on) (the )?model|depending on country|depending on region)\b/.test(lower)) {
    return true;
  }
  if (/\b(fasten|screws?|stand|tip over|overturn|fall over|transporting|move the tv|moving the tv|oils?|lubricants?|cleaning cloth|dry cloth|power cord|electric shock|fire hazard|near water|ventilation|antenna grounding|qualified personnel|qualified service personnel|service personnel|customer service|servicing|repair is required|refer all servicing)\b/.test(lower)) {
    return true;
  }
  if (/\b(platform|cabinet|furniture|supporting furniture|television placement|child safety|proper television placement|wall mount|mounting bracket|stand hole)\b/.test(lower)
    && /\b(support|supports|safe|safely|recommended|install|installation|place|placement|mount|mounting)\b/.test(lower)) {
    return true;
  }
  if (/\b(infrared light|remote control sensor|point (the )?remote|aim (the )?remote)\b/.test(lower)) {
    return true;
  }
  if (/\bremote(?: control)?\b/.test(lower)
    && /\b(accessor(y|ies)|battery|batteries|button|environment|infrared|mr20ga|point|pointer|remote sensor|sap|sensor|shake|voice recognition)\b/.test(lower)
    && !nonRemoteFeatureSignal) {
    return true;
  }
  if (/\b(speaker\s*compare|equal[- ]power|equal[- ]volume|speaker shopping|speaker recommendations?)\b/.test(lower)) {
    return true;
  }
  if (/\b(compare sonic characteristics|listening modes?|listening room|auditioning speakers|speakers side-by-side|same amount of power|money-back guarantee|advisors have listened|best choice for your system|speaker\s*compare listening kit|headphones? brand model)\b/.test(lower)) {
    return true;
  }
  if (/\b(more direct comparison|direct comparison|compare products?|product comparison)\b/.test(lower)) {
    return true;
  }
  if (/\b(prices? & features?|smart tv prices?|latest price|view latest|check .* specifications.*price|current page|loading\.?)\b/.test(lower)) {
    return true;
  }
  if (/^\s*\d{1,2}\s+(inch|inches)\b/.test(lower) || /^\s*00\s+inch\b/.test(lower)) {
    return true;
  }
  if (/\b(connectivity options include multiple hdmi 2|receive and respond to metadata transmitted through hdmi 2)\b/.test(lower)) {
    return true;
  }
  if (/\b(use a certified cable with the hdmi logo|certified hdmi cable|screen may not display|connection error may occur)\b/.test(lower)
    && /\b(hdmi|cable|connection error|screen may not display)\b/.test(lower)) {
    return true;
  }
  if (/\bultra hd broadcast standards?\b/.test(lower) && /\b(not confirmed|may not|vary|depending)\b/.test(lower)) {
    return true;
  }
  if (/\b(usb to serial|service only|external control setup)\b/.test(lower)) {
    return true;
  }
  if (/\brs-?232c\b/.test(lower) && /\b(setup|service only|command|usb to serial)\b/.test(lower)) {
    return true;
  }
  if (/\bexternal devices supported\b/.test(lower)) {
    return true;
  }
  if (/\bsupported codec\b/.test(lower) && /\bexternal devices supported\b/.test(lower)) {
    return true;
  }
  if (/\bhdmi\s+2\.?\s*$/.test(lower) || /\bmultiple hdmi\s+2\.?\s*(ports?)?\s*$/.test(lower)) {
    return true;
  }
  if (/\b(specifications and in the end|present for both models|technical parameters are slightly different|pros and cons in this section|overall \d{2}\b|source list|page title|database entry)\b/.test(lower)) {
    return true;
  }
  if (/\b(more actions?|more remote functions?|remote functions?|remote control buttons?|button map|button functions?)\b/.test(lower)) {
    return true;
  }
  if (/\bremote\b/.test(lower)
    && /\b(shake|pointer|cursor appears|environment|operating environment|voice recognition|recognition performance|point|sensor|press|button|sap|more actions?)\b/.test(lower)
    && !nonRemoteFeatureSignal) {
    return true;
  }
  if (/\b(sap|secondary audio program)\b/.test(lower) && /\b(button|press|enabled|audio)\b/.test(lower)) {
    return true;
  }
  if (/\b(press|pressing|pressed|hold|holding)\b/.test(lower) && /\b(button|remote|key)\b/.test(lower)) {
    return true;
  }
  if (/\bremote\b/.test(lower)
    && /\b(compatib|mr20ga|wireless module|bluetooth|separate purchase|sold separately|accessor(y|ies))\b/.test(lower)
    && !/\b(voice|microphone|cursor|pointer|gesture|motion control|universal control)\b/.test(lower)) {
    return true;
  }
  if (/\bif (the )?device (doesn'?t|does not) support\b/.test(lower) && /\bmay not work properly\b/.test(lower)) {
    return true;
  }
  if (/\bdevice (doesn'?t|does not|may not) support it\b/.test(lower) && /\b(work properly|support it)\b/.test(lower)) {
    return true;
  }
  if (/\bchange\b/.test(lower) && /\bsetting to off\b/.test(lower)) {
    return true;
  }
  if (/\bbatter(y|ies)\b/.test(lower) && /\b(remote|button)\b/.test(lower)) {
    return true;
  }
  if (/\b(bezel|less than \d+(?:\.\d+)?\s*(mm|cm|inches?)|does not fit|will not fit|fit your tv'?s usb port|usb port may not fit|usb flash drive does not fit|usb cable does not fit)\b/.test(lower)) {
    return true;
  }
  if (/\b(warning|caution|risk|hazard|do not|never)\b/.test(lower) && !/\b(feature|supports?|hdmi|usb|hdr|remote|bluetooth)\b/.test(lower)) {
    return true;
  }
  if (/\b(do not place|keep .* away from direct sunlight|high humidity|heat source|ac power source|damage to screen|osd|on screen display|screen should face away|holding the tv|transparent part|speaker grille|avoid touching the screen|failure to do so|connect .* regardless about the order|refer to the manual provided|noise associated with the resolution)\b/.test(lower)) {
    return true;
  }
  return false;
}

function hasNonRemoteFeatureSignal(text: string): boolean {
  return /\b(hdmi|earc|arc|hdr|hdr10|dolby vision|hlg|filmmaker|game optimizer|game mode|gaming|freesync|vrr|allm|4k|uhd|resolution|refresh|webos|airplay|homekit|wi-?fi|ethernet|usb|optical|tuner|atsc|qam|speaker|audio)\b/.test(text);
}

function isUrlOrPathFragment(value: string): boolean {
  return /https?:\/\//.test(value)
    || /\b[a-z0-9-]+\.(com|net|org|io|dev|tv|ca|co\.uk)\/[a-z0-9/_?=&.#-]+/.test(value)
    || /\b[a-z]{2}\/[a-z0-9/_-]+\/[a-z0-9._-]+/.test(value)
    || /\b[a-z0-9._-]+\/(specifications?|manuals?|products?|support|features?)\/[a-z0-9._-]+/.test(value);
}

function isTruncatedManualFragment(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const openParens = trimmed.match(/\(/g)?.length ?? 0;
  const closeParens = trimmed.match(/\)/g)?.length ?? 0;
  if (openParens > closeParens && /[\w\d]$/.test(trimmed)) return true;
  return false;
}

function hasRepeatedLeadingPhrase(value: string): boolean {
  const words = value
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 8) return false;
  for (let size = 2; size <= Math.min(8, Math.floor(words.length / 2)); size++) {
    const phrase = words.slice(0, size).join(' ');
    if (!hasConcreteFeatureSignal(phrase) && size < 3) continue;
    const rest = words.slice(size).join(' ');
    if (rest.includes(phrase) && hasConcreteFeatureSignal(phrase)) return true;
  }
  return false;
}

export function hasConcreteFeatureSignal(text: string): boolean {
  return /\b(hdmi|usb|hdr|hdr10|dolby|vision|earc|arc|bluetooth|wi-?fi|wireless lan|ethernet|voice|remote|game|filmmaker|airplay|chromecast|resolution|4k|8k|refresh|ports?|speakers?|audio|display|screen|apps?|streaming|matter|energy monitoring|scheduling|sensor|battery|z-?wave|zigbee|thread|motion|temperature|humidity|camera|recording|lock|garage|local control|api|automation|atsc|ntsc|qam|tuner|broadcast|rs-?232c|external control)\b/.test(text.toLowerCase());
}

export function isUsefulKnowledgePageFact(
  fact: KnowledgeNodeRecord,
  options: KnowledgePageFactQualityOptions = {},
): boolean {
  if (fact.status === 'stale') return false;
  if (fact.metadata.semanticKind !== 'fact') return false;
  const kind = readString(fact.metadata.factKind) ?? 'note';
  if (!(options.allowedFactKinds ?? USEFUL_PAGE_FACT_KINDS).has(kind)) return false;
  const text = semanticFactText(fact);
  if (isLowValueFeatureOrSpecText(text)) return false;
  if (['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(kind)) {
    if (!readString(fact.metadata.sourceId) && !fact.sourceId) return false;
    if (!hasConcreteFeatureSignal(text)) return false;
  }
  if (options.rejectRemoteAccessoryDetails === true
    && /\bremote(?: control)?\b/.test(text)
    && /\b(accessor(y|ies)|battery|batteries|button|environment|infrared|mr20ga|point|pointer|remote sensor|sap|sensor|shake|voice recognition)\b/.test(text)) {
    return false;
  }
  const extractor = readString(fact.metadata.extractor);
  const confidence = typeof fact.confidence === 'number' ? fact.confidence : 0;
  if (extractor === 'deterministic' && confidence <= 60 && ['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(kind)) {
    return hasConcreteFeatureSignal(text);
  }
  return true;
}
