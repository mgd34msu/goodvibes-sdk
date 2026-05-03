import { isAbsolute, join, resolve } from 'node:path';

export interface ShellPathService {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly projectGoodVibesRoot: string;
  readonly userGoodVibesRoot: string;
  expandHomePath(path: string): string;
  resolveWorkspacePath(path: string): string;
  resolveProjectPath(...segments: string[]): string;
  resolveUserPath(...segments: string[]): string;
  isWithinWorkingDirectory(path: string): boolean;
}

export interface CreateShellPathServiceOptions {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

function requireAbsoluteOwnedRoot(path: string, name: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`ShellPathService ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`ShellPathService ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

export function createShellPathService(
  options: CreateShellPathServiceOptions,
): ShellPathService {
  const workingDirectory = requireAbsoluteOwnedRoot(options.workingDirectory, 'workingDirectory');
  const homeDirectory = requireAbsoluteOwnedRoot(options.homeDirectory, 'homeDirectory');
  const projectGoodVibesRoot = join(workingDirectory, '.goodvibes');
  const userGoodVibesRoot = join(homeDirectory, '.goodvibes');

  const expandHomePath = (path: string): string => {
    if (path === '~') return homeDirectory;
    if (path.startsWith('~/')) {
      return join(homeDirectory, path.slice(2));
    }
    return path;
  };

  const resolveWorkspacePath = (path: string): string => {
    const normalized = expandHomePath(path);
    return resolve(workingDirectory, normalized);
  };

  const isWithinWorkingDirectory = (path: string): boolean => {
    const resolved = resolveWorkspacePath(path);
    const prefix = workingDirectory.endsWith('/') ? workingDirectory : `${workingDirectory}/`;
    return resolved === workingDirectory || resolved.startsWith(prefix);
  };

  return {
    workingDirectory,
    homeDirectory,
    projectGoodVibesRoot,
    userGoodVibesRoot,
    expandHomePath,
    resolveWorkspacePath,
    resolveProjectPath: (...segments) => join(projectGoodVibesRoot, ...segments),
    resolveUserPath: (...segments) => join(userGoodVibesRoot, ...segments),
    isWithinWorkingDirectory,
  };
}
