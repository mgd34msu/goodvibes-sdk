import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// These helpers resolve artifact paths relative to the bundled
// import.meta.url. This works when consumers import from the published npm
// package (artifacts are copied alongside dist/). It breaks when a bundler
// inlines this module without copying the artifact files. We validate the
// resolved path exists and throw a ConfigurationError with actionable guidance.
function resolveArtifactPath(artifactRelativePath: string): string {
  let resolved: string;
  try {
    resolved = fileURLToPath(new URL(artifactRelativePath, import.meta.url));
  } catch (cause) {
    throw new Error(
      `Cannot resolve contract artifact path "${artifactRelativePath}". ` +
      'This usually means the module was bundled without copying the artifacts/ directory. ' +
      'Ensure the @pellux/goodvibes-contracts package is not inlined by your bundler. ' +
      `Caused by: ${String(cause)}`,
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `Contract artifact not found at resolved path: ${resolved}. ` +
      'Ensure the @pellux/goodvibes-contracts package includes the artifacts/ directory ' +
      '(check that your package manager did not strip non-JS files from node_modules).',
    );
  }
  return resolved;
}

export function getOperatorContractPath(): string {
  return resolveArtifactPath('../artifacts/operator-contract.json');
}

export function getPeerContractPath(): string {
  return resolveArtifactPath('../artifacts/peer-contract.json');
}
