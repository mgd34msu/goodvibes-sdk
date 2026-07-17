"""GENERATED — do not edit. Regenerate with `bun run refresh:contracts`.

Mechanical transport layer for the GoodVibes Home Assistant integration,
emitted from the operator contract by scripts/generate-homeassistant-client.ts.
Covers only the REST subset HA consumes; the webhook, conversation stream,
and surface health probe are not operator methods and stay hand-written.

Contract product version: 1.11.1
Consumed operator methods: 33
"""
from __future__ import annotations

from typing import Any, Literal, Mapping, NamedTuple, NotRequired, TypedDict

#: Daemon contract version these types were generated against (the version pin).
CONTRACT_VERSION: str = "1.11.1"


class OperatorRoute(NamedTuple):
    """An operator method's REST binding: HTTP verb and path template."""

    method: str
    path: str


#: The operator method ids this client depends on (the capability surface).
CONSUMED_METHOD_IDS: frozenset[str] = frozenset({
    "channels.actions.invoke",
    "channels.agent_tools.surface.list",
    "channels.tools.invoke",
    "channels.tools.surface.list",
    "control.status",
    "homeassistant.homeGraph.askHomeGraph",
    "homeassistant.homeGraph.browse",
    "homeassistant.homeGraph.export",
    "homeassistant.homeGraph.generateHomeGraphPacket",
    "homeassistant.homeGraph.generateRoomPage",
    "homeassistant.homeGraph.import",
    "homeassistant.homeGraph.ingestHomeGraphArtifact",
    "homeassistant.homeGraph.ingestHomeGraphNote",
    "homeassistant.homeGraph.ingestHomeGraphUrl",
    "homeassistant.homeGraph.linkHomeGraphKnowledge",
    "homeassistant.homeGraph.listHomeGraphIssues",
    "homeassistant.homeGraph.map",
    "homeassistant.homeGraph.pages.list",
    "homeassistant.homeGraph.refinement.run",
    "homeassistant.homeGraph.refinement.task.cancel",
    "homeassistant.homeGraph.refinement.task.get",
    "homeassistant.homeGraph.refinement.tasks.list",
    "homeassistant.homeGraph.refreshDevicePassport",
    "homeassistant.homeGraph.reindex",
    "homeassistant.homeGraph.reset",
    "homeassistant.homeGraph.reviewHomeGraphFact",
    "homeassistant.homeGraph.sources.list",
    "homeassistant.homeGraph.status",
    "homeassistant.homeGraph.syncHomeGraph",
    "homeassistant.homeGraph.unlinkHomeGraphKnowledge",
    "tasks.cancel",
    "tasks.get",
    "tasks.status",
})

