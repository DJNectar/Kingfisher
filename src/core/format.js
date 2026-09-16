/**
 * Presentation helpers shared by the rules, the UI and the exporters, so a
 * duration or a file size reads identically everywhere it appears.
 *
 * Every one of these takes a possibly-null value and returns a dash for it.
 * Unknown must look unknown, never like zero.
 */

export const UNKNOWN = '—';

export function formatBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]} (${n.toLocaleString('en-US')} bytes)`;
}

/** Short form for tables, without the exact byte count. */
export function formatBytesShort(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return UNKNOWN;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** h:mm:ss.mmm — the form an audio person expects to read. */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNKNOWN;
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const msStr = String(ms === 1000 ? 999 : ms).padStart(3, '0');
  return h > 0
    ? `${sign}${h}:${pad(m)}:${pad(sec)}.${msStr}`
    : `${sign}${m}:${pad(sec)}.${msStr}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatSampleRate(hz) {
  if (!hz) return UNKNOWN;
  // Drop trailing zeros: 44.1 kHz, not 44.100 kHz.
  const khz = Number((hz / 1000).toFixed(3));
  return `${khz} kHz (${hz.toLocaleString('en-US')} Hz)`;
}

export function formatBitDepth(bits, family) {
  if (!bits) return UNKNOWN;
  const kind = family === 'pcm-float' ? 'float' : family === 'pcm-int' ? 'integer' : '';
  return kind ? `${bits}-bit ${kind}` : `${bits}-bit`;
}

export function formatChannels(count, layoutName) {
  if (!count) return UNKNOWN;
  const base = count === 1 ? '1 (mono)' : count === 2 ? '2 (stereo)' : String(count);
  return layoutName && count > 2 ? `${base} — ${layoutName}` : base;
}

export function formatDbfs(db, digits = 2) {
  if (db === null || db === undefined) return UNKNOWN;
  if (db === -Infinity) return '-∞ dBFS';
  if (!Number.isFinite(db)) return UNKNOWN;
  return `${db >= 0 ? '+' : ''}${db.toFixed(digits)} dBFS`;
}

export function formatTimestamp(iso) {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateOnly(iso) {
  if (!iso) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}
