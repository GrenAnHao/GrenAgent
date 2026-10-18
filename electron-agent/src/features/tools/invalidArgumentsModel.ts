import { extractText } from './toolUtils';

/**
 * A tool call whose arguments were not a valid JSON object (pi 1.3.0, pi #10897).
 *
 * pi-ai parses the finished arguments text with `parseToolCallArguments`: on failure `arguments`
 * is `{}` and `argumentsError` holds the parse error plus the raw text. Validation then throws
 * `Invalid arguments for tool "<name>": <argumentsError>`, which agent-core turns into the error
 * tool result. So the card sees empty args and this text; it shows the reason and what the model
 * sent instead of an empty command or path.
 */
export interface InvalidArguments {
  tool: string;
  /** Parse error, e.g. `Expected ',' or '}' after property value in JSON at position 41`. */
  reason: string;
  /** The arguments text exactly as the model sent it. */
  received: string;
}

const INVALID_ARGUMENTS = /^Invalid arguments for tool "([^"]*)": ([\s\S]*?)\n\nReceived arguments:\n([\s\S]*)$/;

export function parseInvalidArguments(result: unknown): InvalidArguments | undefined {
  const text = extractText(result).replace(/\r\n/g, '\n');
  const match = INVALID_ARGUMENTS.exec(text);
  if (!match) return undefined;
  return { tool: match[1], reason: match[2].trim(), received: match[3] };
}

