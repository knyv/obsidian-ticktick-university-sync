export function normalizeTag(tag: string): string {
  return String(tag || '').trim().replace(/^#/, '').toLowerCase();
}

export function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

export function firstNonEmptyField(record: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const value = String(record[k] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export function renderTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_full, key: string) => tokens[key] ?? '');
}

export function makeRuleId(prefix: string): string {
  const safe = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'rule';
  return `${safe}-${Date.now()}`;
}
