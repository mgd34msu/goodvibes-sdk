/**
 * flags-graduation.ts — the feature-flag graduation release gate.
 *
 * Prints every feature flag with its graduation state and validation evidence,
 * then enforces the release policy: it exits non-zero when any flag sits in
 * `graduate-candidate` (judged ready but neither flipped on nor given a dated
 * blocker). That is the forcing function — every release, a validated flag
 * either flips on or records why it is being held.
 *
 * Run standalone via `bun run flags:graduation`; wired into `release:verify`.
 */
import {
  buildFlagGraduationReport,
  evaluateGraduationReleaseGate,
} from '../packages/sdk/src/platform/runtime/feature-flags/graduation.ts';

function main(): void {
  const report = buildFlagGraduationReport();
  const gate = evaluateGraduationReleaseGate(report);

  const { summary } = report;
  console.log('Feature-flag graduation report');
  console.log(
    `  ${summary.total} flags: ${summary.graduated} graduated, ${summary.dark} dark, ` +
    `${summary.soaking} soaking, ${summary.graduateCandidate} graduate-candidate, ${summary.blocked} blocked`,
  );
  console.log('');

  const width = report.entries.reduce((max, e) => Math.max(max, e.flagId.length), 0);
  for (const entry of report.entries) {
    const blocker = entry.blocker ? `  [blocked ${entry.blocker.date}: ${entry.blocker.reason}]` : '';
    console.log(`  ${entry.flagId.padEnd(width)}  ${entry.state.padEnd(18)}  ${entry.evidence.note}${blocker}`);
  }
  console.log('');

  if (!gate.ok) {
    console.error(`FAIL — ${gate.message}`);
    console.error('Flip each candidate on (set its defaultState) or record a dated blocker annotation.');
    process.exit(1);
  }
  console.log(`OK — ${gate.message}`);
}

main();
