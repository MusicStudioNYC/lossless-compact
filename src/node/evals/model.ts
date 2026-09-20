import { spawn, spawnSync } from 'node:child_process';

/**
 * One call to an LLM: a prompt in, generated text out. Used by the eval
 * harness for anything that needs a live model — native-compaction summaries
 * and the retention judge — never by the library itself.
 */
export interface ModelCall {
  (prompt: string, options?: { system?: string; maxTokens?: number }): Promise<{ text: string; ms: number }>;
}

export interface ClaudeCliOptions {
  /** Passed as `claude --model <model>`; omitted uses the CLI's own default. */
  model?: string;
  /** Kills the subprocess after this many ms. Default 600000 (10 minutes). */
  timeoutMs?: number;
}

const DEFAULT_CLAUDE_CLI_TIMEOUT_MS = 600_000;

function tail(text: string, chars = 4000): string {
  return text.length <= chars ? text : text.slice(-chars);
}

/**
 * Calls the `claude` CLI in print mode (`claude -p --output-format text
 * [--model <model>]`), with the prompt piped over stdin rather than argv —
 * eval prompts run 50k+ chars, well past what argv reliably carries,
 * especially on Windows. `shell: true` on win32 so PATH resolution finds the
 * npm-installed `claude.cmd` shim.
 */
export function claudeCli(options: ClaudeCliOptions = {}): ModelCall {
  const { model, timeoutMs = DEFAULT_CLAUDE_CLI_TIMEOUT_MS } = options;
  return (prompt, callOptions) =>
    new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])];
      if (callOptions?.system) args.push('--system-prompt', callOptions.system);
      const started = Date.now();
      const child = spawn('claude', args, { shell: process.platform === 'win32' });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          child.kill();
          reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        finish(() => reject(error));
      });
      child.on('close', (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(`claude -p exited ${code}: ${tail(stderr) || tail(stdout) || '(no output)'}`));
            return;
          }
          resolve({ text: stdout, ms: Date.now() - started });
        });
      });
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
    });
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8000;

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  content?: AnthropicTextBlock[];
}

/** Calls `POST https://api.anthropic.com/v1/messages` directly; only used when `ANTHROPIC_API_KEY` is set. */
export function anthropicApi(apiKey: string, model: string = DEFAULT_ANTHROPIC_MODEL): ModelCall {
  return async (prompt, options) => {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model,
      max_tokens: options?.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    };
    if (options?.system) body['system'] = options.system;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`anthropic /v1/messages ${response.status}: ${tail(raw)}`);
    }
    let parsed: AnthropicMessagesResponse;
    try {
      parsed = JSON.parse(raw) as AnthropicMessagesResponse;
    } catch {
      throw new Error(`anthropic /v1/messages returned unparsable JSON: ${tail(raw)}`);
    }
    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    return { text, ms: Date.now() - started };
  };
}

/** Whether `claude` resolves on PATH, checked synchronously with `where`/`which`. */
function claudeOnPath(): boolean {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(finder, ['claude'], { shell: process.platform === 'win32' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * `anthropicApi` when `ANTHROPIC_API_KEY` is set, else `claudeCli({ model:
 * 'sonnet' })` when `claude` is on PATH (sonnet for cost — this runs dozens
 * of summary/judge calls per eval), else `undefined`.
 */
export function defaultModel(): ModelCall | undefined {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) return anthropicApi(apiKey);
  if (claudeOnPath()) return claudeCli({ model: 'sonnet' });
  return undefined;
}
