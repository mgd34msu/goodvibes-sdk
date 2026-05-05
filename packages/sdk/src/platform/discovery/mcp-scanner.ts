/**
 * mcp-scanner.ts
 *
 * MCP server auto-discovery: scans common locations for MCP server definitions
 * that are not already registered in the active config.
 *
 * Scan locations (in order):
 *   1. Project .mcp/ directory — looks for mcp.json or index.js/index.ts scripts
 *   2. ~/.goodvibes/<surface>/mcp/ — user-global MCP server definitions
 *   3. Locally installed npx MCP packages (node_modules/.bin/@modelcontextprotocol/*)
 *
 * Returns suggested McpServerConfig[] for servers not already in the registry.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { McpServerConfig } from '../mcp/config.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { requireSurfaceRoot } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';

export interface McpDiscoveryResult {
  /** Suggested server configs not currently registered */
  suggestions: McpServerConfig[];
  /** Number of locations scanned */
  locationsScanned: number;
}

export type McpDiscoveryRoots = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'> & {
  readonly surfaceRoot: string;
};

/**
 * Well-known npx-installable MCP server package names.
 * These are the official @modelcontextprotocol packages.
 */
const KNOWN_NPX_MCP_PACKAGES = [
  '@modelcontextprotocol/server-filesystem',
  '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-gitlab',
  '@modelcontextprotocol/server-google-drive',
  '@modelcontextprotocol/server-google-maps',
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-puppeteer',
  '@modelcontextprotocol/server-sequential-thinking',
  '@modelcontextprotocol/server-slack',
  '@modelcontextprotocol/server-sqlite',
  '@modelcontextprotocol/server-brave-search',
  '@modelcontextprotocol/server-fetch',
  '@modelcontextprotocol/server-everything',
];

/**
 * Parse a server name from a package name or directory name.
 * e.g. '@modelcontextprotocol/server-filesystem' → 'filesystem'
 *      'my-mcp-server' → 'my-mcp-server'
 */
function deriveServerName(nameOrPath: string): string {
  // Strip scope prefix and 'server-' prefix for known MCP packages
  const stripped = nameOrPath.replace(/^@[^/]+\/server-/, '').replace(/^server-/, '');
  return stripped || nameOrPath;
}

/**
 * Check if a given package is installed locally (in node_modules).
 * Returns the bin path if found, null otherwise.
 */
