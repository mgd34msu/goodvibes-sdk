import type { ProviderMessage, ContentPart } from '../providers/interface.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CompactionContext } from './context-compaction.js';
import type { CompactionReceipt } from './compaction-types.js';
import type { SessionMemoryStore } from './session-memory.js';
import type { SessionLineageTracker } from './session-lineage.js';
import { buildTranscriptEventIndex } from './transcript-events/index.js';
import { compactConversation } from './conversation-compaction.js';
import {
  cloneBranchMap,
  cloneMessages,
  deriveConversationTitle,
  messagesToInternal,
  restoreBranchMap,
} from './conversation-utils.js';
import { applyDiffContent, parseDiffForApply } from './conversation-diff.js';
import { logger } from '../utils/logger.js';

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
};

type AssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[] | undefined;
  reasoningContent?: string | undefined;
  reasoningSummary?: string | undefined;
  usage?: TokenUsage | undefined;
  model?: string | undefined;
  provider?: string | undefined;
};

export type ConversationMessageSnapshot =
  | { role: 'user'; content: string | ContentPart[]; cancelled?: boolean }
  | AssistantMessage
  | { role: 'system'; content: string }
  | { role: 'tool'; callId: string; content: string; toolName?: string };

type Message = ConversationMessageSnapshot;
export type ConversationTitleSource = 'system' | 'user';

export interface BlockMeta {
  type: 'tool' | 'code' | 'diff' | 'thinking';
  rawContent: string;
  filePath?: string | undefined;
  diffOriginal?: string | undefined;
  diffUpdated?: string | undefined;
}

function sameTokenUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  );
}

