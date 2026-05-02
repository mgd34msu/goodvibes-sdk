import type { KnowledgeSourceRecord } from '../types.js';
import { hasConcreteFeatureSignal, isLowValueFeatureOrSpecText } from './fact-quality.js';
import { clampText, normalizeWhitespace, uniqueStrings } from './utils.js';

export interface RepairProfileFact {
  readonly kind: 'feature' | 'capability' | 'specification' | 'compatibility' | 'configuration';
  readonly title: string;
  readonly value?: string;
  readonly summary: string;
  readonly evidence: string;
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
}

interface ProfileRule {
  readonly title: string;
  readonly kind: RepairProfileFact['kind'];
  readonly labels: readonly string[];
  readonly aliases: readonly string[];
  readonly intent: RegExp;
  readonly minimumMatches: number;
  readonly terms: readonly [string, RegExp][];
}

const PROFILE_RULES: readonly ProfileRule[] = [
  {
    title: 'Display and picture specifications',
    kind: 'specification',
    labels: ['display', 'picture'],
    aliases: ['display', 'picture', 'screen'],
    intent: /\b(display|screen|resolution|picture|panel|hdr|refresh|hz|dolby vision|nanocell|lcd|led|oled)\b/,
    minimumMatches: 2,
    terms: [
      ['86-inch class screen', /\b86(?:\.0)?\s*(?:inch|inches|in\.|")\b|\b86nano/i],
      ['4K UHD resolution', /\b4k\b|\buhd\b|\b3840\s*(?:x|×)\s*2160\b/i],
      ['NanoCell display technology', /\bnanocell\b/i],
      ['LCD/LED display', /\blcd\b|\bled\b/i],
      ['100/120 Hz refresh rate', /\b(?:100|120)\s*hz\b|\btrumotion\s*240\b/i],
      ['HDR10', /\bhdr10\b/i],
      ['Dolby Vision', /\bdolby vision\b/i],
      ['HLG', /\bhlg\b/i],
    ],
  },
  {
    title: 'Input and output ports',
    kind: 'specification',
    labels: ['ports', 'connectivity'],
    aliases: ['ports', 'inputs', 'outputs', 'connectivity'],
    intent: /\b(port|ports|input|output|i\/o|hdmi|usb|optical|rf|antenna|ethernet|rs-?232|composite|component|earc|arc)\b/,
    minimumMatches: 2,
    terms: [
      ['HDMI inputs', /\bhdmi\b/i],
      ['HDMI ARC/eARC', /\bearc\b|\barc\b/i],
      ['USB ports', /\busb\b/i],
      ['Ethernet', /\bethernet\b|\brj-?45\b/i],
      ['Optical audio output', /\boptical\b|\btoslink\b/i],
      ['RF antenna input', /\brf\b|\bantenna\b/i],
      ['Composite/component video', /\bcomposite\b|\bcomponent\b/i],
      ['RS-232C/external control', /\brs-?232c?\b|\bexternal control\b/i],
    ],
  },
  {
    title: 'Smart TV platform and integrations',
    kind: 'feature',
    labels: ['smart-tv', 'apps'],
    aliases: ['smart tv', 'apps', 'platform'],
    intent: /\b(smart|webos|apps?|streaming|airplay|homekit|thinq|voice|assistant|alexa|google assistant)\b/,
    minimumMatches: 1,
    terms: [
      ['webOS smart TV platform', /\bwebos\b/i],
      ['LG ThinQ AI', /\bthinq\b/i],
      ['Apple AirPlay 2', /\bairplay\s*2?\b/i],
      ['Apple HomeKit', /\bhomekit\b/i],
      ['voice assistant support', /\bvoice\b|\balexa\b|\bgoogle assistant\b/i],
      ['streaming app support', /\bapps?\b|\bstreaming\b/i],
    ],
  },
  {
    title: 'Network and wireless capabilities',
    kind: 'capability',
    labels: ['network', 'wireless'],
    aliases: ['network', 'wireless', 'bluetooth', 'wi-fi'],
    intent: /\b(wi-?fi|wireless|bluetooth|ethernet|network|lan)\b/,
    minimumMatches: 1,
    terms: [
      ['Wi-Fi/wireless LAN', /\bwi-?fi\b|\bwireless lan\b/i],
      ['Bluetooth', /\bbluetooth\b/i],
      ['Ethernet/LAN', /\bethernet\b|\blan\b/i],
    ],
  },
  {
    title: 'Gaming and HDMI features',
    kind: 'feature',
    labels: ['gaming', 'hdmi'],
    aliases: ['gaming', 'game mode', 'hdmi 2.1'],
    intent: /\b(game|gaming|vrr|allm|freesync|g-?sync|low latency|hdmi\s*2\.1|4k\s*120)\b/,
    minimumMatches: 1,
    terms: [
      ['FreeSync/VRR support', /\bfreesync\b|\bvrr\b/i],
      ['ALLM/low-latency support', /\ballm\b|\blow latency\b/i],
      ['Game Optimizer/game mode', /\bgame optimizer\b|\bgame mode\b|\bgaming\b/i],
      ['HDMI 2.1/high-bandwidth HDMI', /\bhdmi\s*2\.1\b|\b4k\s*(?:at|@)?\s*120\b|\b120\s*hz\b/i],
    ],
  },
  {
    title: 'Audio capabilities',
    kind: 'specification',
    labels: ['audio'],
    aliases: ['audio', 'speakers', 'sound'],
    intent: /\b(audio|speaker|sound|dolby atmos|dolby digital|earc|arc|watts?|channels?)\b/,
    minimumMatches: 1,
    terms: [
      ['speaker/audio output', /\bspeakers?\b|\b(?:10|20|40)\s*w\b|\b2(?:\.0)?\s*ch\b/i],
      ['Dolby audio formats', /\bdolby atmos\b|\bdolby digital\b|\bdolby audio\b/i],
      ['HDMI ARC/eARC audio', /\bearc\b|\barc\b/i],
      ['audio format support', /\bsupported audio formats?\b|\bpcm\b|\btruehd\b/i],
    ],
  },
  {
    title: 'Tuner and broadcast support',
    kind: 'specification',
    labels: ['tuner', 'broadcast'],
    aliases: ['tuner', 'broadcast', 'antenna'],
    intent: /\b(tuner|atsc|ntsc|qam|broadcast|clear qam|antenna)\b/,
    minimumMatches: 1,
    terms: [
      ['ATSC tuner support', /\batsc\b/i],
      ['NTSC analog tuner support', /\bntsc\b/i],
      ['Clear QAM support', /\bqam\b|\bclear qam\b/i],
      ['RF/antenna input', /\brf\b|\bantenna\b/i],
    ],
  },
];

export function deriveRepairProfileFacts(input: {
  readonly query: string;
  readonly source: KnowledgeSourceRecord;
  readonly text: string;
}): readonly RepairProfileFact[] {
  const text = profileEvidenceText([
    input.source.title,
    input.source.summary,
    input.source.description,
    input.text,
  ]);
  if (!hasConcreteFeatureSignal(text)) return [];
  const query = input.query.toLowerCase();
  const broadProfileIntent = /\b(features?|specifications?|profile|capabilities)\b/.test(query);
  return PROFILE_RULES.flatMap((rule) => {
    const values = uniqueStrings(rule.terms
      .filter(([, pattern]) => pattern.test(text))
      .map(([label]) => label));
    const wanted = broadProfileIntent || rule.intent.test(query);
    const minimumMatches = rule.intent.test(query) ? 1 : rule.minimumMatches;
    if (values.length < minimumMatches || !wanted) return [];
    const summary = `${rule.title}: ${joinValues(values)}.`;
    if (isLowValueFeatureOrSpecText(summary)) return [];
    return [{
      kind: rule.kind,
      title: rule.title,
      value: values.join(', '),
      summary,
      evidence: clampText(summary, 360),
      labels: rule.labels,
      aliases: rule.aliases,
    }];
  }).slice(0, 10);
}

function profileEvidenceText(values: readonly (string | undefined)[]): string {
  return normalizeWhitespace(values
    .filter(Boolean)
    .join(' ')
    .replace(/homegraph:\/\/\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[a-z0-9.-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)\/[a-z0-9/_?=&.#-]+/gi, ' ')
    .replace(/\b(?:series_url|current page|loading)\b/gi, ' '));
}

function joinValues(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}
