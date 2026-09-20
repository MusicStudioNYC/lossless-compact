/**
 * Retrieval check over a dataset: compact every case with the ruleset
 * classifier (deterministic, no key), then ask the archive with the case's
 * final user prompt and see which evicted `active_or_archive` probes come
 * back through `rehydrateForPrompt`, and how much was retrieved when no
 * probe had been evicted (junk). A "needle" is a probe of any kind but
 * `fact`: the detail the final task needs. `fact` probes are incidental
 * details the final prompt never asks about, listed for completeness.
 *
 *   npx tsx scripts/retrieval-check.ts --dataset datasets/v1 [--budget 6000]
 */
import { MemoryArchive } from '../src/archive/memory-store.js';
import { RulesetClassifier } from '../src/classifiers/ruleset.js';
import { optimize } from '../src/engine/optimize.js';
import { rehydrateForPrompt } from '../src/engine/rehydrate.js';
import { listCases } from '../src/node/evals/dataset.js';
import type { Message } from '../src/types.js';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

function transcriptText(messages: readonly Message[]): string {
  return messages
    .map((m) => [m.text, ...m.toolUses.map((u) => u.text ?? ''), ...(m.toolResults ?? []).map((r) => r.text)].join('\n'))
    .join('\n');
}

const dataset = arg('dataset', 'datasets/v1');
const budget = Number(arg('budget', '6000'));
const cases = await listCases(dataset);
let evicted = 0;
let recovered = 0;
let needles = 0;
let needlesBack = 0;
let junkChars = 0;
let junkCases = 0;
console.log(`| Case | Evicted needles | Needles back | Evicted facts | Facts back | Retrieved | Chars | Note |`);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
for (const item of cases) {
  const archive = new MemoryArchive();
  const result = await optimize(item.transcript, {
    classifier: new RulesetClassifier(),
    archive,
    sessionId: 'check',
    compactionId: 'check',
  });
  const active = transcriptText(result.messages);
  const probes = (item.labels?.probes ?? []).filter((p) => p.where === 'active_or_archive' && !active.includes(p.text));
  const finalPrompt = [...item.transcript].reverse().find((m) => m.role === 'user' && m.text.trim().length > 0)?.text ?? '';
  const found = await rehydrateForPrompt(archive, 'check', finalPrompt, { budgetChars: budget });
  const retrievedText = found.blocks.join('\n');
  const back = probes.filter((p) => retrievedText.includes(p.text));
  const needleProbes = probes.filter((p) => p.kind !== 'fact');
  const needleBack = back.filter((p) => p.kind !== 'fact');
  evicted += probes.length;
  recovered += back.length;
  needles += needleProbes.length;
  needlesBack += needleBack.length;
  if (probes.length === 0 && found.chars > 0) {
    junkCases += 1;
    junkChars += found.chars;
  }
  const label = (p: { id: string; text: string }): string => `${p.id} (${p.text.slice(0, 30)})`;
  const missingNeedles = needleProbes.filter((p) => !back.includes(p));
  let note: string;
  if (probes.length === 0) note = found.chars > 0 ? 'nothing evicted; retrieval is junk' : 'nothing evicted, nothing retrieved';
  else if (needleProbes.length === 0) note = 'no needle evicted';
  else if (missingNeedles.length === 0) note = `needle back: ${needleBack.map(label).join(', ')}`;
  else note = `needle missing: ${missingNeedles.map(label).join(', ')}`;
  console.log(
    `| ${item.name} | ${needleProbes.length} | ${needleBack.length} | ${probes.length - needleProbes.length} | ${back.length - needleBack.length} | ${found.records.length} | ${found.chars} | ${note} |`,
  );
}
console.log(
  `\nEvicted needles recovered by the final prompt: ${needlesBack}/${needles} (all probes ${recovered}/${evicted}); junk retrievals: ${junkCases} case(s), ${junkChars} chars.`,
);
