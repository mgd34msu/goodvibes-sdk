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
  if (/\b(button|buttons|remote control)\b/.test(lower) && /[\u25b2\u25bc\u25c4\u25ba]|[▲▼◄►]|\\u25/.test(text)) {
    return true;
  }
  if (!magicRemoteDetail && /\b(may vary|depending (upon|on) (the )?model|depending on country|depending on region)\b/.test(lower)) {
    return true;
  }
  if (/\b(fasten|screws?|stand|tip over|overturn|fall over|transporting|move the tv|moving the tv|oils?|lubricants?|cleaning cloth|dry cloth|power cord|electric shock|fire hazard|near water|ventilation|antenna grounding|qualified personnel|qualified service personnel|service personnel|customer service|servicing|repair is required|refer all servicing)\b/.test(lower)) {
    return true;
  }
  if (/\b(platform|cabinet|furniture|supporting furniture|television placement|child safety|proper television placement|wall mount|mounting bracket|stand hole)\b/.test(lower)
    && /\b(support|supports|safe|safely|recommended|install|installation|place|placement|mount|mounting)\b/.test(lower)) {
    return true;
  }
  if (/\b(infrared light|remote control sensor|point (the )?(magic )?remote|aim (the )?(magic )?remote)\b/.test(lower)) {
    return true;
  }
  if (/\b(crutchfield|speakercompare|speaker compare|equal[- ]power|equal[- ]volume|speaker shopping|speaker recommendations?)\b/.test(lower)) {
    return true;
  }
  if (/\b(more actions?|more remote functions?|remote functions?|remote control buttons?|button map|button functions?)\b/.test(lower)) {
    return true;
  }
  if (/\b(magic remote|remote)\b/.test(lower)
    && /\b(shake|pointer|cursor appears|environment|operating environment|voice recognition|recognition performance|point|sensor|press|button|sap|more actions?)\b/.test(lower)) {
    return true;
  }
  if (/\b(sap|secondary audio program)\b/.test(lower) && /\b(button|press|enabled|audio)\b/.test(lower)) {
    return true;
  }
  if (/\b(press|pressing|pressed|hold|holding)\b/.test(lower) && /\b(button|remote|key)\b/.test(lower)) {
    return true;
  }
  if (/\bmagic remote\b/.test(lower)
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
  if (/\bbatter(y|ies)\b/.test(lower) && /\b(remote|magic remote|button)\b/.test(lower)) {
    return true;
  }
  if (/\b(bezel|less than \d+(?:\.\d+)?\s*(mm|cm|inches?)|does not fit|will not fit|fit your tv'?s usb port|usb port may not fit|usb flash drive does not fit|usb cable does not fit)\b/.test(lower)) {
    return true;
  }
  if (/\b(warning|caution|risk|hazard|do not|never)\b/.test(lower) && !/\b(feature|supports?|hdmi|usb|hdr|remote|bluetooth)\b/.test(lower)) {
    return true;
  }
  return false;
}

function isTruncatedManualFragment(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const openParens = trimmed.match(/\(/g)?.length ?? 0;
  const closeParens = trimmed.match(/\)/g)?.length ?? 0;
  if (openParens > closeParens && /[\w\d]$/.test(trimmed)) return true;
  return false;
}

export function hasConcreteFeatureSignal(text: string): boolean {
  return /\b(hdmi|usb|hdr|hdr10|dolby|vision|earc|arc|bluetooth|wi-?fi|wireless lan|ethernet|voice|remote|game|filmmaker|airplay|chromecast|resolution|4k|8k|refresh|ports?|speakers?|audio|display|screen|apps?|streaming|matter|energy monitoring|scheduling|sensor|battery|z-?wave|zigbee|thread|motion|temperature|humidity|camera|recording|lock|garage|local control|api|automation|atsc|ntsc|qam|tuner|broadcast|rs-?232c|external control)\b/.test(text.toLowerCase());
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
