export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  argsHint?: string;
  handler: (args: string[]) => void | Promise<void>;
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliasIndex = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.aliasIndex.set(alias, command);
    }
  }

  unregister(name: string): void {
    const command = this.commands.get(name);
    if (command) {
      for (const alias of command.aliases ?? []) {
        this.aliasIndex.delete(alias);
      }
    }
    this.commands.delete(name);
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name) ?? this.aliasIndex.get(name);
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }
}