function sameToolCalls(a: ToolCall[] | undefined, b: ToolCall[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((call, index) => {
    const other = b[index];
    return other !== undefined && call.id === other.id && call.name === other.name
      && JSON.stringify(call.arguments) === JSON.stringify(other.arguments);
  });
}

/**
 * True when `candidate` is the SAME assistant message the store already holds
 * at its tail — a re-delivery, not a new turn.
 *
 * The defect this closes: a hosted conversation opens a fresh event stream per
 * turn and never sends `Last-Event-ID`, so the gateway's catch-up replay
 * re-sends the tail of the previous turn's events — including its
 * `TURN_COMPLETED` — into the next turn's renderer. That renderer has never
 * seen the event, so it appends the previous turn's final assistant message a
 * second time, byte-identical and carrying the identical usage numbers. The
 * observed recovery journal held exactly that: one turn's final message twice,
 * same content, same usage.
 *
 * Why matching on content is safe here rather than merely plausible: this only
 * compares against the IMMEDIATELY PRECEDING message. Two identical assistant
 * messages with nothing between them do not occur in an honest turn — a real
 * repeat is separated by the user message that prompted it, or by the tool
 * messages that answer the tool calls, and either one moves the tail. Requiring
 * the usage counters to match as well means a genuine second call (which bills
 * its own tokens) is not mistaken for a replay.
 *
 * This is the store boundary on purpose. Every durable writer — the recovery
 * snapshot, the session store, the transcript journal — serializes this
 * message array, so one guard here covers all of them, and none of them needs
 * its own idea of what a duplicate is.
 *
 * Note this suppresses the SYMPTOM at the boundary where correctness is
 * cheapest to guarantee. The upstream cause (the client not resuming its stream
 * position) is worth fixing on its own, because the same replayed frame also
 * marks the new turn's renderer finished.
 */
function isRedeliveredAssistantMessage(
  previous: Message | undefined,
  candidate: AssistantMessage,
): boolean {
  if (previous === undefined || previous.role !== 'assistant') return false;
  return (
    previous.content === candidate.content &&
    previous.model === candidate.model &&
    previous.provider === candidate.provider &&
    previous.reasoningContent === candidate.reasoningContent &&
    previous.reasoningSummary === candidate.reasoningSummary &&
    sameTokenUsage(previous.usage, candidate.usage) &&
    sameToolCalls(previous.toolCalls, candidate.toolCalls)
  );
}

export class ConversationManager {
  private messages: Message[] = [];
  private _title = '';
  private _titleSource: ConversationTitleSource = 'system';
  private sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null = null;
  private sessionLineageTracker: Pick<SessionLineageTracker, 'addCompactionEntry'> = {
    addCompactionEntry: () => {},
  };
  private branches = new Map<string, Message[]>();
  private currentBranch = 'main';
  private streamingMessageIndex = -1;
  private undoStack: Message[][] = [];
  private _messagesRevision = 0;
  private _cachedLLMMessages: ProviderMessage[] | null = null;
  private _cachedLLMRevision = -1;

  constructor() {}

  private findToolName(callId: string): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
      const match = message.toolCalls.find((call) => call.id === callId);
      if (match?.name) return match.name;
    }
    return undefined;
  }

  public setSessionMemoryStore(store: Pick<SessionMemoryStore, 'list'>): void {
    this.sessionMemoryStore = store;
  }

  public getSessionMemoryStore(): Pick<SessionMemoryStore, 'list'> | null {
    return this.sessionMemoryStore;
  }

  public setSessionLineageTracker(tracker: Pick<SessionLineageTracker, 'addCompactionEntry'>): void {
    this.sessionLineageTracker = tracker;
  }

  public getSessionLineageTracker(): Pick<SessionLineageTracker, 'addCompactionEntry'> {
    return this.sessionLineageTracker;
  }

  /**
   * Returns the conversation messages formatted for the LLM provider.
   *
   * @returns readonly reference — do not mutate; the array is shared across
   *   cache-hit callers until the next conversation mutation.
   */
  public getMessagesForLLM(): ProviderMessage[] {
    if (this._cachedLLMMessages !== null && this._cachedLLMRevision === this._messagesRevision) {
      return this._cachedLLMMessages;
    }
    const result: ProviderMessage[] = [];
    for (const message of this.messages) {
      if (message.role === 'system') continue;
      if (message.role === 'user') {
        result.push({ role: 'user', content: message.content });
        continue;
      }
      if (message.role === 'assistant') {
        result.push({
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        });
        continue;
      }
      result.push({
        role: 'tool',
        callId: message.callId,
        content: message.content,
        ...(message.toolName ? { name: message.toolName } : {}),
      });
    }
    this._cachedLLMMessages = result;
    this._cachedLLMRevision = this._messagesRevision;
    return result;
  }

  public addUserMessage(content: string | ContentPart[]): void {
    if (this._title === '' && typeof content === 'string' && content.trim().length > 0) {
      this.setSystemTitle(deriveConversationTitle(content));
    }
    this.messages.push({ role: 'user', content });
    // Clear undo stack when new user input is added (can't redo past new input)
    this.undoStack = [];
    this._messagesRevision++;
  }

  public addAssistantMessage(
    content: string,
    opts?: {
      toolCalls?: ToolCall[] | undefined;
      reasoningContent?: string | undefined;
      reasoningSummary?: string | undefined;
      usage?: TokenUsage | undefined;
      model?: string | undefined;
      provider?: string | undefined;
    },
  ): void {
    const candidate: AssistantMessage = {
      role: 'assistant',
      content,
      toolCalls: opts?.toolCalls,
      reasoningContent: opts?.reasoningContent,
      reasoningSummary: opts?.reasoningSummary,
      usage: opts?.usage,
      model: opts?.model,
      provider: opts?.provider,
    };
    if (isRedeliveredAssistantMessage(this.messages[this.messages.length - 1], candidate)) {
      // Dropped on purpose — see isRedeliveredAssistantMessage. Recorded rather
      // than swallowed: a message that does not land must be explainable later.
      logger.debug('[conversation] dropped a re-delivered assistant message', {
        contentLength: content.length,
        ...(opts?.usage ? { outputTokens: opts.usage.outputTokens } : {}),
      });
      return;
    }
    this.messages.push(candidate);
    this._messagesRevision++;
  }

  /**
   * undo - Remove the last complete turn (the last user message and all subsequent
   * non-user messages). Pushes the removed messages onto the undo stack.
   * Returns true if a turn was removed, false if there was nothing to undo.
   */
  public undo(): boolean {
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg?.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return false;
    const turn = this.messages.splice(lastUserIdx);
    this.undoStack.push(turn);
    this._messagesRevision++;
    return true;
  }

  /**
   * redo - Restore the most recently undone turn.
   * Returns true if a turn was restored, false if the undo stack is empty.
   */
  public redo(): boolean {
    if (this.undoStack.length === 0) return false;
    const turn = this.undoStack.pop()!;
    this.messages.push(...turn);
    this._messagesRevision++;
    return true;
  }

  public addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      // `output` must never be silently dropped on failure — many tools (e.g. exec)
      // put the full diagnostic payload (exit code, stdout, stderr) in `output` even
      // when `success` is false, and leave `error` unset for that failure shape.
      const content = result.output !== undefined
        ? (result.success ? result.output : `Error: ${result.error ? result.error + '\n' : ''}${result.output}`)
        : result.success
          ? 'Tool completed successfully.'
          : `Error: ${result.error ?? 'Unknown error'}`;
      const toolName = this.findToolName(result.callId);
      this.messages.push({
        role: 'tool',
        callId: result.callId,
        content,
        ...(toolName ? { toolName } : {}),
      });
    }
    this._messagesRevision++;
  }

  public addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
    this._messagesRevision++;
  }

  public getLastUserMessage(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg?.role === 'user') {
        return typeof msg.content === 'string' ? msg.content : null;
      }
    }
    return null;
  }

  public getMessageCount(): number {
    return this.messages.length;
  }

  public removeMessagesAfter(count: number): void {
    if (count < this.messages.length) {
      this.messages.length = count;
      this._messagesRevision++;
    }
  }

  public markLastUserMessageCancelled(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg?.role === 'user') {
        (msg as { cancelled?: boolean }).cancelled = true;
        this._messagesRevision++;
        return;
      }
    }
  }

  public startStreamingBlock(): void {
    this.messages.push({ role: 'assistant', content: '' });
    this.streamingMessageIndex = this.messages.length - 1;
    this._messagesRevision++;
  }

  public updateStreamingBlock(content: string): void {
    if (this.streamingMessageIndex < 0) return;
    const message = this.messages[this.streamingMessageIndex];
    if (message?.role === 'assistant') {
      message.content = content;
      this._messagesRevision++;
    }
  }

  public finalizeStreamingBlock(): void {
    if (this.streamingMessageIndex >= 0 && this.messages[this.streamingMessageIndex]?.role === 'assistant') {
      this.messages.splice(this.streamingMessageIndex, 1);
    }
    this.streamingMessageIndex = -1;
    this._messagesRevision++;
  }

  public getMessageSnapshot(): ConversationMessageSnapshot[] {
    return cloneMessages(this.messages);
  }

  public getTranscriptEventIndex() {
    return buildTranscriptEventIndex(this.getMessageSnapshot());
  }

  public replaceMessagesForLLM(newMessages: ProviderMessage[]): void {
    const systemMessages = this.messages.filter((message) => message.role === 'system');
    this.messages = [...systemMessages, ...messagesToInternal(newMessages)];
    this.streamingMessageIndex = -1;
    this._messagesRevision++;
  }

  public async compact(
    registry: ProviderRegistry,
    modelId: string,
    trigger: 'auto' | 'manual' = 'manual',
    provider?: string,
    context?: CompactionContext,
  ): Promise<CompactionReceipt | undefined> {
    return compactConversation(this, registry, modelId, trigger, provider, context);
  }

  public get title(): string {
    return this._title;
  }

  public set title(value: string) {
    this._title = String(value ?? '');
    this._titleSource = this._title.trim().length > 0 ? 'user' : 'system';
  }

  public getTitleSource(): ConversationTitleSource {
    return this._titleSource;
  }

  public setSystemTitle(value: string): void {
    if (this._titleSource === 'user') return;
    this._title = String(value ?? '');
    this._titleSource = 'system';
  }

  public resetAll(): void {
    this.messages = [];
    this._title = '';
    this._titleSource = 'system';
    this.branches.clear();
    this.currentBranch = 'main';
    this.streamingMessageIndex = -1;
    this.undoStack = [];
    this._messagesRevision++;
  }

  public forkBranch(name?: string, force = false): string {
    const branchName = name?.trim() || `branch-${Date.now()}`;
    if (!force && this.branches.has(branchName)) {
      return branchName;
    }
    this.branches.set(branchName, cloneMessages(this.messages));
    return branchName;
  }

  public listBranches(): Array<{ name: string; messageCount: number; isCurrent: boolean }> {
    const result: Array<{ name: string; messageCount: number; isCurrent: boolean }> = [];
    const currentInMap = this.branches.has(this.currentBranch);
    if (!currentInMap) {
      result.push({ name: this.currentBranch, messageCount: this.messages.length, isCurrent: true });
    }
    for (const [name, messages] of this.branches) {
      result.push({ name, messageCount: messages.length, isCurrent: name === this.currentBranch });
    }
    return result;
  }

  public switchBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    this.branches.set(this.currentBranch, cloneMessages(this.messages));
    this.messages = cloneMessages(stored);
    this.currentBranch = name;
    this.streamingMessageIndex = -1;
    this._messagesRevision++;
    return true;
  }

  public mergeBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    const commonLength = Math.min(this.messages.length, stored.length);
    const toAppend = stored.slice(commonLength);
    if (toAppend.length === 0) return true;
    this.messages.push(...cloneMessages(toAppend));
    this._messagesRevision++;
    return true;
  }

  public getCurrentBranch(): string {
    return this.currentBranch;
  }

  public toJSON(): object {
    return {
      messages: cloneMessages(this.messages),
      timestamp: Date.now(),
      title: this._title,
      titleSource: this._titleSource,
      branches: cloneBranchMap(this.branches),
      currentBranch: this.currentBranch,
    };
  }

  public fromJSON(data: {
    messages: Message[];
    branches?: Record<string, Message[]> | undefined;
    currentBranch?: string | undefined;
    title?: string | undefined;
    titleSource?: ConversationTitleSource | undefined;
  }): void {
    this.messages = cloneMessages(data.messages ?? []);
    this._title = typeof data.title === 'string' ? data.title : '';
    this._titleSource = data.titleSource === 'user' || data.titleSource === 'system'
      ? data.titleSource
      : (this._title ? 'user' : 'system');
    this.branches = restoreBranchMap(data.branches);
    this.currentBranch = data.currentBranch ?? 'main';
    this.streamingMessageIndex = -1;
    this._messagesRevision++;
  }
}

export { parseDiffForApply, applyDiffContent } from './conversation-diff.js';
