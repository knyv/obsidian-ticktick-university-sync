function formatTickTickDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}${om}`;
}

export function parseDueToTickTick(dueRaw: string): {
  isAllDay: boolean;
  dueDate: string;
  startDate?: string;
  timeZone?: string;
} {
  const raw = dueRaw.trim();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map((x) => Number(x));
    const start = new Date(y, m - 1, d, 0, 0, 0);
    const end = new Date(y, m - 1, d, 23, 59, 0);
    return {
      isAllDay: true,
      startDate: formatTickTickDate(start),
      dueDate: formatTickTickDate(end),
      timeZone: tz,
    };
  }

  // normalize timezone suffix if +HHMM
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  // YYYY-MM-DDTHH:mm[:ss][Z|±HH:mm]
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) {
    throw new Error(`Unsupported due format: ${dueRaw}`);
  }

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] ?? '0');
  const tzSuffix = m[7];

  const dt = tzSuffix
    ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2, '0')}${tzSuffix === 'Z' ? 'Z' : tzSuffix}`)
    : new Date(y, mo - 1, d, h, mi, s);

  return {
    isAllDay: false,
    dueDate: formatTickTickDate(dt),
    timeZone: tz,
  };
}
