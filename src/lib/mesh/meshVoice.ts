/**
 * COPE node crystallized.
 * Node ID: v15-13-00-mesh-voice
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 * governingPrinciple: m/44'/144'/100'/principles/cope/v1
 *
 * Voice messages in a browser (or the native shells' WebView): MediaRecorder
 * at a low bit rate, so a 30-second message is ~45 kB — a few bundles over
 * Wi-Fi, far too much for LoRa. Opus where the browser has it (Chrome,
 * Android, Firefox), AAC in Safari. Nothing leaves the device unless sent;
 * the clip is sealed like any direct message.
 *
 * (The CAPPZ wallet-agent's microphone path streams raw PCM to a hosted
 * realtime service; that cannot work offline and is ~30× larger, so the mesh
 * records compressed clips on the device instead.)
 */

import { MAX_VOICE_MS } from './meshChat.ts';

export const VOICE_BITS_PER_SECOND = 12_000;

export function voiceMimeType(): string | null {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder;
  if (!MR) return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']) if (MR.isTypeSupported(t)) return t;
  return '';
}

export interface Recording { stop(): Promise<{ audio: Uint8Array; mime: string; ms: number }>; cancel(): void }

/** Start recording from the microphone; stops by itself at `maxMs`. */
export async function recordVoice(o: { maxMs?: number } = {}): Promise<Recording> {
  const mime = voiceMimeType();
  if (mime === null) throw new Error('this browser cannot record audio');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: VOICE_BITS_PER_SECOND });
  const chunks: Blob[] = [];
  const started = Date.now();
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<{ audio: Uint8Array; mime: string; ms: number }>((resolve) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      resolve({ audio: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, ms: Date.now() - started });
    };
  });
  rec.start(1000);
  const limit = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, Math.min(o.maxMs ?? 30_000, MAX_VOICE_MS));
  return {
    stop: () => { clearTimeout(limit); if (rec.state !== 'inactive') rec.stop(); return done; },
    cancel: () => { clearTimeout(limit); rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); stream.getTracks().forEach((t) => t.stop()); },
  };
}
