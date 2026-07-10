/**
 * platform/skills — the single canonical skill service, hoisted into the SDK so
 * every consumer shares one skill model, one progressive-disclosure read path,
 * and one CRUD surface instead of each carrying its own drifting copy.
 *
 * - `model.ts`   — the Markdown + frontmatter skill document, its cheap
 *                  index-line parse and its full-body parse (progressive
 *                  disclosure), and serialization.
 * - `store.ts`   — the injectable storage seam plus a filesystem store
 *                  (directory of `<name>.md` files) and an in-memory store.
 * - `service.ts` — the transport-neutral service that owns validation and
 *                  honest absence; the daemon skills.* gateway verbs adapt over
 *                  it.
 */

export {
  isValidSkillName,
  parseSkill,
  parseSkillIndex,
  serializeSkill,
  toSkillIndexEntry,
  SKILL_NAME_PATTERN,
  type Skill,
  type SkillFrontmatter,
  type SkillFrontmatterValue,
  type SkillIndexEntry,
} from './model.js';
export {
  FileSystemSkillStore,
  InMemorySkillStore,
  type SkillStore,
} from './store.js';
export {
  SkillService,
  SkillServiceError,
  type CreateSkillInput,
  type DeleteSkillResult,
  type SkillErrorCode,
  type UpdateSkillInput,
} from './service.js';