#: methodId -> REST route constants for every consumed method.
OPERATOR_ROUTES: dict[str, OperatorRoute] = {
    "channels.actions.invoke": OperatorRoute("POST", "/api/channels/actions/{surface}/{actionId}"),
    "channels.agent_tools.surface.list": OperatorRoute("GET", "/api/channels/agent-tools/{surface}"),
    "channels.tools.invoke": OperatorRoute("POST", "/api/channels/tools/{surface}/{toolId}"),
    "channels.tools.surface.list": OperatorRoute("GET", "/api/channels/tools/{surface}"),
    "control.status": OperatorRoute("GET", "/status"),
    "homeassistant.homeGraph.askHomeGraph": OperatorRoute("POST", "/api/homeassistant/home-graph/ask"),
    "homeassistant.homeGraph.browse": OperatorRoute("GET", "/api/homeassistant/home-graph/browse"),
    "homeassistant.homeGraph.export": OperatorRoute("POST", "/api/homeassistant/home-graph/export"),
    "homeassistant.homeGraph.generateHomeGraphPacket": OperatorRoute("POST", "/api/homeassistant/home-graph/packet"),
    "homeassistant.homeGraph.generateRoomPage": OperatorRoute("POST", "/api/homeassistant/home-graph/room-page"),
    "homeassistant.homeGraph.import": OperatorRoute("POST", "/api/homeassistant/home-graph/import"),
    "homeassistant.homeGraph.ingestHomeGraphArtifact": OperatorRoute("POST", "/api/homeassistant/home-graph/ingest/artifact"),
    "homeassistant.homeGraph.ingestHomeGraphNote": OperatorRoute("POST", "/api/homeassistant/home-graph/ingest/note"),
    "homeassistant.homeGraph.ingestHomeGraphUrl": OperatorRoute("POST", "/api/homeassistant/home-graph/ingest/url"),
    "homeassistant.homeGraph.linkHomeGraphKnowledge": OperatorRoute("POST", "/api/homeassistant/home-graph/link"),
    "homeassistant.homeGraph.listHomeGraphIssues": OperatorRoute("GET", "/api/homeassistant/home-graph/issues"),
    "homeassistant.homeGraph.map": OperatorRoute("POST", "/api/homeassistant/home-graph/map"),
    "homeassistant.homeGraph.pages.list": OperatorRoute("GET", "/api/homeassistant/home-graph/pages"),
    "homeassistant.homeGraph.refinement.run": OperatorRoute("POST", "/api/homeassistant/home-graph/refinement/run"),
    "homeassistant.homeGraph.refinement.task.cancel": OperatorRoute("POST", "/api/homeassistant/home-graph/refinement/tasks/{id}/cancel"),
    "homeassistant.homeGraph.refinement.task.get": OperatorRoute("GET", "/api/homeassistant/home-graph/refinement/tasks/{id}"),
    "homeassistant.homeGraph.refinement.tasks.list": OperatorRoute("GET", "/api/homeassistant/home-graph/refinement/tasks"),
    "homeassistant.homeGraph.refreshDevicePassport": OperatorRoute("POST", "/api/homeassistant/home-graph/device-passport"),
    "homeassistant.homeGraph.reindex": OperatorRoute("POST", "/api/homeassistant/home-graph/reindex"),
    "homeassistant.homeGraph.reset": OperatorRoute("POST", "/api/homeassistant/home-graph/reset"),
    "homeassistant.homeGraph.reviewHomeGraphFact": OperatorRoute("POST", "/api/homeassistant/home-graph/facts/review"),
    "homeassistant.homeGraph.sources.list": OperatorRoute("GET", "/api/homeassistant/home-graph/sources"),
    "homeassistant.homeGraph.status": OperatorRoute("GET", "/api/homeassistant/home-graph/status"),
    "homeassistant.homeGraph.syncHomeGraph": OperatorRoute("POST", "/api/homeassistant/home-graph/sync"),
    "homeassistant.homeGraph.unlinkHomeGraphKnowledge": OperatorRoute("POST", "/api/homeassistant/home-graph/unlink"),
    "tasks.cancel": OperatorRoute("POST", "/api/tasks/{taskId}/cancel"),
    "tasks.get": OperatorRoute("GET", "/api/tasks/{taskId}"),
    "tasks.status": OperatorRoute("GET", "/task/{agentId}"),
}


# channels.actions.invoke
class ChannelsActionsInvokeInput(TypedDict, total=True):
    accountId: NotRequired[str]
    metadata: NotRequired[Mapping[str, Any]]

class ChannelsActionsInvokeOutput(TypedDict, total=True):
    actionId: str
    surface: str
    result: Mapping[str, Any]

# channels.agent_tools.surface.list
class ChannelsAgentToolsSurfaceListInput(TypedDict, total=True):
    surface: str

class ChannelsAgentToolsSurfaceListOutput(TypedDict, total=True):
    tools: list[Mapping[str, Any]]

# channels.tools.invoke
class ChannelsToolsInvokeInput(TypedDict, total=True):
    accountId: NotRequired[str]
    metadata: NotRequired[Mapping[str, Any]]

class ChannelsToolsInvokeOutput(TypedDict, total=True):
    toolId: str
    surface: str
    result: Mapping[str, Any]

# channels.tools.surface.list
class ChannelsToolsSurfaceListInput(TypedDict, total=True):
    surface: str

class ChannelsToolsSurfaceListOutput(TypedDict, total=True):
    tools: list[Mapping[str, Any]]

# control.status
class ControlStatusInput(TypedDict, total=True):
    receipts: NotRequired[Literal["consume"]]

class ControlStatusOutput(TypedDict, total=True):
    status: str
    version: str
    receipts: NotRequired[list[Mapping[str, Any]]]

# homeassistant.homeGraph.askHomeGraph
class HomeassistantHomeGraphAskHomeGraphInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    query: str
    limit: NotRequired[float]
    mode: NotRequired[str]
    includeSources: NotRequired[bool]
    includeConfidence: NotRequired[bool]
    includeLinkedObjects: NotRequired[bool]
    timeoutMs: NotRequired[float]

class HomeassistantHomeGraphAskHomeGraphOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    query: str
    answer: Mapping[str, Any]
    results: list[Any]

# homeassistant.homeGraph.browse
class HomeassistantHomeGraphBrowseInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]

class HomeassistantHomeGraphBrowseOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    nodes: list[Mapping[str, Any]]
    edges: list[Mapping[str, Any]]
    sources: list[Mapping[str, Any]]
    issues: list[Mapping[str, Any]]

# homeassistant.homeGraph.export
class HomeassistantHomeGraphExportInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]

class HomeassistantHomeGraphExportOutput(TypedDict, total=True):
    version: float
    exportedAt: float
    spaceId: str
    installationId: str
    sources: list[Mapping[str, Any]]
    nodes: list[Mapping[str, Any]]
    edges: list[Mapping[str, Any]]
    issues: list[Mapping[str, Any]]
    extractions: list[Mapping[str, Any]]

# homeassistant.homeGraph.generateHomeGraphPacket
class HomeassistantHomeGraphGenerateHomeGraphPacketInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    packetKind: NotRequired[str]
    title: NotRequired[str]
    sharingProfile: NotRequired[str]
    includeFields: NotRequired[list[str]]
    excludeFields: NotRequired[list[str]]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphGenerateHomeGraphPacketOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    title: str
    markdown: str
    source: NotRequired[Mapping[str, Any]]
    linked: NotRequired[Mapping[str, Any]]
    artifact: Mapping[str, Any]

# homeassistant.homeGraph.generateRoomPage
class HomeassistantHomeGraphGenerateRoomPageInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    areaId: NotRequired[str]
    roomId: NotRequired[str]
    title: NotRequired[str]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphGenerateRoomPageOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    title: str
    markdown: str
    source: NotRequired[Mapping[str, Any]]
    linked: NotRequired[Mapping[str, Any]]
    artifact: Mapping[str, Any]

# homeassistant.homeGraph.import
class HomeassistantHomeGraphImportInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    data: Mapping[str, Any]

class HomeassistantHomeGraphImportOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    imported: Mapping[str, Any]

# homeassistant.homeGraph.ingestHomeGraphArtifact
class HomeassistantHomeGraphIngestHomeGraphArtifactInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    artifactId: NotRequired[str]
    path: NotRequired[str]
    uri: NotRequired[str]
    title: NotRequired[str]
    tags: NotRequired[list[str]]
    target: NotRequired[Mapping[str, Any]]
    allowPrivateHosts: NotRequired[bool]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphIngestHomeGraphArtifactOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    source: Mapping[str, Any]
    artifactId: NotRequired[str]
    extraction: NotRequired[Mapping[str, Any]]
    linked: NotRequired[Mapping[str, Any]]

# homeassistant.homeGraph.ingestHomeGraphNote
class HomeassistantHomeGraphIngestHomeGraphNoteInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    title: NotRequired[str]
    body: str
    category: NotRequired[str]
    tags: NotRequired[list[str]]
    target: NotRequired[Mapping[str, Any]]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphIngestHomeGraphNoteOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    source: Mapping[str, Any]
    artifactId: NotRequired[str]
    extraction: NotRequired[Mapping[str, Any]]
    linked: NotRequired[Mapping[str, Any]]

# homeassistant.homeGraph.ingestHomeGraphUrl
class HomeassistantHomeGraphIngestHomeGraphUrlInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    url: str
    title: NotRequired[str]
    tags: NotRequired[list[str]]
    target: NotRequired[Mapping[str, Any]]
    allowPrivateHosts: NotRequired[bool]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphIngestHomeGraphUrlOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    source: Mapping[str, Any]
    artifactId: NotRequired[str]
    extraction: NotRequired[Mapping[str, Any]]
    linked: NotRequired[Mapping[str, Any]]

# homeassistant.homeGraph.linkHomeGraphKnowledge
class HomeassistantHomeGraphLinkHomeGraphKnowledgeInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    sourceId: NotRequired[str]
    nodeId: NotRequired[str]
    target: Mapping[str, Any]
    relation: NotRequired[str]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphLinkHomeGraphKnowledgeOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    edge: Mapping[str, Any]
    target: NotRequired[Mapping[str, Any]]

# homeassistant.homeGraph.listHomeGraphIssues
class HomeassistantHomeGraphListHomeGraphIssuesInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]
    status: NotRequired[str]
    severity: NotRequired[str]
    code: NotRequired[str]

