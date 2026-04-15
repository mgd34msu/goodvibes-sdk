import type { ProviderMessage, ContentPart } from '../providers/interface.js';
import type { ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CompactionContext } from './context-compaction.js';
import type { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core/session-memory';
import type { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core/session-lineage';
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

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type AssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  reasoningSummary?: string;
  usage?: TokenUsage;
  model?: string;
  provider?: string;
};

export type ConversationMessageSnapshot =
  | { role: 'user'; content: string | ContentPart[]; cancelled?: boolean }
  | AssistantMessage
  | { role: 'system'; content: string }
  | { role: 'tool'; callId: string; content: string; toolName?: string };

type Message = ConversationMessageSnapshot;
export type ConversationTitleSource = 'system' | 'user';

export interface BlockMeta {
  blockIndex: number;
  type: 'tool' | 'code' | 'diff' | 'thinking';
  startLine: number;
  lineCount: number;
  rawContent: string;
  collapseKey: string;
  filePath?: string;
  diffOriginal?: string;
  diffUpdated?: string;
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

  constructor(_getWidth: () => number = () => 80, _configManager?: unknown) {}

  private findToolName(callId: string): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
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

  public getMessagesForLLM(): ProviderMessage[] {
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
    return result;
  }

  public addUserMessage(content: string | ContentPart[]): void {
    if (this._title === '' && typeof content === 'string' && content.trim().length > 0) {
      this.setSystemTitle(deriveConversationTitle(content));
    }
    this.messages.push({ role: 'user', content });
  }

  public addAssistantMessage(
    content: string,
    opts?: {
      toolCalls?: ToolCall[];
      reasoningContent?: string;
      reasoningSummary?: string;
      usage?: TokenUsage;
      model?: string;
      provider?: string;
    },
  ): void {
    this.messages.push({
      role: 'assistant',
      content,
      toolCalls: opts?.toolCalls,
      reasoningContent: opts?.reasoningContent,
      reasoningSummary: opts?.reasoningSummary,
      usage: opts?.usage,
      model: opts?.model,
      provider: opts?.provider,
    });
  }

  public addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      const content = result.success
        ? (result.output ?? 'Tool completed successfully.')
        : `Error: ${result.error ?? 'Unknown error'}`;
      const toolName = this.findToolName(result.callId);
      this.messages.push({
        role: 'tool',
        callId: result.callId,
        content,
        ...(toolName ? { toolName } : {}),
      });
    }
  }

  public addSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
  }

  public getLastUserMessage(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        const content = this.messages[i].content;
        return typeof content === 'string' ? content : null;
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
    }
  }

  public markLastUserMessageCancelled(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        (this.messages[i] as { cancelled?: boolean }).cancelled = true;
        return;
      }
    }
  }

  public startStreamingBlock(): void {
    this.messages.push({ role: 'assistant', content: '' });
    this.streamingMessageIndex = this.messages.length - 1;
  }

  public updateStreamingBlock(content: string): void {
    if (this.streamingMessageIndex < 0) return;
    const message = this.messages[this.streamingMessageIndex];
    if (message?.role === 'assistant') {
      message.content = content;
    }
  }

  public finalizeStreamingBlock(): void {
    if (this.streamingMessageIndex >= 0 && this.messages[this.streamingMessageIndex]?.role === 'assistant') {
      this.messages.splice(this.streamingMessageIndex, 1);
    }
    this.streamingMessageIndex = -1;
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
  }

  public async compact(
    registry: ProviderRegistry,
    modelId: string,
    trigger: 'auto' | 'manual' = 'manual',
    provider?: string,
    context?: CompactionContext,
  ): Promise<void> {
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
    return true;
  }

  public mergeBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    const commonLength = Math.min(this.messages.length, stored.length);
    const toAppend = stored.slice(commonLength);
    if (toAppend.length === 0) return true;
    this.messages.push(...cloneMessages(toAppend));
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
    branches?: Record<string, Message[]>;
    currentBranch?: string;
    title?: string;
    titleSource?: ConversationTitleSource;
  }): void {
    this.messages = data.messages ?? [];
    this._title = typeof data.title === 'string' ? data.title : '';
    this._titleSource = data.titleSource === 'user' || data.titleSource === 'system'
      ? data.titleSource
      : (this._title ? 'user' : 'system');
    this.branches = restoreBranchMap(data.branches);
    this.currentBranch = data.currentBranch ?? 'main';
    this.streamingMessageIndex = -1;
  }
}

export { parseDiffForApply, applyDiffContent } from './conversation-diff.js';
