/** The skills index's shape and search (bundled into the tool; no file access). Built by skillsIndex.ts. */

export interface SkillIndexEntry {
  name: string;
  description: string;
  /** Folder in the SDK repo. */
  path: string;
  /** Browse on GitHub. */
  url: string;
  /** SKILL.md as plain text, for agents that fetch it directly. */
  raw: string;
  /** cappz-market commands the skill uses. */
  commands: string[];
  /** Other tools in the SDK the skill runs (wizards, CLIs). */
  tools: string[];
  /** Guides in docs/ the skill links. */
  guides: string[];
}

export interface SkillIndex {
  about: string;
  repo: string;
  install: string;
  skills: SkillIndexEntry[];
}

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'this', 'to', 'up', 'was', 'we', 'were', 'what', 'with', 'you', 'your']);
const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
/** "hack" finds "hacked", "setpoints" finds "setpoint": same word when one starts the other and the shorter has 4+ letters. */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Rank skills for a free-text need: each query word found in the name counts 3, in the description, commands or tools 1. */
export function searchSkills(index: SkillIndex, query: string): SkillIndexEntry[] {
  const terms = words(query);
  if (!terms.length) return index.skills;
  return index.skills.map((s) => {
    const name = words(s.name); const body = words(`${s.description} ${s.commands.join(' ')} ${s.tools.join(' ')}`);
    const score = terms.reduce((n, t) => n + (name.some((w) => sameWord(w, t)) ? 3 : 0) + (body.some((w) => sameWord(w, t)) ? 1 : 0), 0);
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).map((x) => x.s);
}
