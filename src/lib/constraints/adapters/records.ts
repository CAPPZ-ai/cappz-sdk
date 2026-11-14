/**
 * COPE node crystallized.
 * Node ID: v15-40-00-constraint-adapter-records
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Observations from what plants already export:
 *
 *   - OPC UA PubSub JSON network messages (OPC 10000-14, ua-data): DataSet
 *     fields as raw values, DataValues ({ Value, SourceTimestamp, StatusCode })
 *     or Variants ({ Type, Body } / { UaType, Value }). StatusCode severity
 *     maps to quality: Good → good, Uncertain → uncertain, Bad → bad.
 *   - Historian exports (CSV or JSON) by naming their fields: long format
 *     (one row per sample: time, tag, value) or wide format (a time column
 *     and one column per tag).
 *
 * Mapping is explicit — a tag or field not in the map is returned as
 * unmapped, never matched by a guessed name. Field paths are dot paths read
 * literally; nothing from the data is compiled as a pattern.
 */

import type { PointValue } from '../authority.ts';
import type { Observation, Quality } from '../reconcile.ts';
import { parseCsv } from '../../identity/samlReconcile.ts';
import { NUMBER_TEXT } from './common.ts';

export { parseCsv };

const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

function parseTime(raw: unknown): number {
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw !== 'string' || !raw.trim()) return NaN;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  return Date.parse(s);
}

function parseValue(raw: unknown): PointValue | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim(); if (!s) return undefined;
  if (NUMBER_TEXT.test(s)) return Number(s);
  const l = s.toLowerCase();
  if (l === 'true' || l === 'on') return true;
  if (l === 'false' || l === 'off') return false;
  return s;
}

// ── OPC UA PubSub JSON ──

/** OPC UA StatusCode → quality by its severity bits (0x00 Good, 0x40 Uncertain, 0x80 Bad). */
export function opcuaQuality(status: unknown): Quality {
  const code = typeof status === 'number' ? status : typeof status === 'object' && status ? Number((status as { Code?: unknown }).Code ?? 0) : 0;
  if (!Number.isFinite(code)) return 'bad';
  const sev = (code >>> 30) & 3;
  return sev === 0 ? 'good' : sev === 1 ? 'uncertain' : 'bad';
}

function unwrapVariant(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ('Body' in o && ('Type' in o || Object.keys(o).length === 1)) return o.Body;
    if ('UaType' in o && 'Value' in o) return o.Value;
  }
  return v;
}

/**
 * Map keys: "<PublisherId>/<DataSetWriterId>/<field>", "<DataSetWriterId>/<field>" or "<field>"
 * (the most specific key that exists wins).
 */
export function observationsFromOpcUaJson(message: unknown, map: Record<string, string>, receivedAt = Date.now()): { observations: Observation[]; unmapped: string[] } {
  const out: Observation[] = []; const unmapped: string[] = [];
  const msgs: unknown[] = Array.isArray(message) ? message : [message];
  for (const nm of msgs) {
    if (!nm || typeof nm !== 'object') continue;
    const n = nm as Record<string, unknown>;
    if (n.MessageType !== undefined && n.MessageType !== 'ua-data') continue;
    const publisher = n.PublisherId === undefined ? undefined : String(n.PublisherId);
    const dataSets: unknown[] = Array.isArray(n.Messages) ? n.Messages : n.Payload ? [n] : [];
    for (const dsm of dataSets) {
      if (!dsm || typeof dsm !== 'object') continue;
      const d = dsm as Record<string, unknown>;
      const writer = d.DataSetWriterId === undefined ? undefined : String(d.DataSetWriterId);
      const msgTime = parseTime(d.Timestamp);
      const payload = d.Payload && typeof d.Payload === 'object' ? (d.Payload as Record<string, unknown>) : {};
      for (const [field, raw] of Object.entries(payload)) {
        const keys = [publisher && writer ? `${publisher}/${writer}/${field}` : '', writer ? `${writer}/${field}` : '', field].filter(Boolean);
        const point = keys.map((k) => map[k]).find(Boolean);
        if (!point) { unmapped.push(keys[0]); continue; }
        let value: unknown = raw; let at = Number.isFinite(msgTime) ? msgTime : receivedAt; let quality: Quality = 'good';
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && ('Value' in raw || 'StatusCode' in raw || 'SourceTimestamp' in raw) && !('UaType' in raw)) {
          const dv = raw as Record<string, unknown>;
          value = unwrapVariant(dv.Value); quality = opcuaQuality(dv.StatusCode);
          const st = parseTime(dv.SourceTimestamp); if (Number.isFinite(st)) at = st;
        } else value = unwrapVariant(raw);
        const pv = parseValue(value);
        if (pv === undefined) { out.push({ at, point, value: NaN, quality: 'bad', source: `opcua:${keys[0]}` }); continue; }
        out.push({ at, point, value: pv, quality, source: `opcua:${keys[0]}` });
      }
    }
  }
  return { observations: out.filter((x) => typeof x.value !== 'number' || Number.isFinite(x.value) || x.quality === 'bad'), unmapped: [...new Set(unmapped)] };
}

