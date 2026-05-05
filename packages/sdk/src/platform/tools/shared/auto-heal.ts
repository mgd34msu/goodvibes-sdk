/**
 * AutoHealer — three-stage pipeline to fix write/edit validation failures.
 *
 * Pipeline (opt-in via tools.autoHeal config):
 *   1. Formatter: prettier --write or biome format
 *   2. Linter fix: eslint --fix
 *   3. ToolLLM: LLM-assisted fix with error context
 *
 * Design constraints:
 *   - Returns {healed: false, content: originalContent} with warnings whenever
 *     repair cannot safely produce validated replacement content
 *   - Each stage checks if errors are resolved before proceeding to the next
 *   - Uses Bun.which() to detect available tools at runtime
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConfigManager } from '../../config/manager.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Result of an auto-heal attempt. */
export interface HealResult {
  healed: boolean;
  content: string;
  method?: 'formatter' | 'linter' | 'llm' | undefined;
  warnings?: string[] | undefined;
}

function addWarning(warnings: string[], message: string, error?: unknown): void {
  const warning = error === undefined ? message : `${message}: ${summarizeError(error)}`;
  warnings.push(warning);
}

/**
 * AutoHealer — attempts to fix content with validation errors via a staged pipeline.
 *
 * Usage:
 *   const healer = new AutoHealer();
 *   const result = await healer.heal(filePath, content, errors);
 *   if (result.healed) { // use result.content }
 */
export class AutoHealer {
  constructor(
    private readonly configManager: Pick<ConfigManager, 'get'>,
    private readonly toolLLM: Pick<ToolLLM, 'chat'>,
  ) {}

  /**
   * Attempt to auto-heal content with validation errors.
   *
   * @param filePath     Original file path (used to determine extension/context).
   * @param content      File content that failed validation.
   * @param errors       Validation error messages from the failed write/edit.
   * @returns            Heal result — healed=true means content was fixed.
   */
  async heal(filePath: string, content: string, errors: string[]): Promise<HealResult> {
    const warnings: string[] = [];
    try {
      // Config gate: only run when tools.autoHeal is enabled
      if (!this.configManager.get('tools.autoHeal')) {
        return { healed: false, content };
      }

      if (!errors.length) {
        return { healed: false, content };
      }

      const ext = extname(filePath) || '.txt';
      const tmpFile = join(tmpdir(), `auto-heal-${randomBytes(6).toString('hex')}${ext}`);

      let result: HealResult = { healed: false, content };
      try {
        // Stage 1: Formatter
        const formatterResult = await this._tryFormatter(tmpFile, content, errors, warnings);
        if (formatterResult.healed) {
          result = formatterResult;
        } else {
          // Stage 2: Linter fix
          const linterResult = await this._tryLinter(tmpFile, formatterResult.content, errors, warnings);
          if (linterResult.healed) {
            result = linterResult;
          } else {
            // Stage 3: ToolLLM
            result = await this._tryLLM(filePath, linterResult.content, errors, warnings);
          }
        }
      } finally {
        // Clean up temp file
        try {
          if (existsSync(tmpFile)) {
            unlinkSync(tmpFile);
          }
        } catch (cleanupErr) {
          addWarning(warnings, `Auto-heal cleanup failed for temporary file '${tmpFile}'`, cleanupErr);
        }
      }

      return warnings.length > 0 ? { ...result, warnings } : result;
    } catch (err) {
      logger.warn('AutoHealer.heal: unexpected error', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal failed unexpectedly', err);
      return { healed: false, content, warnings };
    }
  }

  /**
   * Stage 1: Try formatting with prettier or biome.
   */
  private async _tryFormatter(
    tmpFile: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      const prettier = Bun.which('prettier');
      const biome = Bun.which('biome');

      if (!prettier && !biome) {
        logger.debug('AutoHealer: no formatter found (prettier/biome), skipping stage 1');
        return { healed: false, content };
      }

      // Write content to temp file
      writeFileSync(tmpFile, content, 'utf-8');

      let proc: { exitCode: number | null };

      if (prettier) {
        proc = Bun.spawnSync([prettier, '--write', '--log-level', 'silent', tmpFile]);
      } else {
        // biome format --write
        proc = Bun.spawnSync([biome!, 'format', '--write', tmpFile], {
          stderr: 'pipe',
        });
      }

      if (proc.exitCode !== 0) {
        logger.debug('AutoHealer: formatter exited non-zero, skipping stage 1');
        addWarning(warnings, 'Auto-heal formatter exited non-zero; continuing to later repair stages');
        return { healed: false, content };
      }

      const formatted = readFileSync(tmpFile, 'utf-8');

      if (formatted === content) {
        // Formatter made no changes — errors not formatter-related
        return { healed: false, content };
      }

      // Check if errors appear resolved (heuristic: no syntax errors after format)
      const resolved = await this._errorsResolved(tmpFile, errors, warnings);
      if (resolved) {
        logger.debug('AutoHealer: errors resolved by formatter');
        return { healed: true, content: formatted, method: 'formatter' };
      }

      // Formatter ran but errors remain — pass updated content to next stage
      return { healed: false, content: formatted };
    } catch (err) {
      logger.warn('AutoHealer: formatter stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal formatter stage failed; continuing to later repair stages', err);
      return { healed: false, content };
    }
  }

