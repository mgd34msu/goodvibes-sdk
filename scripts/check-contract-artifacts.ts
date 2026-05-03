// Contract artifacts are generated from package source and committed so release
// packages can expose stable JSON contracts without running generators at
// install time. This script is the CI/local check-mode wrapper for that refresh.
if (!process.argv.includes('--check')) {
  process.argv.push('--check');
}

await import('./refresh-contract-artifacts.ts');
