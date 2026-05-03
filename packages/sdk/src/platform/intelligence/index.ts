/**
 * CodeIntelligence public API.
 *
 * Import from here to get the facade, config utilities, and all types.
 */

// Facade
export { CodeIntelligence, pathToUri, uriToPath } from './facade.js';

// Config
export {
  loadLanguageConfigs,
  getLanguageConfig,
  getDefaultConfigs,
} from './config.js';
export type { LanguageConfig } from './config.js';

// Tree-sitter
export { TreeSitterService } from './tree-sitter/service.js';
export type { SymbolInfo, OutlineEntry } from './tree-sitter/queries.js';
export { extractSymbols, extractOutline, findEnclosingScope } from './tree-sitter/queries.js';
export { detectLanguage, getGrammarPackage, getSupportedLanguages } from './tree-sitter/languages.js';

// Import graph
export { ImportGraph } from './import-graph.js';
export type { DependentsMap, ImportsMap } from './import-graph.js';
export {
  extractRelativeSpecifiersForTest,
  resolveSpecifierForTest,
} from './import-graph.js';

// LSP
export { LspService } from './lsp/service.js';
export { LspClient, parseCapabilities, hasCapability } from './lsp/index.js';
export type { LspCapabilities } from './lsp/index.js';
export type { LspServerConfig } from './lsp/service.js';
export type {
  Position,
  Range,
  Location,
  DocumentSymbol,
  Diagnostic,
  Hover,
} from './lsp/protocol.js';
export { SymbolKind } from './lsp/protocol.js';
