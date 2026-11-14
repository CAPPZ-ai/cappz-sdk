/**
 * Builds skills/index.json: one machine-readable entry per agent skill, so an
 * agent can find the right skill by searching one file (or `cappz-market
 * skills <words>`) instead of opening every folder. Everything is read from
 * the skills themselves — the frontmatter, the commands, tools and guides each
 * SKILL.md mentions — so the index cannot describe a skill that differs.
 *   npx vite-node packages/cappz-market/write-docs.ts
 * src/test/cappz-market-tool.test.ts fails when the file is stale.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from './commands';
import type { SkillIndex, SkillIndexEntry } from './skillsSearch';

export type { SkillIndex, SkillIndexEntry };

export const SKILLS_REPO = 'https://github.com/CAPPZ-ai/cappz-sdk';
const RAW = 'https://raw.githubusercontent.com/CAPPZ-ai/cappz-sdk/main';

function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---\n')) return out;
  const end = text.indexOf('\n---', 4);
  for (const line of text.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

export function skillsIndex(skillsDir: string): SkillIndex {
  const names = new Set(COMMANDS.map((c) => c.name));
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')))
    .map((d) => d.name).sort()
    .map((dir): SkillIndexEntry => {
      const text = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8');
      const fm = frontmatter(text);
      const words = text.split(/[\s`(),]+/);
      const commands = uniq(words.flatMap((w, i) => (w === 'cappz-market' && names.has(words[i + 1]) ? [words[i + 1]] : [])));
      const tools = uniq(words.filter((w) => /^[a-z][a-z0-9-]*\.ts$/.test(w.split('/').pop() ?? '') && w.includes('tools/')).map((w) => w.split('/').pop()!.replace(/\.ts$/, ''))
        .concat(words.filter((w) => w === 'saml-wizard' || w === 'constraint-wizard' || w === 'constraint-reconcile')));
      const guides = uniq((text.match(/docs\/[A-Z0-9_]+\.md/g) ?? []).map((g) => g));
      return { name: fm.name ?? dir, description: fm.description ?? '', path: `skills/${dir}`, url: `${SKILLS_REPO}/tree/main/skills/${dir}`, raw: `${RAW}/skills/${dir}/SKILL.md`, commands, tools, guides };
    });
  return {
    about: 'Agent skills for CAPPZ: each entry says when to use it (description) and links its SKILL.md. Search: cappz-market skills <words>.',
    repo: SKILLS_REPO,
    install: 'Claude Code: copy the skill folder into ~/.claude/skills/ or .claude/skills/. Claude API / Claude.ai: upload the folder. Other harnesses: list each description and let the agent read the folder.',
    skills,
  };
}
