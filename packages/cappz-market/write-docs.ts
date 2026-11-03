/** Writes the generated command reference for the skill (see docs.ts). */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandsMarkdown } from './docs';

const target = fileURLToPath(new URL('../../skills/using-cappz-marketplace/reference/commands.md', import.meta.url));
writeFileSync(target, commandsMarkdown());
console.log(`wrote ${target}`);
