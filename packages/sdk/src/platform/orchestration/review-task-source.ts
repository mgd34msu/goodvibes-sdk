/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * review-task-source.ts — review findings as a SECOND task source feeding the
 * ONE workstream engine (the 1.4.3 fix-phase rework; never a sibling
 * scheduler).
 *
 * The reviewer's typed record — findings with file citations, the acceptance
 * checklist derived from the ORIGINAL task, and per-constraint satisfaction —
 * parses into typed tasks. A planner pass coalesces them by file-cluster/
 * subsystem and draws the INITIAL dependency graph: shared-file edges
 * (same-file tasks serialize, severity-first) and semantic-prerequisite edges
 * (verification tasks wait for the fixes that touch their files; an
 * injectable judgment hook can add more). The output is a
 * CreateWorkstreamInput for the one engine: worktree isolation, the
 * reviewed-and-merged release policy, and the elastic pool — sequential vs
 * concurrent is emergent from the edges, never a mode.
 */
import type { ReviewerReport } from '../agents/completion-report.js';
import { engineerReviewPhases } from './controller-compat.js';
import type { WrfcCommitScope } from '../agents/wrfc-config.js';
import type { CreateWorkstreamInput } from './engine.js';
import type { WorkItemSpec } from './types.js';

/** Where a parsed task came from in the review record. */
export type ReviewTaskSource = 'finding' | 'checklist' | 'constraint';

/** One typed task parsed from the review. */
export interface ReviewTask {
  readonly id: string;
  readonly title: string;
  /** The full task text a fixer agent receives (original ask + the slice + citations). */
  readonly description: string;
  readonly source: ReviewTaskSource;
  readonly severity: 'critical' | 'major' | 'minor';
  /** File citations from the review record (drive shared-file edges + clusters). */
  readonly files: readonly string[];
}

const SEVERITY_RANK: Record<ReviewTask['severity'], number> = { critical: 0, major: 1, minor: 2 };

/** Parse the reviewer's findings + acceptance checklist + constraint findings into typed tasks. */
export function parseReviewIntoTasks(input: {
  readonly review: ReviewerReport;
  readonly originalTask: string;
}): ReviewTask[] {
  const tasks: ReviewTask[] = [];
  let sequence = 0;
  const nextId = (): string => `rt-${++sequence}`;
  const preamble = `ORIGINAL REQUEST (the contract every fix must serve):\n${input.originalTask}\n\n`;

  for (const issue of input.review.issues ?? []) {
    if (issue.severity === 'suggestion') continue; // advisory, not contract work
    const files = issue.file ? [issue.file] : [];
    tasks.push({
      id: nextId(),
      title: issue.description.length > 90 ? `${issue.description.slice(0, 87)}...` : issue.description,
      description: `${preamble}FIX THIS REVIEW FINDING (${issue.severity}):\n${issue.description}\n`
        + (issue.file ? `Cited file: ${issue.file}${issue.line !== undefined ? `:${issue.line}` : ''}\n` : '')
        + 'Fix exactly this slice; do not take unrelated work.',
      source: 'finding',
      severity: issue.severity,
      files,
    });
  }

  for (const finding of input.review.constraintFindings ?? []) {
    if (finding.satisfied) continue;
    tasks.push({
      id: nextId(),
      title: `Satisfy constraint ${finding.constraintId}`,
      description: `${preamble}SATISFY THIS UNMET CONSTRAINT (${finding.constraintId}):\nEvidence it is unmet: ${finding.evidence}\n`
        + 'Make the deliverable genuinely satisfy the constraint; do not weaken the constraint.',
      source: 'constraint',
      severity: finding.severity ?? 'major',
      files: [],
    });
  }

  for (const item of input.review.acceptanceChecklist ?? []) {
    if (item.verified) continue;
    tasks.push({
      id: nextId(),
      title: `Make verifiable: ${item.item.length > 70 ? `${item.item.slice(0, 67)}...` : item.item}`,
      description: `${preamble}MAKE THIS ACCEPTANCE ITEM PASS (derived from the original task):\n${item.item}\n`
        + `Reviewer evidence it currently fails: ${item.evidence}\n`
        + 'Deliver the behavior the original task asked for, verifiably.',
      source: 'checklist',
      severity: 'major',
      files: [],
    });
  }

  return tasks;
}

