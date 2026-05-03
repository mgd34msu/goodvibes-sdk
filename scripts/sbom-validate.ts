import { readFileSync } from 'node:fs';

const sbomPath = process.argv[2] ?? 'sbom.cdx.json';
const sbom = JSON.parse(readFileSync(sbomPath, 'utf8')) as {
  readonly bomFormat?: unknown;
  readonly specVersion?: unknown;
  readonly components?: unknown;
};

if (sbom.bomFormat !== 'CycloneDX') {
  console.error('ERROR: bomFormat is not CycloneDX');
  process.exit(1);
}

if (typeof sbom.specVersion !== 'string' || sbom.specVersion.length === 0) {
  console.error('ERROR: specVersion missing');
  process.exit(1);
}

if (!Array.isArray(sbom.components)) {
  console.error('ERROR: components array missing');
  process.exit(1);
}

console.log('SBOM schema OK - specVersion:', sbom.specVersion, 'components:', sbom.components.length);
