import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateAdversarialDataset } from '../scripts/make-adversarial.js';
import { listCases } from '../src/node/evals/dataset.js';
import type { Message } from '../src/types.js';

let dirA: string;
let dirB: string;

beforeAll(async () => {
  dirA = await mkdtemp(path.join(os.tmpdir(), 'fast-jev-adversarial-a-'));
  dirB = await mkdtemp(path.join(os.tmpdir(), 'fast-jev-adversarial-b-'));
  await generateAdversarialDataset(dirA);
  await generateAdversarialDataset(dirB);
});

afterAll(async () => {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

function transcriptText(transcript: readonly Message[]): string {
  const pieces: string[] = [];
  for (const message of transcript) {
    pieces.push(message.text);
    for (const tool of message.toolUses) {
      pieces.push(JSON.stringify(tool.input));
      if (tool.text) pieces.push(tool.text);
    }
    for (const result of message.toolResults ?? []) pieces.push(result.text);
  }
  return pieces.join('\n');
}

describe('make-adversarial', () => {
  it('writes exactly eight cases', async () => {
    const cases = await listCases(dirA);
    expect(cases).toHaveLength(8);
    expect(new Set(cases.map((c) => c.name)).size).toBe(8);
  });

  it('never places a tool_result before its tool_use', async () => {
    const cases = await listCases(dirA);
    for (const item of cases) {
      const seenCalls = new Set<string>();
      for (const message of item.transcript) {
        for (const tool of message.toolUses) seenCalls.add(tool.tool_use_id);
        for (const result of message.toolResults ?? []) {
          expect(seenCalls.has(result.tool_use_id), `${item.name}: tool_result ${result.tool_use_id} appears before its tool_use`).toBe(true);
        }
      }
    }
  });

  it('every probe text is an exact substring of its case transcript', async () => {
    const cases = await listCases(dirA);
    for (const item of cases) {
      expect(item.labels, `${item.name} has no labels.json`).toBeDefined();
      const text = transcriptText(item.transcript);
      for (const probe of item.labels!.probes) {
        expect(text.includes(probe.text), `${item.name}: probe ${probe.id} text ${JSON.stringify(probe.text)} not found`).toBe(true);
      }
    }
  });

  it('every label references a tool_use_id that exists in the transcript', async () => {
    const cases = await listCases(dirA);
    for (const item of cases) {
      const ids = new Set(item.transcript.flatMap((m) => m.toolUses.map((t) => t.tool_use_id)));
      for (const toolUseId of Object.keys(item.labels!.calls)) {
        expect(ids.has(toolUseId), `${item.name}: label references unknown tool_use_id ${toolUseId}`).toBe(true);
      }
    }
  });

  it('every tool_use_id is unique within a case', async () => {
    const cases = await listCases(dirA);
    for (const item of cases) {
      const ids = item.transcript.flatMap((m) => m.toolUses.map((t) => t.tool_use_id));
      expect(new Set(ids).size, `${item.name}: duplicate tool_use_id`).toBe(ids.length);
    }
  });

  it('contains at least one exact-duplicate tool interaction per case', async () => {
    const cases = await listCases(dirA);
    for (const item of cases) {
      const seen = new Map<string, number>();
      for (const message of item.transcript) {
        for (const tool of message.toolUses) {
          if ((tool.text?.length ?? 0) < 40) continue;
          const key = `${tool.tool}\u0000${JSON.stringify(tool.input)}\u0000${tool.text}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
      expect([...seen.values()].some((n) => n >= 2), `${item.name}: no exact-duplicate tool interaction found`).toBe(true);
    }
  });

  it('is deterministic: two runs produce byte-identical transcript.json files', async () => {
    const cases = await listCases(dirA);
    for (const item of cases) {
      const a = await readFile(path.join(dirA, item.name, 'transcript.json'));
      const b = await readFile(path.join(dirB, item.name, 'transcript.json'));
      expect(b.equals(a), `${item.name}: transcript.json differs between runs`).toBe(true);
    }
  });
});