class HomeassistantHomeGraphListHomeGraphIssuesOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    issues: list[Mapping[str, Any]]

# homeassistant.homeGraph.map
class HomeassistantHomeGraphMapInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]
    includeSources: NotRequired[bool]
    includeIssues: NotRequired[bool]
    includeGenerated: NotRequired[bool]
    query: NotRequired[str]
    recordKinds: NotRequired[list[str]]
    ids: NotRequired[list[str]]
    linkedToIds: NotRequired[list[str]]
    nodeKinds: NotRequired[list[str]]
    sourceTypes: NotRequired[list[str]]
    sourceStatuses: NotRequired[list[str]]
    nodeStatuses: NotRequired[list[str]]
    issueCodes: NotRequired[list[str]]
    issueStatuses: NotRequired[list[str]]
    issueSeverities: NotRequired[list[str]]
    edgeRelations: NotRequired[list[str]]
    tags: NotRequired[list[str]]
    minConfidence: NotRequired[float]
    objectKinds: NotRequired[list[str]]
    entityIds: NotRequired[list[str]]
    deviceIds: NotRequired[list[str]]
    areaIds: NotRequired[list[str]]
    integrationIds: NotRequired[list[str]]
    integrationDomains: NotRequired[list[str]]
    domains: NotRequired[list[str]]
    deviceClasses: NotRequired[list[str]]
    labels: NotRequired[list[str]]
    ha: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphMapOutput(TypedDict, total=True):
    ok: bool
    spaceId: NotRequired[str]
    title: str
    generatedAt: float
    width: float
    height: float
    nodeCount: float
    edgeCount: float
    totalNodeCount: NotRequired[float]
    totalEdgeCount: NotRequired[float]
    facets: NotRequired[Mapping[str, Any]]
    nodes: list[Mapping[str, Any]]
    edges: list[Mapping[str, Any]]
    svg: str

# homeassistant.homeGraph.pages.list
class HomeassistantHomeGraphPagesListInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]
    includeMarkdown: NotRequired[bool]

class HomeassistantHomeGraphPagesListOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    pages: list[Any]

# homeassistant.homeGraph.refinement.run
class HomeassistantHomeGraphRefinementRunInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    gapIds: NotRequired[list[str]]
    sourceIds: NotRequired[list[str]]
    limit: NotRequired[float]
    maxRunMs: NotRequired[float]
    force: NotRequired[bool]

class HomeassistantHomeGraphRefinementRunOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    result: Mapping[str, Any]

# homeassistant.homeGraph.refinement.task.cancel
class HomeassistantHomeGraphRefinementTaskCancelInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    id: str

class HomeassistantHomeGraphRefinementTaskCancelOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    task: Mapping[str, Any] | None

# homeassistant.homeGraph.refinement.task.get
class HomeassistantHomeGraphRefinementTaskGetInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]
    id: str

class HomeassistantHomeGraphRefinementTaskGetOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    task: Mapping[str, Any] | None

# homeassistant.homeGraph.refinement.tasks.list
class HomeassistantHomeGraphRefinementTasksListInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]
    state: NotRequired[str]
    subjectId: NotRequired[str]
    gapId: NotRequired[str]

class HomeassistantHomeGraphRefinementTasksListOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    tasks: list[Mapping[str, Any]]

# homeassistant.homeGraph.refreshDevicePassport
class HomeassistantHomeGraphRefreshDevicePassportInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    deviceId: str
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphRefreshDevicePassportOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    title: str
    markdown: str
    source: NotRequired[Mapping[str, Any]]
    linked: NotRequired[Mapping[str, Any]]
    artifact: Mapping[str, Any]

# homeassistant.homeGraph.reindex
class HomeassistantHomeGraphReindexInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]
    maxRunMs: NotRequired[float]
    semanticLimit: NotRequired[float]
    semanticMaxRunMs: NotRequired[float]
    generatedPageLimit: NotRequired[float]
    force: NotRequired[bool]
    refreshPages: NotRequired[bool]

class HomeassistantHomeGraphReindexOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    scanned: float
    reparsed: float
    skipped: float
    failed: float
    changedSourceCount: NotRequired[float]
    forcedSourceCount: NotRequired[float]
    skippedGeneratedPageArtifactCount: NotRequired[float]
    refreshedGeneratedPageCount: NotRequired[float]
    generatedPagePolicyVersion: NotRequired[str]
    coalesced: NotRequired[bool]
    truncated: NotRequired[bool]
    budgetExhausted: NotRequired[bool]
    sources: list[Mapping[str, Any]]
    failures: list[Any]
    linked: NotRequired[list[Any]]
    semantic: NotRequired[Mapping[str, Any]]
    generated: NotRequired[Mapping[str, Any]]

# homeassistant.homeGraph.reset
class HomeassistantHomeGraphResetInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    dryRun: NotRequired[bool]
    preserveArtifacts: NotRequired[bool]

class HomeassistantHomeGraphResetOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    installationId: str
    dryRun: bool
    deleted: Mapping[str, Any]
    artifactDeleteCandidates: float
    deletedArtifacts: float
    preservedArtifacts: float
    artifactsDeleted: bool

# homeassistant.homeGraph.reviewHomeGraphFact
class HomeassistantHomeGraphReviewHomeGraphFactInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    issueId: NotRequired[str]
    nodeId: NotRequired[str]
    sourceId: NotRequired[str]
    action: str
    value: NotRequired[Mapping[str, Any]]
    reviewer: NotRequired[str]

class HomeassistantHomeGraphReviewHomeGraphFactOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    issue: NotRequired[Mapping[str, Any]]
    node: NotRequired[Mapping[str, Any]]
    source: NotRequired[Mapping[str, Any]]

# homeassistant.homeGraph.sources.list
class HomeassistantHomeGraphSourcesListInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    limit: NotRequired[float]

class HomeassistantHomeGraphSourcesListOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    sources: list[Mapping[str, Any]]

# homeassistant.homeGraph.status
class HomeassistantHomeGraphStatusInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]

class HomeassistantHomeGraphStatusOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    installationId: str
    sourceCount: float
    nodeCount: float
    edgeCount: float
    issueCount: float
    extractionCount: float
    lastSnapshotAt: NotRequired[float]
    readiness: NotRequired[Mapping[str, Any]]
    capabilities: list[str]

# homeassistant.homeGraph.syncHomeGraph
class HomeassistantHomeGraphSyncHomeGraphInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    homeId: NotRequired[str]
    title: NotRequired[str]
    capturedAt: NotRequired[float]
    entities: NotRequired[list[Any]]
    devices: NotRequired[list[Any]]
    areas: NotRequired[list[Any]]
    automations: NotRequired[list[Any]]
    scripts: NotRequired[list[Any]]
    scenes: NotRequired[list[Any]]
    labels: NotRequired[list[Any]]
    integrations: NotRequired[list[Any]]
    helpers: NotRequired[list[Any]]
    pageAutomation: NotRequired[Mapping[str, Any]]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphSyncHomeGraphOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    installationId: str
    source: Mapping[str, Any]
    home: Mapping[str, Any]
    created: Mapping[str, Any]
    generated: Mapping[str, Any]
    counts: Mapping[str, Any]

# homeassistant.homeGraph.unlinkHomeGraphKnowledge
class HomeassistantHomeGraphUnlinkHomeGraphKnowledgeInput(TypedDict, total=True):
    installationId: NotRequired[str]
    knowledgeSpaceId: NotRequired[str]
    sourceId: NotRequired[str]
    nodeId: NotRequired[str]
    target: Mapping[str, Any]
    relation: NotRequired[str]
    metadata: NotRequired[Mapping[str, Any]]

class HomeassistantHomeGraphUnlinkHomeGraphKnowledgeOutput(TypedDict, total=True):
    ok: bool
    spaceId: str
    edge: Mapping[str, Any]
    target: NotRequired[Mapping[str, Any]]

# tasks.cancel
class TasksCancelInput(TypedDict, total=True):
    taskId: str

class TasksCancelOutput(TypedDict, total=True):
    retried: NotRequired[bool]
    task: Mapping[str, Any]
    agentId: NotRequired[str]

# tasks.get
class TasksGetInput(TypedDict, total=True):
    taskId: str

class TasksGetOutput(TypedDict, total=True):
    task: Mapping[str, Any]

# tasks.status
class TasksStatusInput(TypedDict, total=True):
    agentId: str

class TasksStatusOutput(TypedDict, total=True):
    agentId: str
    task: str
    status: str
    model: str | None
    tools: list[str]
    durationMs: float
    toolCallCount: float
    progress: str | None
    error: str | None
