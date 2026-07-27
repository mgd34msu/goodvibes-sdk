/**
 * public-suffix.ts — the registrable domain (eTLD+1) of a host.
 *
 * ── Why this exists rather than a string comparison ───────────────────────
 *
 * Every naive host check fails to a real attack:
 *
 *   `endsWith('google.com')`      passes `google.com.evil.example`
 *   `includes('google.com')`      passes `google.com.evil.example`
 *   split on the last two labels  gets `co.uk` wrong for `bbc.co.uk`
 *
 * The only correct comparison is on the REGISTRABLE domain — the label
 * immediately below the public suffix — because that is the unit somebody had
 * to buy. `google.com.evil.example` is registrable-domain `evil.example`, and
 * so it fails against `google.com` for the right reason rather than by luck.
 *
 * ── The data, and how it stays current ────────────────────────────────────
 *
 * This is a BUNDLED SNAPSHOT of the ICANN section of Mozilla's Public Suffix
 * List, reduced to the rules that matter for the comparison this module
 * performs: the multi-label suffixes. A single-label suffix (`com`, `dev`,
 * `app`, any new gTLD) needs no rule — the fallback treats one label as the
 * suffix, which is correct for all of them.
 *
 * That fallback is what makes the snapshot safe to be slightly stale: an
 * unknown NEW suffix degrades to the single-label rule. The failure that
 * matters is the opposite direction — a multi-label suffix we do not know
 * about, e.g. a newly delegated `something.xx`, would make two distinct
 * registrants compare equal. So the list must be refreshed, and refreshing it
 * is a data change with no code change:
 *
 *   curl -s https://publicsuffix.org/list/public_suffix_list.dat
 *
 * take the ICANN DOMAINS section, keep the rules containing a dot plus the
 * wildcard and exception rules, and replace the tables below. A test pins the
 * cases that motivated each group, so a bad refresh fails rather than silently
 * widening what compares equal.
 */

/**
 * Multi-label public suffixes. Single-label suffixes are handled by the
 * fallback and are deliberately absent.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz', 'geek.nz', 'kiwi.nz',
  // Japan
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  // India
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'nic.in',
  // South Africa
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za',
  // China / Hong Kong / Taiwan
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
  // Korea
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr',
  // Europe
  'co.at', 'or.at', 'ac.at', 'gv.at',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'com.pt', 'org.pt', 'edu.pt', 'gov.pt',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.gr', 'net.gr', 'org.gr', 'edu.gr', 'gov.gr',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'com.ru', 'net.ru', 'org.ru',
  // Americas
  'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
  'com.ar', 'net.ar', 'org.ar', 'gov.ar', 'edu.ar',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'net.pe', 'org.pe', 'gob.pe', 'edu.pe',
  // Middle East / other
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  // Common hosting suffixes where each label IS a separate registrant.
  // Getting these wrong makes two unrelated sites compare equal, which is the
  // failure direction that matters.
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'web.app', 'firebaseapp.com',
  's3.amazonaws.com', 'blogspot.com', 'wordpress.com', 'sharepoint.com', 'myshopify.com',
]);

/**
 * Suffix rules where EVERY label at that level is a suffix (PSL `*.` rules).
 * `*.compute.amazonaws.com` means `a.compute.amazonaws.com` is a suffix, so
 * two instances under it are different registrants.
 */
const WILDCARD_SUFFIX_PARENTS: readonly string[] = [
  'compute.amazonaws.com',
  'compute-1.amazonaws.com',
  'elb.amazonaws.com',
  'ck.page',
];

/** True when `host` is itself exactly a public suffix (so it has no registrant). */
export function isPublicSuffix(host: string): boolean {
  const labels = host.split('.');
  if (labels.length <= 1) return true;
  if (MULTI_LABEL_SUFFIXES.has(host)) return true;
  return WILDCARD_SUFFIX_PARENTS.some((parent) => {
    const rest = labels.slice(1).join('.');
    return rest === parent;
  });
}

/**
 * The registrable domain of `host` — the label immediately below its public
 * suffix — or `null` when the host has none (it IS a suffix, or is a single
 * label, or is malformed).
 *
 * `null` is a refusal, never a fallback to the whole host: a caller that
 * treated an unparseable host as its own registrable domain would compare
 * equal to itself and let a malformed host through.
 */
export function registrableDomain(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, '');
  if (normalized.length === 0) return null;
  const labels = normalized.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;

  for (const parent of WILDCARD_SUFFIX_PARENTS) {
    const parentLabels = parent.split('.');
    // `*.compute.amazonaws.com`: the suffix is one label plus the parent.
    if (labels.length >= parentLabels.length + 2
      && labels.slice(labels.length - parentLabels.length).join('.') === parent) {
      return labels.slice(labels.length - parentLabels.length - 2).join('.');
    }
  }

  // Longest known multi-label suffix wins, so `co.uk` beats `uk`.
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join('.');
    if (MULTI_LABEL_SUFFIXES.has(candidate)) {
      if (start === 0) return null; // the host IS the suffix
      return labels.slice(start - 1).join('.');
    }
  }

  // Fallback: a single-label suffix. Correct for com, dev, app and every new
  // gTLD, and the reason an out-of-date snapshot degrades safely.
  return labels.slice(-2).join('.');
}

/** True when both hosts sit under the same registrable domain. */
export function sameRegistrableDomain(left: string, right: string): boolean {
  const a = registrableDomain(left);
  const b = registrableDomain(right);
  return a !== null && b !== null && a === b;
}
