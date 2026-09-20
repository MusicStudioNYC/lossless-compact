/**
 * Secret redaction for anything about to leave the machine (a Jev request, a
 * classifier log, an archive record): tool inputs and results can carry API
 * keys, tokens and credentials verbatim, and nothing downstream should ever
 * see them (plan section 23; upstream issue #64 sent tool inputs to the
 * classifier unredacted). Detection is regex-based and stateless per pattern;
 * the `Redactor` class only adds the bookkeeping needed to keep one secret's
 * placeholder stable across many texts of the same session.
 */

/** One placeholder issued for a distinct secret; never the original value. */
export interface RedactionMatch {
  kind: string;
  placeholder: string;
  /** length of the original */
  length: number;
}

export interface RedactOptions {
  /** Extra regexes (global flag added if missing) whose matches are redacted with kind 'custom'. */
  extraPatterns?: RegExp[];
  /** Also redact absolute home-directory paths' user segment (C:\Users\<name>, /home/<name>, /Users/<name>) → <USER>. Default false. */
  redactUserPaths?: boolean;
}

interface Detector {
  kind: string;
  regex: RegExp;
  /** Capture group holding the sensitive substring; 0 (the default) redacts the whole match. */
  group?: number;
}

interface ClaimedSpan {
  start: number;
  end: number;
  kind: string;
  value: string;
}

/** Runs every match through the same overlap-safe extraction, so a more
 * specific detector (an Anthropic key) always wins over a more general one
 * (a bare `sk-` prefix, a generic `token=` assignment) that would otherwise
 * also match part of the same text. */
function toStatefulRegex(source: RegExp): RegExp {
  const flags = `${source.flags.replace(/[gd]/g, '')}gd`;
  return new RegExp(source.source, flags);
}

/** Values that are obviously not secrets and must never be redacted. */
function isObviousPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (/^x{3,}$/i.test(v)) return true;
  if (/^\.{3,}$/.test(v)) return true;
  if (/^<[^<>]*>$/.test(v)) return true;
  if (/^\$\{[^}]*\}$/.test(v)) return true;
  if (/^(?:process\.env\.|import\.meta\.env\.)[\w.]*$/i.test(v)) return true;
  return false;
}

type IndicesArray = Array<[number, number] | undefined>;

/**
 * Finds every span to redact across all detectors, in priority order (the
 * array's own order): a detector's match is dropped when it overlaps a span
 * an earlier, more specific detector already claimed on this same text.
 */
function findSpans(text: string, detectors: readonly Detector[]): ClaimedSpan[] {
  const claimed: ClaimedSpan[] = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some((c) => start < c.end && end > c.start);
  for (const detector of detectors) {
    const regex = toStatefulRegex(detector.regex);
    const groupIndex = detector.group ?? 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = match[groupIndex];
      if (!value) {
        if (match[0].length === 0) regex.lastIndex += 1;
        continue;
      }
      if (isObviousPlaceholder(value)) continue;
      const indices = (match as RegExpExecArray & { indices?: IndicesArray }).indices;
      const span = indices?.[groupIndex];
      if (!span) continue;
      const [start, end] = span;
      if (overlaps(start, end)) continue;
      claimed.push({ start, end, kind: detector.kind, value });
    }
  }
  return claimed;
}

const BUILTIN_DETECTORS: readonly Detector[] = [
  {
    kind: 'private_key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  },
  { kind: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'anthropic_key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai_key', regex: /sk-(?:or-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'typesafe_key', regex: /ts_[A-Za-z0-9]{20,}/ },
  { kind: 'github_pat', regex: /github_pat_[A-Za-z0-9_]{22,}/ },
  { kind: 'github_token', regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { kind: 'aws_secret_key', regex: /aws_secret_access_key\s*[=:]\s*(\S+)/i, group: 1 },
  { kind: 'google_api_key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: 'slack_token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'stripe_key', regex: /sk_(?:live|test)_[A-Za-z0-9]{16,}/ },
  {
    kind: 'db_url',
    regex: /(?:postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:([^@\s/]+)@/i,
    group: 1,
  },
  { kind: 'bearer_token', regex: /Bearer\s+([A-Za-z0-9._-]{20,})/, group: 1 },
  {
    kind: 'credential',
    regex:
      /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*['"]?([A-Za-z0-9+/=_.~-]{8,})['"]?/i,
    group: 1,
  },
  { kind: 'env_credential', regex: /^[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS)=(.+)$/m, group: 1 },
];

const USER_PATH_DETECTORS: readonly Detector[] = [
  { kind: 'user_path', regex: /[A-Za-z]:\\Users\\([^\\/:*?"<>|\r\n]+)/, group: 1 },
  { kind: 'user_path', regex: /\/home\/([^/\s]+)/, group: 1 },
  { kind: 'user_path', regex: /\/Users\/([^/\s]+)/, group: 1 },
];

/**
 * Stateful so the same secret gets the same placeholder across many texts of
 * one session: a `<SECRET_n>` numbering is issued once per distinct value and
 * reused on every later sighting, whatever detector or text finds it again.
 */
export class Redactor {
  private readonly detectors: Detector[];
  private readonly placeholders = new Map<string, RedactionMatch>();
  private readonly issued: RedactionMatch[] = [];
  private counter = 0;

  constructor(options: RedactOptions = {}) {
    this.detectors = [...BUILTIN_DETECTORS];
    if (options.redactUserPaths) this.detectors.push(...USER_PATH_DETECTORS);
    for (const pattern of options.extraPatterns ?? []) {
      this.detectors.push({ kind: 'custom', regex: pattern });
    }
  }

  /** Returns the text with every secret replaced by a stable placeholder like <SECRET_3>. */
  redact(text: string): string {
    if (text.length === 0) return text;
    const spans = findSpans(text, this.detectors).sort((a, b) => a.start - b.start);
    if (spans.length === 0) return text;
    let out = '';
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      out += this.placeholderFor(span.kind, span.value);
      cursor = span.end;
    }
    out += text.slice(cursor);
    return out;
  }

  /** Same for a JSON-serialisable value (walks strings inside objects/arrays; returns a deep copy). */
  redactValue<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = this.walk(v);
      return out;
    }
    return value;
  }

  private placeholderFor(kind: string, value: string): string {
    let entry = this.placeholders.get(value);
    if (!entry) {
      const placeholder = kind === 'user_path' ? '<USER>' : `<SECRET_${++this.counter}>`;
      entry = { kind, placeholder, length: value.length };
      this.placeholders.set(value, entry);
      this.issued.push(entry);
    }
    return entry.placeholder;
  }

  /** Placeholders issued so far, with kind and original length (never the original value). */
  get matches(): readonly RedactionMatch[] {
    return this.issued;
  }

  /** Number of distinct secrets seen. */
  get count(): number {
    return this.issued.length;
  }
}

/** One-shot convenience. */
export function redactText(text: string, options?: RedactOptions): { text: string; count: number } {
  const redactor = new Redactor(options);
  const redacted = redactor.redact(text);
  return { text: redacted, count: redactor.count };
}

/** True when the text contains anything the detectors would redact (cheap pre-check). */
export function containsSecret(text: string): boolean {
  return findSpans(text, BUILTIN_DETECTORS).length > 0;
}
