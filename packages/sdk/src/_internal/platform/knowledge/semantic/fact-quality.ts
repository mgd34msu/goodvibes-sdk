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

export function isSemanticAnswerLinkedObject(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  const semanticKind = readString(node.metadata.semanticKind);
  if (semanticKind) return false;
  return node.kind !== 'fact' && node.kind !== 'wiki_page' && node.kind !== 'knowledge_gap';
}

export function semanticFactText(fact: KnowledgeNodeRecord): string {
  return [
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    readString(fact.metadata.evidence),
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

export function isLowValueFeatureOrSpecText(text: string): boolean {
  const lower = text.toLowerCase();
  const magicRemoteDetail = /\bmagic remote\b/.test(lower) || /\bbluetooth\b/.test(lower);
  if (/\b(items? supplied|supplied items?|included accessories|optional extras?|sold separately|separate purchase|accessories may vary|contents? of (this )?manual|may be changed|without prior notice|available menus? and options?|certified cable|unapproved items?)\b/.test(lower)) {
    return true;
  }
  if (!magicRemoteDetail && /\b(may vary|depending (upon|on) (the )?model|depending on country|depending on region)\b/.test(lower)) {
    return true;
  }
  if (/\b(fasten|screws?|stand|tip over|overturn|fall over|transporting|move the tv|moving the tv|oils?|lubricants?|cleaning cloth|power cord|electric shock|fire hazard|near water|ventilation|antenna grounding)\b/.test(lower)) {
    return true;
  }
  if (/\b(bezel|less than \d+(?:\.\d+)?\s*(mm|cm|inches?)|does not fit|will not fit|fit your tv'?s usb port|usb port may not fit)\b/.test(lower)) {
    return true;
  }
  if (/\b(warning|caution|risk|hazard|do not|never)\b/.test(lower) && !/\b(feature|supports?|hdmi|usb|hdr|remote|bluetooth)\b/.test(lower)) {
    return true;
  }
  return false;
}

export function hasConcreteFeatureSignal(text: string): boolean {
  return /\b(hdmi|usb|hdr|hdr10|dolby|vision|earc|arc|bluetooth|wi-?fi|ethernet|voice|remote|game|filmmaker|airplay|chromecast|resolution|4k|8k|refresh|ports?|speakers?|audio|display|screen|apps?|streaming|matter|energy monitoring|scheduling|sensor|battery|z-?wave|zigbee|thread|motion|temperature|humidity|camera|recording|lock|garage|local control|api|automation)\b/.test(text.toLowerCase());
}

export function isUsefulHomeGraphPageFact(fact: KnowledgeNodeRecord): boolean {
  if (fact.status === 'stale') return false;
  if (fact.metadata.semanticKind !== 'fact') return false;
  const kind = readString(fact.metadata.factKind) ?? 'note';
  if (!USEFUL_PAGE_FACT_KINDS.has(kind)) return false;
  const text = semanticFactText(fact);
  if (isLowValueFeatureOrSpecText(text)) return false;
  const extractor = readString(fact.metadata.extractor);
  const confidence = typeof fact.confidence === 'number' ? fact.confidence : 0;
  if (extractor === 'deterministic' && confidence <= 60 && ['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(kind)) {
    return hasConcreteFeatureSignal(text);
  }
  return true;
}