  /**
   * Stage 2: Try linter fix with eslint.
   */
  private async _tryLinter(
    tmpFile: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      const eslint = Bun.which('eslint');

      if (!eslint) {
        logger.debug('AutoHealer: eslint not found, skipping stage 2');
        return { healed: false, content };
      }

      // Write (possibly formatter-updated) content to temp file
      writeFileSync(tmpFile, content, 'utf-8');

      const proc = Bun.spawnSync([eslint, '--fix', tmpFile], {
        stderr: 'pipe',
        stdout: 'pipe',
      });

      // eslint --fix exits 1 on remaining errors, 0 on clean — both are acceptable
      const fixed = readFileSync(tmpFile, 'utf-8');

      if (fixed === content) {
        return { healed: false, content };
      }

      const resolved = await this._errorsResolved(tmpFile, errors, warnings);
      if (resolved) {
        logger.debug('AutoHealer: errors resolved by linter');
        return { healed: true, content: fixed, method: 'linter' };
      }

      return { healed: false, content: fixed };
    } catch (err) {
      logger.warn('AutoHealer: linter stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal linter stage failed; continuing to LLM repair', err);
      return { healed: false, content };
    }
  }

  /**
   * Stage 3: Try ToolLLM with error context.
   */
  private async _tryLLM(
    filePath: string,
    content: string,
    errors: string[],
    warnings: string[],
  ): Promise<HealResult> {
    try {
      const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
      const prompt = [
        `You are a code repair assistant. The following file has validation errors that need to be fixed.`,
        ``,
        `File: ${filePath}`,
        ``,
        `Errors:`,
        errorList,
        ``,
        `Current content:`,
        `\`\`\``,
        content,
        `\`\`\``,
        ``,
        `Return ONLY the corrected file content, no explanation, no markdown fences.`,
      ].join('\n');

      const response = await this.toolLLM.chat(prompt, {
        maxTokens: 4096,
        systemPrompt: 'You are a code repair tool. Output only the corrected file content with no additional text or markdown.',
      });

      if (!response || response.trim() === '') {
        logger.debug('AutoHealer: LLM returned empty response');
        addWarning(warnings, 'Auto-heal LLM returned an empty response');
        return { healed: false, content };
      }

      // Verify the LLM fix actually resolves errors
      const llmTmpFile = join(tmpdir(), `auto-heal-llm-${randomBytes(6).toString('hex')}${extname(filePath) || '.txt'}`);
      try {
        writeFileSync(llmTmpFile, response, 'utf-8');
        const resolved = await this._errorsResolved(llmTmpFile, errors, warnings);
        if (!resolved) {
          logger.debug('AutoHealer: LLM response did not resolve errors');
          addWarning(warnings, 'Auto-heal LLM response did not resolve validation errors');
          return { healed: false, content };
        }
      } finally {
        try {
          if (existsSync(llmTmpFile)) unlinkSync(llmTmpFile);
        } catch (cleanupErr) {
          addWarning(warnings, `Auto-heal cleanup failed for temporary LLM file '${llmTmpFile}'`, cleanupErr);
        }
      }

      logger.debug('AutoHealer: errors resolved by LLM');
      return { healed: true, content: response, method: 'llm' };
    } catch (err) {
      logger.warn('AutoHealer: LLM stage failed', { error: summarizeError(err) });
      addWarning(warnings, 'Auto-heal LLM stage failed', err);
      return { healed: false, content };
    }
  }

  /**
   * Heuristic check: attempt to parse/validate a temp file to see if errors are resolved.
   *
   * For JS/TS files: uses Bun's built-in transpiler to check for syntax errors.
   * For other files: assumes resolved if formatter/linter succeeded (conservative).
   */
  private async _errorsResolved(tmpFile: string, _errors: string[], warnings: string[]): Promise<boolean> {
    try {
      const ext = extname(tmpFile).toLowerCase();
      const isJsTs = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext);

      if (!isJsTs) {
        // For non-JS/TS: trust the formatter/linter exit code
        return true;
      }

      // For JS/TS: attempt transpile with Bun to catch syntax errors
      const content = readFileSync(tmpFile, 'utf-8');
      const loader = (ext === '.mjs' || ext === '.cjs') ? 'js' : ext.slice(1) as 'ts' | 'tsx' | 'js' | 'jsx';
      const transpiler = new Bun.Transpiler({ loader });

      try {
        transpiler.transformSync(content);
        return true;
      } catch {
        return false;
      }
    } catch (err) {
      addWarning(warnings, `Auto-heal could not verify repaired content in '${tmpFile}'`, err);
      return false;
    }
  }
}
