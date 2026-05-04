/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export type OccurrenceSpec = 'first' | 'last' | 'all' | number;

export interface EditItem {
  path: string;
  find: string;
  find_base64?: string | undefined;
  replace: string;
  replace_base64?: string | undefined;
  id?: string | undefined;
  occurrence?: OccurrenceSpec | undefined;
  hints?: {
    near_line?: number | undefined;
    in_function?: string | undefined;
    in_class?: string | undefined;
    after?: string | undefined;
    before?: string | undefined;
  };
}

export type ValidatorName = 'typecheck' | 'lint' | 'test' | 'build';

export interface EditInput {
  edits?: EditItem[] | undefined;
  notebook_operations?: NotebookOperationsInput | undefined;
  match?: {
    mode?: 'exact' | 'fuzzy' | 'regex' | 'ast' | 'ast_pattern' | undefined;
    case_sensitive?: boolean | undefined;
    whitespace_sensitive?: boolean | undefined;
    multiline?: boolean | undefined;
  };
  transaction?: {
    mode?: 'atomic' | 'partial' | 'none' | undefined;
  };
  output?: {
    format?: 'count_only' | 'minimal' | 'with_diff' | 'verbose' | undefined;
    diff_context?: number | undefined;
  };
  dry_run?: boolean | undefined;
  validate?: {
    before?: ValidatorName[] | undefined;
    after?: ValidatorName[] | undefined;
  };
}

export type EditResultStatus = 'applied' | 'not_found' | 'ambiguous' | 'conflict' | 'failed';

export interface EditResult {
  id?: string | undefined;
  path: string;
  success: boolean;
  status?: EditResultStatus | undefined;
  occurrencesReplaced?: number | undefined;
  diff?: string | undefined;
  diff_truncated?: boolean | undefined;
  diff_preview?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  warning?: string | undefined;
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown> | undefined;
  execution_count?: number | null | undefined;
  outputs?: unknown[] | undefined;
  id?: string | undefined;
}

export interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  cells: NotebookCell[];
  metadata?: Record<string, unknown> | undefined;
}

export interface NotebookOperation {
  op: 'replace' | 'insert' | 'delete';
  cell?: number | undefined;
  cell_id?: string | undefined;
  after?: number | undefined;
  source?: string | undefined;
  cell_type?: 'code' | 'markdown' | 'raw' | undefined;
  clear_outputs?: boolean | undefined;
}

export interface NotebookOperationsInput {
  path: string;
  operations: NotebookOperation[];
}
