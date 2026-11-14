/** Writes the generated references: the command table for the skill (docs.ts) and skills/index.json (skillsIndex.ts). */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandsMarkdown } from './docs';
import { skillsIndex } from './skillsIndex';

const target = fileURLToPath(new URL('../../skills/using-cappz-marketplace/reference/commands.md', import.meta.url));
writeFileSync(target, commandsMarkdown());
console.log(`wrote ${target}`);
const skills = fileURLToPath(new URL('../../skills/', import.meta.url));
writeFileSync(`${skills}index.json`, JSON.stringify(skillsIndex(skills), null, 2) + '\n');
console.log(`wrote ${skills}index.json`);
