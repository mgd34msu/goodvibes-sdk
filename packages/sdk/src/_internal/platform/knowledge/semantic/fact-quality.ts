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
  if (/^\s*\d+\s*(yes|no)\b/.test(lower)
    || /^\s*\d+(hdmi|usb|audio|ports?|features?|smart)\b/.test(lower)
    || /\b\d+\s+features such as\b/.test(lower)) {
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
  if (/\b(magic remote|remote control)\b/.test(lower)
    && /\b(accessor(y|ies)|battery|batteries|button|environment|infrared|mr20ga|point|pointer|remote sensor|sap|sensor|shake|voice recognition)\b/.test(lower)) {
    return true;
  }
  if (/\b(crutchfield|speakercompare|speaker compare|equal[- ]power|equal[- ]volume|speaker shopping|speaker recommendations?)\b/.test(lower)) {
    return true;
  }
  if (/\b(compare sonic characteristics|listening modes?|listening room|auditioning speakers|speakers side-by-side|same amount of power|money-back guarantee|advisors have listened|best choice for your system|speakercompare listening kit|headphones? brand model)\b/.test(lower)) {
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
  if (/\b(usb to serial|rs-?232c|service only|external control setup)\b/.test(lower)) {
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
  if (/\b(game mode in lg nano90|smart tv in lg nano90|specifications and in the end|present for both models|technical parameters are slightly different|pros and cons in this section|overall \d{2}\b)\b/.test(lower)) {
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
  if (/\b(do not place|keep .* away from direct sunlight|high humidity|heat source|ac power source|damage to screen|osd|on screen display|screen should face away|holding the tv|transparent part|speaker grille|avoid touching the screen|failure to do so|connect .* regardless about the order|refer to the manual provided|noise associated with the resolution)\b/.test(lower)) {
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

export function isUsefulHomeGraphSourceBackedNote(text: string): boolean {
  if (isLowValueFeatureOrSpecText(text)) return false;
  const lower = text.toLowerCase();
  if (/\b(magic remote|remote control)\b/.test(lower)) return false;
  const signalCount = [
    /\b(hdmi|usb|ethernet|wi-?fi|bluetooth|airplay|miracast|chromecast)\b/,
    /\b(hdr|hdr10|dolby vision|dolby atmos|filmmaker|game optimizer|freesync|g-sync|allm|vrr)\b/,
    /\b(4k|8k|uhd|resolution|refresh rate|120\s*hz|60\s*hz|nanocell|led|lcd|display|screen)\b/,
    /\b(tuner|atsc|qam|ntsc|codec|mpeg|dolby digital|audio formats?|video formats?)\b/,
    /\b(ports?|speaker system|speaker power|channels?|arc|earc)\b/,
  ].filter((pattern) => pattern.test(lower)).length;
  return signalCount >= 2
    || /\b(supported external devices|supports? .* (hdr|hdmi|usb|wi-?fi|bluetooth|earc|arc|4k|120\s*hz))\b/.test(lower)
    || /\b(dtv audio supported codec|supported codecs?|supported audio formats?|supported video formats?|supported picture formats?)\b/.test(lower);
}

export function isUsefulHomeGraphPageFact(fact: KnowledgeNodeRecord): boolean {
  if (fact.status === 'stale') return false;
  if (fact.metadata.semanticKind !== 'fact') return false;
  const kind = readString(fact.metadata.factKind) ?? 'note';
  if (!USEFUL_PAGE_FACT_KINDS.has(kind)) return false;
  const text = semanticFactText(fact);
  if (isLowValueFeatureOrSpecText(text)) return false;
  if (/\b(magic remote|remote control)\b/.test(text)
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
