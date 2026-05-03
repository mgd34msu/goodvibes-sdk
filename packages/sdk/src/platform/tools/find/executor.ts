import type { Tool } from '../../types/tools.js';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.js';
import { findSchema } from './schema.js';
import type { FindInput, FindQuery, OutputOptions } from './shared.js';
import { executeFilesQuery } from './files.js';
import { executeContentQuery } from './content.js';
import { executeReferencesQuery } from './references.js';
import { executeStructuralQuery } from './structural.js';
import { executeSymbolsQuery } from './symbols.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { FindRuntimeService } from './shared.js';
import { summarizeError } from '../../utils/error-display.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

const MAX_FIND_QUERIES = 20;
const MAX_PARALLEL_FIND_QUERIES = 5;

export function createFindTool(
  projectRoot: string,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  runtime = new FindRuntimeService(),
): Tool {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('createFindTool requires projectRoot');
  }
  return {
    definition: findSchema,

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        if (!Array.isArray(args.queries) || (args.queries as unknown[]).length === 0) {
          return { success: false, error: 'Missing or empty "queries" array' };
        }
        if ((args.queries as unknown[]).length > MAX_FIND_QUERIES) {
          return { success: false, error: `Too many queries: maximum ${MAX_FIND_QUERIES} per find call` };
        }

        const input = args as unknown as FindInput;
        const output: OutputOptions = input.output ?? {};
        const parallel = input.parallel !== false;

        const runQuery = async (query: FindQuery): Promise<[string, Record<string, unknown>]> => {
          let result: Record<string, unknown>;
          switch (query.mode) {
            case 'files':
              result = await executeFilesQuery(query, output, projectRoot);
              break;
            case 'content':
              result = await executeContentQuery(query, output, runtime, projectRoot);
              break;
            case 'symbols':
              result = await executeSymbolsQuery(query, output, projectRoot);
              break;
            case 'references':
              result = await executeReferencesQuery(query, output, projectRoot);
              break;
            case 'structural':
              result = await executeStructuralQuery(query, output, projectRoot);
              break;
            default: {
              const exhaustive: never = query;
              result = { error: `Unknown mode: ${(exhaustive as FindQuery).mode}` };
            }
          }
          return [query.id, appendSchemaFingerprint(result, 'find', query.mode, { featureFlags })];
        };

        let pairs: Array<[string, Record<string, unknown>]>;
        if (parallel) {
          pairs = await mapWithConcurrency(input.queries, MAX_PARALLEL_FIND_QUERIES, runQuery);
        } else {
          pairs = [];
          for (const query of input.queries) {
            pairs.push(await runQuery(query));
          }
        }

        const results: Record<string, unknown> = {};
        for (const [id, result] of pairs) {
          results[id] = result;
        }

        const finalResults = input.queries.length > 1
          ? appendSchemaFingerprint(results, 'find', 'multi', { featureFlags })
          : results;

        return { success: true, output: JSON.stringify(finalResults) };
      } catch (err) {
        return {
          success: false,
          error: summarizeError(err),
        };
      }
    },
  };
}
