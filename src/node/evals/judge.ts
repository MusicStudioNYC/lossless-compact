import { truncate } from '../../state.js';
import type { Message } from '../../types.js';
import type { DatasetCase } from './dataset.js';
import { renderTranscript } from './native.js';
import type { ModelCall } from './model.js';

/** One fact the judge is asked whether a compacted transcript still carries. */
export interface JudgeItem {
  id: string;
  kind: string;
  text: string;
  note?: string;
  expected: 'kept' | 'removed';
}

export interface JudgeVerdict {
  id: string;
  present: 'verbatim' | 'paraphrased' | 'absent';
  evidence?: string;
}

export interface JudgeResult {
  verdicts: JudgeVerdict[];
  ms: number;
  raw: string;
  /** Items the model's answer never mentioned; scored as 'absent'. */
  missingVerdicts: number;
}

const MAX_ITEMS = 40;

function findCall(
  transcript: readonly Message[],
  toolUseId: string,
): { tool: string; input: Record<string, unknown>; resultText: string } | undefined {
  let tool: string | undefined;
  let input: Record<string, unknown> | undefined;
  for (const message of transcript) {
    const use = message.toolUses.find((t) => t.tool_use_id === toolUseId);
    if (use) {
      tool = use.tool;
      input = use.input;
      break;
    }
  }
  if (tool === undefined) return undefined;
  let resultText = '';
  for (const message of transcript) {
    const result = (message.toolResults ?? []).find((r) => r.tool_use_id === toolUseId);
    if (result) {
      resultText = result.text;
      break;
    }
  }
  return { tool, input: input ?? {}, resultText };
}

function inputPreview(input: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(input) ?? '{}', 200);
  } catch {
    return '[unserializable input]';
  }
}

/** Evenly-spaced deterministic sample of `count` items from `list` (stable across runs). */
function deterministicSample<T>(list: readonly T[], count: number): T[] {
  if (count <= 0 || list.length === 0) return [];
  if (list.length <= count) return [...list];
  const step = list.length / count;
  const sampled: T[] = [];
  for (let i = 0; i < count; i++) sampled.push(list[Math.floor(i * step)]!);
  return sampled;
}

/**
 * The judge items for one dataset case: every probe (expected 'kept'), every
 * `must_keep` call (expected 'kept'), and a sample of `safe_to_drop` calls
 * (expected 'removed') — this last group is what measures "didn't remove
 * what it should have". Capped at 40 items: probes and must_keep calls
 * always fit first, then `safe_to_drop` fills whatever budget is left.
 */
export function judgeItemsFor(item: DatasetCase): JudgeItem[] {
  const probeItems: JudgeItem[] = (item.labels?.probes ?? []).map((probe) => ({
    id: probe.id,
    kind: probe.kind,
    text: probe.text,
    note: probe.note,
    expected: 'kept',
  }));

  const mustKeep: JudgeItem[] = [];
  const safeToDrop: JudgeItem[] = [];
  for (const [toolUseId, label] of Object.entries(item.labels?.calls ?? {})) {
    if (label !== 'must_keep' && label !== 'safe_to_drop') continue;
    const call = findCall(item.transcript, toolUseId);
    if (!call) continue;
    const entry: JudgeItem = {
      id: `call:${toolUseId}`,
      kind: label,
      text: `${call.resultText.slice(0, 300)} (tool ${call.tool}, input ${inputPreview(call.input)})`,
      expected: label === 'must_keep' ? 'kept' : 'removed',
    };
    if (label === 'must_keep') mustKeep.push(entry);
    else safeToDrop.push(entry);
  }

  const budget = Math.max(0, MAX_ITEMS - probeItems.length - mustKeep.length);
  const sampledDrop = deterministicSample(safeToDrop, budget);
  return [...probeItems, ...mustKeep, ...sampledDrop].slice(0, MAX_ITEMS);
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
}

function parseVerdicts(raw: string): JudgeVerdict[] {
  const cleaned = stripCodeFences(raw);
  const start = cleaned.indexOf('{');
  if (start < 0) return [];
  const candidate = cleaned.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const end = candidate.lastIndexOf('}');
    if (end < 0) return [];
    try {
      parsed = JSON.parse(candidate.slice(0, end + 1));
    } catch {
      return [];
    }
  }
  const verdictsField = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(verdictsField)) return [];
  const verdicts: JudgeVerdict[] = [];
  for (const entry of verdictsField) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e['id'] !== 'string') continue;
    const present = e['present'];
    if (present !== 'verbatim' && present !== 'paraphrased' && present !== 'absent') continue;
    const verdict: JudgeVerdict = { id: e['id'], present };
    if (typeof e['evidence'] === 'string' && e['evidence'].length > 0) verdict.evidence = e['evidence'];
    verdicts.push(verdict);
  }
  return verdicts;
}

/**
 * Asks `model` whether each item in `items` is still findable in `context`
 * (rendered the same way as `nativeCompaction`'s prompt): verbatim,
 * paraphrased (same fact, different wording — a different number/path/id/name
 * is NOT the same fact), or absent. Parses the model's JSON leniently (code
 * fences, trailing prose); any item the answer never mentions is scored
 * absent and counted in `missingVerdicts`.
 */
export async function judgeRetention(
  context: Message[],
  items: JudgeItem[],
  model: ModelCall,
): Promise<JudgeResult> {
  const rendered = renderTranscript(context);
  const itemsBlock = items
    .map((item) => {
      const noteLine = item.note ? `\n  note: ${item.note}` : '';
      return `- id: ${item.id}\n  kind: ${item.kind}\n  text: ${JSON.stringify(item.text)}${noteLine}`;
    })
    .join('\n');
  const prompt = `Here is a compacted conversation transcript:\n\n${rendered.text}\n\nFor each item below, decide whether its content is still findable in the transcript above:
- "verbatim": the exact text appears.
- "paraphrased": the same fact or value is stated in different words. A different number, path, id or name is NOT the same fact — score that "absent", not "paraphrased".
- "absent": not recoverable from the context at all.

Items:
${itemsBlock}

Respond with STRICT JSON only — no prose, no code fences — in exactly this shape:
{"verdicts":[{"id":"...","present":"verbatim|paraphrased|absent","evidence":"<=120 chars quoted from the context, or empty"}]}`;

  const started = Date.now();
  const { text } = await model(prompt);
  const ms = Date.now() - started;
  const parsed = parseVerdicts(text);
  const byId = new Map(parsed.map((verdict) => [verdict.id, verdict]));

  let missingVerdicts = 0;
  const verdicts: JudgeVerdict[] = items.map((item) => {
    const found = byId.get(item.id);
    if (!found) {
      missingVerdicts++;
      return { id: item.id, present: 'absent' };
    }
    return found;
  });

  return { verdicts, ms, raw: text, missingVerdicts };
}
