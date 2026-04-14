/**
 * Tree-sitter intelligence module.
 *
 * Provides grammar loading, parsing, tree caching, and symbol/outline extraction.
 */
export { TreeSitterService } from './service.js';
export type { SymbolInfo, OutlineEntry } from './queries.js';
export { extractSymbols, extractOutline, findEnclosingScope } from './queries.js';
export { detectLanguage, getGrammarPackage, getSupportedLanguages } from './languages.js';
