/**
 * Plain-text scans for names read from documents (attributes, function calls).
 *
 * A name taken from a document never becomes a regex: a pattern built from
 * input can backtrack without bound, and regex-engine bugs (CVE-2026-97229,
 * Onigmo) turn crafted patterns into code execution. These scans are linear
 * and treat every character of the name literally.
 */

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isWord = (ch: string | undefined) => ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_');

/** Value of a double-quoted attribute in one opening tag (`name` preceded by whitespace). */
export function attrValue(tag: string, name: string): string | undefined {
  const key = `${name}="`;
  for (let at = tag.indexOf(key); at >= 0; at = tag.indexOf(key, at + 1)) {
    if (!isSpace(tag[at - 1])) continue;
    const end = tag.indexOf('"', at + key.length);
    return end < 0 ? undefined : tag.slice(at + key.length, end);
  }
  return undefined;
}

/** Index of `name` used as a call (`name (`), at a word boundary; -1 when absent. With `keyword`, only `keyword <ws> name (`. */
export function callIndex(text: string, name: string, keyword?: string): number {
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    if (isWord(text[at - 1])) continue;
    let after = at + name.length;
    while (isSpace(text[after])) after++;
    if (text[after] !== '(') continue;
    if (!keyword) return at;
    let before = at;
    if (!isSpace(text[before - 1])) continue;
    while (isSpace(text[before - 1])) before--;
    const start = before - keyword.length;
    if (start >= 0 && text.slice(start, before) === keyword && !isWord(text[start - 1])) return start;
  }
  return -1;
}
