/**
 * COPE node crystallized.
 * Node ID: v15-04-00-edge-node-objects
 * Provenance: m/44'/144'/100'/principles/cope/v1#local-first
 *
 * The node's content-addressed body store: <CAPPZ_NODE_DATA>/objects/<sha256>.
 * Files dropped into <CAPPZ_NODE_DATA>/inbox/ are hashed and moved in (every
 * 30 s), so an operator or a local process can hand the node bodies to
 * replicate. Bodies arrive from peers only after their hash is checked
 * (src/lib/sync/edgeBodyPull.ts).
 *
 * v15-10-00: a file above 6 MB is stored as chunks + manifest
 * (src/lib/sync/chunkedBodies.ts) so it replicates; <data>/large-index.json
 * maps its whole-file sha256 to the manifest id, so it is still found by hash.
 */

import { MAX_BODY_BYTES, sha256Hex, type BodyStore } from '../../src/lib/sync/edgeBodyPull.ts';
import { putBody, readBody } from '../../src/lib/sync/chunkedBodies.ts';

const ID = /^[0-9a-f]{64}$/;

export interface NodeBodyStore extends BodyStore {
  ingestInbox(): Promise<number>;
  /** Store a whole file (chunked when large); returns its sha256. */
  putWhole(bytes: Uint8Array, name?: string): Promise<string>;
  /** A whole file by its sha256, reassembled and verified when chunked. */
  getWhole(sha256: string): Promise<Uint8Array | null>;
}

export async function fileBodyStore(dataDir: string): Promise<NodeBodyStore> {
  const dir = `${dataDir}/objects`;
  const inbox = `${dataDir}/inbox`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.mkdir(inbox, { recursive: true });
  const indexPath = `${dataDir}/large-index.json`;
  const readIndex = async (): Promise<Record<string, string>> => { try { return JSON.parse(await Deno.readTextFile(indexPath)); } catch { return {}; } };
  const exists = async (p: string) => { try { await Deno.stat(p); return true; } catch { return false; } };
  const store: NodeBodyStore = {
    async list() {
      const out: Array<{ id: string; at: number }> = [];
      for await (const e of Deno.readDir(dir)) if (e.isFile && ID.test(e.name)) out.push({ id: e.name, at: (await Deno.stat(`${dir}/${e.name}`)).mtime?.getTime() ?? 0 });
      return out.sort((a, b) => b.at - a.at).map((x) => x.id);
    },
    has: (id: string) => (ID.test(id) ? exists(`${dir}/${id}`) : Promise.resolve(false)),
    async get(id: string) { if (!ID.test(id)) return null; try { return await Deno.readFile(`${dir}/${id}`); } catch { return null; } },
    async put(id: string, bytes: Uint8Array) {
      if (!ID.test(id) || (await sha256Hex(bytes)) !== id) throw new Error('body does not match its id');
      const tmp = `${dir}/.${id}.tmp`;
      await Deno.writeFile(tmp, bytes);
      await Deno.rename(tmp, `${dir}/${id}`); // atomic: a reader never sees half a body
    },
    async putWhole(bytes: Uint8Array, name?: string) {
      if (bytes.length <= MAX_BODY_BYTES) { const id = await sha256Hex(bytes); await store.put(id, bytes); return id; }
      const r = await putBody(store, bytes, { name });
      const index = await readIndex();
      index[r.sha256] = r.id;
      await Deno.writeTextFile(indexPath, JSON.stringify(index));
      return r.sha256;
    },
    async getWhole(sha256: string) {
      const direct = await store.get(sha256);
      if (direct) return direct;
      const manifestId = (await readIndex())[sha256];
      if (!manifestId) return null;
      const r = await readBody(store, manifestId);
      return r.state === 'complete' ? r.bytes : null;
    },
    /** Hash and move every file in the inbox into the store. */
    async ingestInbox() {
      let n = 0;
      for await (const e of Deno.readDir(inbox)) {
        if (!e.isFile) continue;
        const bytes = await Deno.readFile(`${inbox}/${e.name}`);
        await store.putWhole(bytes, e.name);
        await Deno.remove(`${inbox}/${e.name}`);
        n++;
      }
      return n;
    },
  };
  return store;
}
