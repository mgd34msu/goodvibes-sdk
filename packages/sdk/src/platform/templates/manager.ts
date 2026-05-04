import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

export interface TemplateEntry {
  name: string;
  path: string;
  preview: string;
  scope: 'project' | 'global';
}

export interface TemplateManagerRoots {
  projectRoot: string;
  homeDirectory: string;
  projectDirectory?: string | undefined;
  globalDirectory?: string | undefined;
}

/**
 * TemplateManager — save, load, list, delete and expand prompt templates.
 *
 * Storage search order:
 * - project templates
 * - global templates
 *
 * Variable syntax:
 * - {{var_name}} named variable
 * - {{1}}, {{2}} positional argument (1-based)
 * - {{template:name}} inline template expansion (max depth 3)
 */
export class TemplateManager {
  private readonly globalDir: string;
  private readonly projectDir: string;

  constructor(roots: TemplateManagerRoots) {
    this.globalDir = roots.globalDirectory ?? join(roots.homeDirectory, '.goodvibes', 'templates');
    this.projectDir = roots.projectDirectory ?? join(roots.projectRoot, '.goodvibes', 'templates');
  }

  save(name: string, content: string): void {
    const safeName = sanitizeName(name);
    mkdirSync(this.projectDir, { recursive: true });
    writeFileSync(join(this.projectDir, `${safeName}.md`), content, 'utf-8');
  }

  load(name: string): string | null {
    const safeName = sanitizeName(name);
    const projectPath = join(this.projectDir, `${safeName}.md`);
    if (existsSync(projectPath)) {
      return readFileSync(projectPath, 'utf-8');
    }
    const globalPath = join(this.globalDir, `${safeName}.md`);
    if (existsSync(globalPath)) {
      return readFileSync(globalPath, 'utf-8');
    }
    return null;
  }

  list(): TemplateEntry[] {
    const seen = new Set<string>();
    const entries: TemplateEntry[] = [];

    for (const [dir, scope] of [[this.projectDir, 'project'], [this.globalDir, 'global']] as const) {
      if (!existsSync(dir)) continue;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const name = basename(file, '.md');
        if (seen.has(name)) continue;
        seen.add(name);
        const filePath = join(dir, file);
        let preview = '';
        try {
          const content = readFileSync(filePath, 'utf-8');
          preview = content.slice(0, 80).replace(/\n/g, ' ').trim();
        } catch {
          preview = '';
        }
        entries.push({ name, path: filePath, preview, scope });
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  delete(name: string): boolean {
    const safeName = sanitizeName(name);
    const projectPath = join(this.projectDir, `${safeName}.md`);
    if (existsSync(projectPath)) {
      rmSync(projectPath);
      return true;
    }
    const globalPath = join(this.globalDir, `${safeName}.md`);
    if (existsSync(globalPath)) {
      rmSync(globalPath);
      return true;
    }
    return false;
  }

  expand(
    template: string,
    args: Record<string, string>,
    depth = 0,
  ): string {
    if (depth >= 3) return template;

    let result = template;
    result = result.replace(/\{\{template:([^}]+)\}\}/g, (_match, refName: string) => {
      const refContent = this.load(refName.trim());
      if (refContent === null) return `{{template:${refName}}}`;
      return this.expand(refContent, args, depth + 1);
    });

    result = result.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      const trimmedKey = key.trim();
      if (trimmedKey in args) {
        return args[trimmedKey]!;
      }
      return `{{${trimmedKey}}}`;
    });

    return result;
  }
}

export function parseTemplateArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let positionalIndex = 1;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      result[key] = value;
    } else {
      result[String(positionalIndex)] = arg;
      positionalIndex += 1;
    }
  }

  return result;
}

function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
    || 'template'
  );
}
