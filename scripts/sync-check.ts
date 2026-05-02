if (!process.argv.includes('--check')) {
  process.argv.push('--check');
}

await import('./sync-sdk-internals.ts');