async function findLocalNpxBin(cwd: string, packageName: string): Promise<string | null> {
  // Check project-local node_modules/.bin
  const binName = packageName.replace(/^@[^/]+\//, '');
  const localBin = join(cwd, 'node_modules', '.bin', binName);
  if (await stat(localBin).then(() => true).catch(() => false)) return localBin;

  // Also check if the package itself exists in node_modules
  const localPkg = join(cwd, 'node_modules', packageName, 'package.json');
  if (await stat(localPkg).then(() => true).catch(() => false)) return packageName;

  return null;
}

/**
 * Scan the project .mcp/ directory for server entry points.
 * Looks for:
 *   - .mcp/mcp.json (already handled by loadMcpConfig, skip)
 *   - .mcp/<name>/index.js or .mcp/<name>/index.ts or .mcp/<name>/server.js
 */
async function scanProjectMcpDir(roots: McpDiscoveryRoots, knownNames: Set<string>): Promise<McpServerConfig[]> {
  const mcpDir = join(roots.workingDirectory, '.mcp');
  if (!await stat(mcpDir).then(() => true).catch(() => false)) return [];

  const suggestions: McpServerConfig[] = [];

  try {
    const entries = await readdir(mcpDir);
    for (const entry of entries) {
      // Skip mcp.json — already read by loadMcpConfig
      if (entry === 'mcp.json') continue;

      const entryPath = join(mcpDir, entry);
      try {
        const entryStat = await stat(entryPath);
        if (!entryStat.isDirectory()) continue;

        // Look for a server entry point inside the subdirectory
        const candidates = ['index.js', 'index.ts', 'server.js', 'server.ts', 'main.js', 'main.ts'];
        for (const candidate of candidates) {
          const candidatePath = join(entryPath, candidate);
          if (await stat(candidatePath).then(() => true).catch(() => false)) {
            if (knownNames.has(entry)) break; // already registered
            const runtime = candidate.endsWith('.ts') ? 'bun' : 'node';
            suggestions.push({
              name: entry,
              command: runtime,
              args: [candidatePath],
            });
            break;
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch (err) {
    logger.warn('[mcp-scanner] Failed to read project .mcp/ directory', { error: summarizeError(err) });
  }

  return suggestions;
}

/**
 * Scan ~/.goodvibes/<surface>/mcp/ for user-global server scripts.
 * Looks for:
 *   - <name>/index.js, <name>/server.js, etc.
 *   - <name>.js, <name>.ts standalone scripts
 */
async function scanGoodvibesMcpDir(roots: McpDiscoveryRoots, knownNames: Set<string>): Promise<McpServerConfig[]> {
  const mcpDir = join(roots.homeDirectory, '.goodvibes', requireSurfaceRoot(roots.surfaceRoot, 'MCP discovery surfaceRoot'), 'mcp');
  if (!await stat(mcpDir).then(() => true).catch(() => false)) return [];

  const suggestions: McpServerConfig[] = [];

  try {
    const entries = await readdir(mcpDir);
    for (const entry of entries) {
      const entryPath = join(mcpDir, entry);
      try {
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          const candidates = ['index.js', 'index.ts', 'server.js', 'server.ts'];
          for (const candidate of candidates) {
            const candidatePath = join(entryPath, candidate);
            if (await stat(candidatePath).then(() => true).catch(() => false)) {
              if (knownNames.has(entry)) break;
              const runtime = candidate.endsWith('.ts') ? 'bun' : 'node';
              suggestions.push({ name: entry, command: runtime, args: [candidatePath] });
              break;
            }
          }
        } else if (entryStat.isFile()) {
          // Standalone script: name.js or name.ts
          if (!entry.endsWith('.js') && !entry.endsWith('.ts')) continue;
          const baseName = entry.replace(/\.(js|ts)$/, '');
          if (knownNames.has(baseName)) continue;
          const runtime = entry.endsWith('.ts') ? 'bun' : 'node';
          suggestions.push({ name: baseName, command: runtime, args: [entryPath] });
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch (err) {
    logger.warn('[mcp-scanner] Failed to read surface MCP directory', { error: summarizeError(err) });
  }

  return suggestions;
}

/**
 * Check for locally-installed npx MCP packages not already registered.
 */
async function scanNpxMcpPackages(roots: McpDiscoveryRoots, knownNames: Set<string>): Promise<McpServerConfig[]> {
  const suggestions: McpServerConfig[] = [];

  for (const pkg of KNOWN_NPX_MCP_PACKAGES) {
    const binPath = await findLocalNpxBin(roots.workingDirectory, pkg);
    if (!binPath) continue;

    const serverName = deriveServerName(pkg);
    if (knownNames.has(serverName)) continue;

    suggestions.push({
      name: serverName,
      command: 'npx',
      args: ['-y', pkg],
    });
  }

  return suggestions;
}

/**
 * Scan all common MCP server locations and return suggestions for
 * servers not already registered in the given set of known server names.
 *
 * @param roots - Explicit working/home roots for project and user MCP discovery
 * @param registeredNames - Set of already-registered server names to skip
 */
export async function scanMcpServers(
  roots: McpDiscoveryRoots,
  registeredNames: Set<string> = new Set(),
): Promise<McpDiscoveryResult> {
  let locationsScanned = 0;
  const suggestions: McpServerConfig[] = [];
  const seen = new Set<string>(registeredNames);

  // Helper to add suggestions without duplicating names
  const addSuggestions = (found: McpServerConfig[]): void => {
    for (const s of found) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        suggestions.push(s);
      }
    }
  };

  // Run all three scanners in parallel — they are independent
  const [projectResults, goodvibesResults, npxResults] = await Promise.all([
    scanProjectMcpDir(roots, registeredNames),
    scanGoodvibesMcpDir(roots, registeredNames),
    scanNpxMcpPackages(roots, registeredNames),
  ]);

  // 1. Project .mcp/ directory
  locationsScanned++;
  addSuggestions(projectResults);

  // 2. ~/.goodvibes/<surface>/mcp/ user-global directory
  locationsScanned++;
  addSuggestions(goodvibesResults);

  // 3. Locally installed npx MCP packages
  locationsScanned++;
  addSuggestions(npxResults);

  logger.debug('[mcp-scanner] Scan complete', {
    locationsScanned,
    suggestions: suggestions.length,
  });

  return { suggestions, locationsScanned };
}
