/**
 * method-catalog-flags.ts
 *
 * The flags.graduation.report descriptor — a read-only view over the feature-
 * flag registry that lists every flag with its graduation state (dark /
 * soaking / graduate-candidate / graduated / blocked) and whatever real
 * validation evidence exists. It is the operator-facing side of the release
 * policy enforced by `bun run flags:graduation`: validated flags flip on or
 * record a dated blocker every release. ws-only invoke verb (no REST binding,
 * so no gateway-rest-routes parity entry). Handlers: routes/flags-graduation.ts.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  FLAGS_GRADUATION_REPORT_INPUT_SCHEMA,
  FLAGS_GRADUATION_REPORT_OUTPUT_SCHEMA,
} from './operator-contract-schemas-flags.js';

export const builtinGatewayFlagsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'flags.graduation.report',
    title: 'Feature Flag Graduation Report',
    description:
      'Return the feature-flag graduation report: every flag with its current default, graduation state (dark = default-off with no evidence, soaking = accumulating evidence, graduate-candidate = judged ready and awaiting a release decision, graduated = default flipped on, blocked = held off with a dated reason), and its validation evidence. Evidence is real-only: a flag with no instrumentation reports "no evidence collected", never a fabricated readiness; the permissions divergence simulation is the one wired instrumentation today. releaseBlockers lists every graduate-candidate flag — the release policy (bun run flags:graduation) fails while that list is non-empty, forcing each ready flag to flip on or record a dated blocker.',
    category: 'flags',
    scopes: ['read:config'],
    transport: ['ws'],
    inputSchema: FLAGS_GRADUATION_REPORT_INPUT_SCHEMA,
    outputSchema: FLAGS_GRADUATION_REPORT_OUTPUT_SCHEMA,
  }),
];
