import { readFileSync } from 'node:fs';

const sbomPath = process.argv[2] ?? 'sbom.cdx.json';
// License policy scope: AGPL, GPL, LGPL, and SSPL are blocked because they impose
// copyleft obligations incompatible with closed-source SDK consumers. CDDL, EPL,
// and MPL-2.0 are accepted: they apply file-level copyleft only and do not affect
// the proprietary SDK wrapper. Extend this list if redistribution model changes.
const blockedLicensePattern = /^(?:AGPL|GPL|LGPL|SSPL)(?:-|$)/i;

type SbomLicenseEntry = {
  readonly license?: {
    readonly id?: unknown;
    readonly name?: unknown;
  };
  readonly expression?: unknown;
};

type SbomComponent = {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly licenses?: readonly SbomLicenseEntry[];
};

const sbom = JSON.parse(readFileSync(sbomPath, 'utf8')) as {
  readonly components?: readonly SbomComponent[];
};

const offenders: string[] = [];
for (const component of sbom.components ?? []) {
  const licenses = (component.licenses ?? []).flatMap((entry) => {
    if (typeof entry.license?.id === 'string') return [entry.license.id];
    if (typeof entry.license?.name === 'string') return [entry.license.name];
    if (typeof entry.expression === 'string') return [entry.expression];
    return [];
  });
  if (licenses.some((license) => blockedLicensePattern.test(license))) {
    offenders.push(`${String(component.name)}@${String(component.version)} (${licenses.join(', ')})`);
  }
}

if (offenders.length > 0) {
  console.error(`Blocked license(s):\n${offenders.join('\n')}`);
  process.exit(1);
}

console.log('License policy OK');