/** File-cluster label: the first two path segments (subsystem granularity), or 'general'. */
export function clusterOf(files: readonly string[]): string {
  const first = files[0];
  if (!first) return 'general';
  const segments = first.split('/').filter(Boolean);
  return segments.slice(0, Math.min(2, Math.max(1, segments.length - 1))).join('/') || segments[0] || 'general';
}

/** An optional judgment hook adding semantic-prerequisite edges beyond the heuristics. */
export type SemanticEdgePlanner = (tasks: readonly ReviewTask[]) => ReadonlyArray<{ readonly from: string; readonly to: string }>;

/**
 * The planner pass: coalesce by file-cluster and draw the initial dependency
 * graph. Edges (from DEPENDS ON to):
 * - shared-file: tasks citing the same file serialize, severity-first (a
 *   critical fix lands before a minor one touches the same file);
 * - semantic-prerequisite: file-less verification tasks (checklist/constraint)
 *   wait for every finding fix in the graph — the verification is over the
 *   fixed deliverable, not the broken one; a custom `semanticEdges` hook may
 *   add judgment edges on top.
 */
export function planTaskGraph(
  tasks: readonly ReviewTask[],
  semanticEdges?: SemanticEdgePlanner,
): { specs: WorkItemSpec[]; edgeCount: number } {
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const set = edges.get(from) ?? new Set<string>();
    set.add(to);
    edges.set(from, set);
  };

  // Shared-file serialization, severity-first then parse order.
  const byFile = new Map<string, ReviewTask[]>();
  for (const task of tasks) {
    for (const file of task.files) {
      const list = byFile.get(file) ?? [];
      list.push(task);
      byFile.set(file, list);
    }
  }
  for (const sameFile of byFile.values()) {
    if (sameFile.length < 2) continue;
    const ordered = [...sameFile].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
    for (let i = 1; i < ordered.length; i++) addEdge(ordered[i]!.id, ordered[i - 1]!.id);
  }

  // Semantic prerequisites: verification tasks run over the FIXED deliverable.
  const findingTasks = tasks.filter((task) => task.source === 'finding');
  for (const task of tasks) {
    if (task.source === 'finding') continue;
    for (const finding of findingTasks) addEdge(task.id, finding.id);
  }
  for (const edge of semanticEdges?.(tasks) ?? []) addEdge(edge.from, edge.to);

  const specs: WorkItemSpec[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    task: task.description,
    dependsOn: [...(edges.get(task.id) ?? [])],
    cluster: clusterOf(task.files),
    files: task.files,
  }));
  let edgeCount = 0;
  for (const set of edges.values()) edgeCount += set.size;
  return { specs, edgeCount };
}

/** Per-phase capacity for elastic fix graphs: the fleet ceiling is the real limiter. */
export const ELASTIC_PHASE_CAPACITY = 64;

/** Assemble the full CreateWorkstreamInput for one planned-fix cycle. */
export function planFixWorkstream(input: {
  readonly chainId: string;
  readonly originalTask: string;
  readonly review: ReviewerReport;
  readonly attempt: number;
  readonly commitScope: WrfcCommitScope;
  readonly semanticEdges?: SemanticEdgePlanner | undefined;
}): { workstream: CreateWorkstreamInput; tasks: ReviewTask[] } | null {
  const tasks = parseReviewIntoTasks({ review: input.review, originalTask: input.originalTask });
  if (tasks.length === 0) return null;
  const { specs } = planTaskGraph(tasks, input.semanticEdges);
  return {
    tasks,
    workstream: {
      title: `Planned fix (cycle ${input.attempt}): ${input.originalTask.slice(0, 60)}`,
      phases: engineerReviewPhases(input.commitScope, ELASTIC_PHASE_CAPACITY),
      items: specs,
      isolation: 'worktree',
      releasePolicy: 'reviewed-and-merged',
      provenance: { decomposedBy: 'heuristic', strategy: 'review-findings' },
    },
  };
}
