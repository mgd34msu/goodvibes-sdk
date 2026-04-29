import type { KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  homeGraphSourceId,
  readRecord,
  uniqueStrings,
} from './helpers.js';
import type { HomeGraphObjectInput } from './types.js';

export async function upsertIntegrationDocumentationCandidates(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  node: KnowledgeNodeRecord,
  object: HomeGraphObjectInput,
): Promise<number> {
  const domain = integrationDomain(node, object);
  if (!domain) return 0;
  let count = 0;
  for (const candidate of documentationCandidates(domain, object)) {
    const source = await store.upsertSource({
      id: homeGraphSourceId(spaceId, 'ha-doc', candidate.url),
      connectorId: HOME_GRAPH_CONNECTOR_ID,
      sourceType: 'url',
      title: candidate.title,
      sourceUri: candidate.url,
      canonicalUri: candidate.url,
      summary: `Suggested documentation source for the ${domain} Home Assistant integration.`,
      tags: uniqueStrings(['homeassistant', 'home-graph', 'documentation', 'suggested-source', domain, candidate.kind]),
      status: 'pending',
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        homeGraphSourceKind: 'documentation-candidate',
        suggested: true,
        documentationKind: candidate.kind,
        integrationDomain: domain,
      }),
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: node.id,
      relation: 'source_for',
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        suggested: true,
        documentationKind: candidate.kind,
      }),
    });
    count += 1;
  }
  return count;
}

function documentationCandidates(
  domain: string,
  object: HomeGraphObjectInput,
): readonly { readonly url: string; readonly title: string; readonly kind: string }[] {
  const metadata = readRecord(object.metadata);
  const urls = [
    {
      url: `https://www.home-assistant.io/integrations/${encodeURIComponent(domain)}/`,
      title: `${domain} Home Assistant documentation`,
      kind: 'home-assistant-docs',
    },
    ...candidateUrl(metadata.documentation, `${domain} integration documentation`, 'manifest-documentation'),
    ...candidateUrl(metadata.documentationUrl, `${domain} integration documentation`, 'manifest-documentation'),
    ...candidateUrl(metadata.documentation_url, `${domain} integration documentation`, 'manifest-documentation'),
    ...candidateUrl(metadata.sourceUrl, `${domain} source repository`, 'source-repository'),
    ...candidateUrl(metadata.source_url, `${domain} source repository`, 'source-repository'),
    ...candidateUrl(metadata.issueTrackerUrl, `${domain} issue tracker`, 'issue-tracker'),
    ...candidateUrl(metadata.issue_tracker_url, `${domain} issue tracker`, 'issue-tracker'),
  ];
  const seen = new Set<string>();
  return urls.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
}

function integrationDomain(node: KnowledgeNodeRecord, object: HomeGraphObjectInput): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  return readString(object.integrationId)
    ?? readString(object.id)
    ?? readString(homeAssistant.integrationId)
    ?? readString(homeAssistant.objectId);
}

function candidateUrl(value: unknown, title: string, kind: string): readonly { readonly url: string; readonly title: string; readonly kind: string }[] {
  const url = readString(value);
  return url && /^https?:\/\//i.test(url) ? [{ url, title, kind }] : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
