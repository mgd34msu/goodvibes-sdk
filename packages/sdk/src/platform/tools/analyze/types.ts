/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export interface AnalyzeInput {
  mode:
    | 'impact'
    | 'dependencies'
    | 'dead_code'
    | 'security'
    | 'coverage'
    | 'bundle'
    | 'preview'
    | 'diff'
    | 'surface'
    | 'breaking'
    | 'semantic_diff'
    | 'upgrade'
    | 'permissions'
    | 'env_audit'
    | 'test_find';
  files?: string[] | undefined;
  projectRoot?: string | undefined;
  changes?: string | undefined;
  submode?: 'analyze' | 'circular' | 'upgrade' | undefined;
  securityScope?: 'secrets' | 'permissions' | 'env' | 'all' | undefined;
  before?: string | undefined;
  after?: string | undefined;
  find?: string | undefined;
  replace?: string | undefined;
  include?: string[] | undefined;
  packages?: string[] | undefined;
  output?: {
    format?: 'summary' | 'detailed' | 'json' | undefined;
    max_tokens?: number | undefined;
  };
}

export type ExportedSymbol = { name: string; file: string; line: number; kind?: string };

export type JsonObject = Record<string, unknown>;

export type DiffStatFile = { file: string; insertions: number; deletions: number };

export type SemanticDiffSummary = {
  summary: string;
  impact: string[];
  risk: 'low' | 'medium' | 'high';
};
