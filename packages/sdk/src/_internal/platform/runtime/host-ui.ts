export interface HostSlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  readonly argsHint?: string;
  readonly handler: (args: string[]) => void | Promise<void>;
}

export interface CommandRegistryLike {
  register(command: HostSlashCommand): void;
  unregister(name: string): void;
}

export interface HostKeyCombo {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface KeybindingEntry {
  readonly action: string;
  readonly combos: readonly HostKeyCombo[];
  readonly description: string;
}

export interface KeybindingsManagerLike {
  loadFromDisk?(): void;
  getAll?(): readonly KeybindingEntry[];
  getComboLabel?(action: string): string;
  formatCombo?(combo: HostKeyCombo): string;
  getConfigPath?(): string;
  matches?(
    action: string,
    token: { readonly logicalName?: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly alt?: boolean },
  ): boolean;
}

export interface PanelInstanceLike {
  readonly id: string;
}

export interface PanelPaneLike {
  readonly panels: readonly PanelInstanceLike[];
  readonly activeIndex: number;
}

export interface PanelRegistrationLike {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
}

export interface PanelManagerLike {
  getTopPane(): PanelPaneLike;
  getBottomPane(): PanelPaneLike;
  getRegisteredTypes(): readonly PanelRegistrationLike[];
  open(id: string, pane?: 'top' | 'bottom'): unknown;
  show(): void;
}

const EMPTY_PANE: PanelPaneLike = Object.freeze({
  panels: Object.freeze([]),
  activeIndex: 0,
});

const EMPTY_PANEL_MANAGER: PanelManagerLike = Object.freeze({
  getTopPane: () => EMPTY_PANE,
  getBottomPane: () => EMPTY_PANE,
  getRegisteredTypes: () => [],
  open: () => null,
  show: () => {},
});

const EMPTY_KEYBINDINGS_MANAGER: KeybindingsManagerLike = Object.freeze({
  getAll: () => [],
  getComboLabel: () => '(unbound)',
  formatCombo: (combo: HostKeyCombo) => combo.key,
  getConfigPath: () => '',
  matches: () => false,
  loadFromDisk: () => {},
});

export function createNoopPanelManager(): PanelManagerLike {
  return EMPTY_PANEL_MANAGER;
}

export function createNoopKeybindingsManager(): KeybindingsManagerLike {
  return EMPTY_KEYBINDINGS_MANAGER;
}