// ── Historian (CSV / JSON) ──

export interface LongMapping { format?: 'long'; at: string; tag: string; value: string; unit?: string; quality?: string; /** tag → point; tags not listed are unmapped. */ tags: Record<string, string>; /** Quality strings that mean bad (case-insensitive); default bad, error, invalid, comm failure. */ badQuality?: readonly string[]; where?: Record<string, string | readonly string[]> }
export interface WideMapping { format: 'wide'; at: string; /** column → point. */ columns: Record<string, string>; units?: Record<string, string> }
export type HistorianMapping = LongMapping | WideMapping;

const DEFAULT_BAD = ['bad', 'error', 'invalid', 'comm failure', 'commfailure', 'offline', 'nan'];

export function observationsFromRecords(rows: readonly unknown[], m: HistorianMapping, source = 'historian'): { observations: Observation[]; unmapped: string[]; skipped: number } {
  const out: Observation[] = []; const unmapped = new Set<string>(); let skipped = 0;
  rows.forEach((r, i) => {
    const at = parseTime(get(r, m.at));
    if (!Number.isFinite(at)) { skipped++; return; }
    if (m.format === 'wide') {
      for (const [col, point] of Object.entries(m.columns)) {
        const raw = get(r, col); if (raw === undefined || raw === '') continue;
        const v = parseValue(raw); if (v === undefined) { skipped++; continue; }
        out.push({ at, point, value: v, unit: m.units?.[col], source: `${source}:${i}` });
      }
      return;
    }
    for (const [k, want] of Object.entries(m.where ?? {})) { const v = String(get(r, k) ?? ''); if (Array.isArray(want) ? !want.includes(v) : v !== want) return; }
    const tag = String(get(r, m.tag) ?? '').trim(); if (!tag) { skipped++; return; }
    const point = m.tags[tag]; if (!point) { unmapped.add(tag); return; }
    const v = parseValue(get(r, m.value)); if (v === undefined) { skipped++; return; }
    const q = m.quality ? String(get(r, m.quality) ?? '').trim().toLowerCase() : '';
    const bad = (m.badQuality ?? DEFAULT_BAD).map((x) => x.toLowerCase());
    const quality: Quality = q && bad.includes(q) ? 'bad' : q === 'uncertain' ? 'uncertain' : 'good';
    const unit = m.unit ? String(get(r, m.unit) ?? '').trim() || undefined : undefined;
    out.push({ at, point, value: v, unit, quality, source: `${source}:${i}` });
  });
  return { observations: out, unmapped: [...unmapped].sort(), skipped };
}

/** CSV text → observations (parseCsv, then the mapping). */
export const observationsFromCsv = (text: string, m: HistorianMapping, source = 'historian') => observationsFromRecords(parseCsv(text), m, source);
