/**
 * optional-dependency-clients-lazy-entry.ts — the fixed shape for the seven
 * client/library packages, compilable.
 *
 * Companion to optional-dependency-lazy-entry.ts, which covers the extraction
 * packages. This one covers the packages that used to be reached by building a
 * client in a constructor, extending an imported base class, running a class
 * static, or re-exporting a value: `openai`, `@anthropic-ai/bedrock-sdk`,
 * `@anthropic-ai/sdk`, `google-auth-library`, `@agentclientprotocol/sdk`,
 * `simple-git` and `graphql`.
 *
 * Built with `bun build --compile` and RUN, because the defect it guards is
 * invisible to a source-level test: under `bun` with a full node_modules tree
 * every one of these resolves, so a static import and a dynamic one look
 * identical. The `--external` flags the test compiles it with leave the seven
 * as runtime specifiers, and running the artifact from a directory where none
 * of them resolve reproduces exactly what an install without optional packages
 * gives an operator — without touching this repository's node_modules.
 *
 * What it must prove, per package: module init survives (a static import never
 * reaches the first line), and the feature that needs the package reports
 * itself unavailable BY NAME rather than failing silently or returning empty.
 */

import { describeOpenAIAvailability } from '../../packages/sdk/src/platform/providers/optional-openai.ts';
import { OpenAIProvider } from '../../packages/sdk/src/platform/providers/openai.ts';
import { describeBedrockAvailability } from '../../packages/sdk/src/platform/providers/optional-bedrock.ts';
import { fetchBedrockModelIds } from '../../packages/sdk/src/platform/providers/amazon-bedrock.ts';
import {
  createAnthropicVertexClient,
  describeAnthropicVertexAvailability,
} from '../../packages/sdk/src/platform/providers/anthropic-vertex.ts';
import { describeAcpAvailability } from '../../packages/sdk/src/platform/acp/optional-sdk.ts';
import { serveAcpAgent } from '../../packages/sdk/src/platform/acp/agent.ts';
import { describeSimpleGitAvailability } from '../../packages/sdk/src/platform/git/optional-simple-git.ts';
import { GitService } from '../../packages/sdk/src/platform/git/service.ts';
import { primeGraphqlModule } from '../../packages/sdk/src/platform/knowledge/graphql-schema.ts';
import {
  KnowledgeGraphqlService,
  inspectKnowledgeGraphqlAccess,
} from '../../packages/sdk/src/platform/knowledge/graphql.ts';

// Printed before anything else: a static import of a missing package never
// reaches this line, which is the whole difference being measured.
process.stdout.write('INIT_SURVIVED\n');

/** Run a call that must fail, and print the message it failed with. */
async function reportThrow(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    process.stdout.write(`${label}_THREW=false\n`);
  } catch (error: unknown) {
    process.stdout.write(`${label}_THREW=${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const openai = await describeOpenAIAvailability();
process.stdout.write(`OPENAI_AVAILABLE=${String(openai.available)}\n`);
process.stdout.write(`OPENAI_REASON=${openai.reason ?? 'none'}\n`);
// The provider itself: constructing it must succeed (the client is built on
// first use), and the first call must fail by name rather than at boot.
const openaiProvider = new OpenAIProvider('test-key');
process.stdout.write(`OPENAI_PROVIDER_CONSTRUCTED=${openaiProvider.name}\n`);
await reportThrow('OPENAI_EMBED', () => openaiProvider.embed({ text: 'hello', dimensions: 384, usage: 'query' }));

const bedrock = await describeBedrockAvailability();
process.stdout.write(`BEDROCK_AVAILABLE=${String(bedrock.available)}\n`);
process.stdout.write(`BEDROCK_REASON=${bedrock.reason ?? 'none'}\n`);
await reportThrow('BEDROCK_MODELS', () => fetchBedrockModelIds());

const vertex = await describeAnthropicVertexAvailability();
process.stdout.write(`VERTEX_AVAILABLE=${String(vertex.available)}\n`);
process.stdout.write(`VERTEX_REASON=${vertex.reason ?? 'none'}\n`);
await reportThrow('VERTEX_CLIENT', () => createAnthropicVertexClient());

const acp = await describeAcpAvailability();
process.stdout.write(`ACP_AVAILABLE=${String(acp.available)}\n`);
process.stdout.write(`ACP_REASON=${acp.reason ?? 'none'}\n`);
await reportThrow('ACP_SERVE', () => serveAcpAgent());

const git = await describeSimpleGitAvailability();
process.stdout.write(`GIT_AVAILABLE=${String(git.available)}\n`);
process.stdout.write(`GIT_REASON=${git.reason ?? 'none'}\n`);
await reportThrow('GIT_STATUS', () => new GitService(process.cwd()).status());

const graphqlPrimed = await primeGraphqlModule();
process.stdout.write(`GRAPHQL_AVAILABLE=${String(graphqlPrimed.available)}\n`);
process.stdout.write(`GRAPHQL_REASON=${graphqlPrimed.reason ?? 'none'}\n`);
// The two paths that used to run at module init: the class-static schema build
// (now a lazy accessor behind `schemaText`) and the synchronous access check.
await reportThrow('GRAPHQL_SCHEMA', async () => KnowledgeGraphqlService.schemaSdl);
await reportThrow('GRAPHQL_INSPECT', async () => inspectKnowledgeGraphqlAccess('query Q { status { ready } }'));

process.stdout.write('DONE\n');
