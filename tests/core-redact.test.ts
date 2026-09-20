import { describe, expect, it } from 'vitest';
import { containsSecret, redactText, Redactor } from '../src/core/redact.js';

describe('detectors', () => {
  const cases: Array<{ name: string; kind: string; text: string; secret: string }> = [
    {
      name: 'Anthropic key',
      kind: 'anthropic_key',
      text: `key: sk-ant-${'A'.repeat(24)}`,
      secret: `sk-ant-${'A'.repeat(24)}`,
    },
    {
      name: 'OpenAI key',
      kind: 'openai_key',
      text: `key: sk-${'B'.repeat(24)}`,
      secret: `sk-${'B'.repeat(24)}`,
    },
    {
      name: 'OpenRouter key',
      kind: 'openai_key',
      text: `key: sk-or-${'B'.repeat(24)}`,
      secret: `sk-or-${'B'.repeat(24)}`,
    },
    {
      name: 'TypeSafe key',
      kind: 'typesafe_key',
      text: `key: ts_${'C'.repeat(24)}`,
      secret: `ts_${'C'.repeat(24)}`,
    },
    {
      name: 'GitHub token',
      kind: 'github_token',
      text: `token: ghp_${'D'.repeat(36)}`,
      secret: `ghp_${'D'.repeat(36)}`,
    },
    {
      name: 'GitHub PAT',
      kind: 'github_pat',
      text: `token: github_pat_${'E'.repeat(30)}`,
      secret: `github_pat_${'E'.repeat(30)}`,
    },
    {
      name: 'AWS access key id',
      kind: 'aws_access_key',
      text: 'id: AKIAABCDEFGHIJKL1234',
      secret: 'AKIAABCDEFGHIJKL1234',
    },
    {
      name: 'Google API key',
      kind: 'google_api_key',
      text: `key: AIza${'F'.repeat(35)}`,
      secret: `AIza${'F'.repeat(35)}`,
    },
    {
      name: 'Slack token',
      kind: 'slack_token',
      text: 'token: xoxb-1234567890-abcdefg',
      secret: 'xoxb-1234567890-abcdefg',
    },
    {
      name: 'Stripe key',
      kind: 'stripe_key',
      text: `key: sk_live_${'4'.repeat(20)}`,
      secret: `sk_live_${'4'.repeat(20)}`,
    },
    {
      name: 'JWT',
      kind: 'jwt',
      text:
        'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    },
    {
      name: 'Bearer token',
      kind: 'bearer_token',
      text: `Authorization: Bearer ${'G'.repeat(30)}`,
      secret: 'G'.repeat(30),
    },
    {
      name: 'credential assignment',
      kind: 'credential',
      text: 'password=SuperSecret12345',
      secret: 'SuperSecret12345',
    },
  ];

  for (const { name, kind, text, secret } of cases) {
    it(`redacts a ${name}`, () => {
      const redactor = new Redactor();
      const redacted = redactor.redact(text);
      expect(redacted).not.toContain(secret);
      expect(redacted).toMatch(/<SECRET_1>/);
      expect(redactor.matches).toEqual([{ kind, placeholder: '<SECRET_1>', length: secret.length }]);
      expect(containsSecret(text)).toBe(true);
    });
  }

  it('redacts a private key block', () => {
    const text = [
      'begin key',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIBOgIBAAJBAK0FVcuquiZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '-----END RSA PRIVATE KEY-----',
      'end key',
    ].join('\n');
    const { text: redacted, count } = redactText(text);
    expect(redacted).not.toContain('MIIBOgIBAAJBAK0FVcuquiZ');
    expect(redacted).toContain('begin key');
    expect(redacted).toContain('end key');
    expect(count).toBe(1);
  });

  it('redacts only the password in a database URL, keeping scheme and user', () => {
    const text = 'DATABASE_URL=postgres://appuser:hunter2VeryLongPass@db.example.com:5432/mydb';
    const redacted = new Redactor().redact(text);
    expect(redacted).toContain('postgres://appuser:');
    expect(redacted).toContain('@db.example.com:5432/mydb');
    expect(redacted).not.toContain('hunter2VeryLongPass');
    expect(redacted).toMatch(/postgres:\/\/appuser:<SECRET_1>@db\.example\.com:5432\/mydb/);
  });

  it('redacts an .env-style line the generic credential pattern would not catch', () => {
    const text = 'MY_APP_TOKEN=this is a real looking secret value';
    const redactor = new Redactor();
    const redacted = redactor.redact(text);
    expect(redacted).toBe('MY_APP_TOKEN=<SECRET_1>');
    expect(redactor.matches).toEqual([
      { kind: 'env_credential', placeholder: '<SECRET_1>', length: 'this is a real looking secret value'.length },
    ]);
  });
});

describe('placeholders that are obviously not secrets', () => {
  it('leaves <your key>, xxx runs, dot runs, ${VAR} and process.env.X untouched', () => {
    const text = [
      'API_KEY=<your key>',
      'DB_PASSWORD=xxxxxxxx',
      'SOME_SECRET=........',
      'APP_TOKEN=${SECRET_TOKEN}',
      'AUTH_TOKEN=process.env.AUTH_TOKEN',
    ].join('\n');
    const { text: redacted, count } = redactText(text);
    expect(redacted).toBe(text);
    expect(count).toBe(0);
    expect(containsSecret(text)).toBe(false);
  });
});

describe('stable placeholders', () => {
  it('gives the same secret the same placeholder across many texts', () => {
    const redactor = new Redactor();
    const secret = `sk-ant-${'H'.repeat(24)}`;
    const first = redactor.redact(`first mention: ${secret}`);
    const second = redactor.redact(`second mention, same key: ${secret}`);
    const firstPlaceholder = first.match(/<SECRET_\d+>/)?.[0];
    const secondPlaceholder = second.match(/<SECRET_\d+>/)?.[0];
    expect(firstPlaceholder).toBeDefined();
    expect(firstPlaceholder).toBe(secondPlaceholder);
    expect(redactor.count).toBe(1);
    expect(redactor.matches).toHaveLength(1);
  });

  it('issues distinct numbers for distinct secrets, in order of first sighting', () => {
    const redactor = new Redactor();
    const a = `sk-ant-${'A'.repeat(24)}`;
    const b = `sk-ant-${'B'.repeat(24)}`;
    const out = redactor.redact(`${a} then ${b} then ${a} again`);
    expect(out).toBe('<SECRET_1> then <SECRET_2> then <SECRET_1> again');
    expect(redactor.count).toBe(2);
  });
});

describe('user path redaction', () => {
  it('redacts the user segment only when redactUserPaths is enabled', () => {
    const text = 'reading C:\\Users\\bunkspunkles\\project\\file.ts';
    const off = new Redactor().redact(text);
    expect(off).toBe(text);

    const on = new Redactor({ redactUserPaths: true }).redact(text);
    expect(on).toBe('reading C:\\Users\\<USER>\\project\\file.ts');
  });

  it('redacts unix home paths too', () => {
    const redactor = new Redactor({ redactUserPaths: true });
    expect(redactor.redact('/home/alice/repo')).toBe('/home/<USER>/repo');
    expect(redactor.redact('/Users/alice/repo')).toBe('/Users/<USER>/repo');
  });
});

describe('extraPatterns', () => {
  it('redacts custom patterns and adds the global flag if missing', () => {
    const redactor = new Redactor({ extraPatterns: [/internal-[0-9]{6}/] });
    const redacted = redactor.redact('ticket internal-123456 and internal-654321');
    expect(redacted).toBe('ticket <SECRET_1> and <SECRET_2>');
    expect(redactor.matches.every((m) => m.kind === 'custom')).toBe(true);
  });
});

describe('redactValue', () => {
  it('walks nested objects and arrays, returning a deep copy', () => {
    const redactor = new Redactor();
    const secret = `sk-ant-${'Z'.repeat(24)}`;
    const original = {
      headers: { authorization: `Bearer ${secret}` },
      items: ['plain text', { nested: secret }],
      count: 3,
      ok: true,
    };
    const redacted = redactor.redactValue(original);
    expect(redacted).not.toBe(original);
    expect(redacted.headers).not.toBe(original.headers);
    expect(redacted.items).not.toBe(original.items);
    expect(redacted.headers.authorization).not.toContain(secret);
    expect((redacted.items[1] as { nested: string }).nested).not.toContain(secret);
    expect(redacted.count).toBe(3);
    expect(redacted.ok).toBe(true);
    // the original is untouched
    expect(original.headers.authorization).toContain(secret);
  });
});

describe('containsSecret', () => {
  it('is true only when a detector would actually redact something', () => {
    expect(containsSecret('nothing to see here')).toBe(false);
    expect(containsSecret(`sk-ant-${'A'.repeat(24)}`)).toBe(true);
  });
});
