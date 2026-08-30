export type CommandSource = 'frontend' | 'api';

export type CommandApiSource = 'builtin' | 'extension' | 'prompt' | 'skill' | 'unknown';

export interface PiCommand {
  name: string;
  description?: string;
  source: CommandSource;
  apiSource?: CommandApiSource;
  category?: string;
  requiresArgs?: boolean;
  dangerous?: boolean;
}
