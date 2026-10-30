// @vitest-environment node
/** Names read from documents are scanned literally; no runtime-built regex anywhere in src. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { attrValue, callIndex } from '../lib/text/textScan';

describe('textScan', () => {
  it('reads attributes at a name boundary', () => {
    const tag = '<bpmn:timerEventDefinition id="t" xcappz:cron="no" cappz:cron="0 * * * *">';
    expect(attrValue(tag, 'cappz:cron')).toBe('0 * * * *');
    expect(attrValue(tag, 'id')).toBe('t');
    expect(attrValue(tag, 'name')).toBeUndefined();
  });

  it('finds calls and declarations literally', () => {
    const php = 'class A {\n  public function  index ($r) {}\n  function show() { helper_x(); }\n}';
    expect(callIndex(php, 'index', 'function')).toBe(php.indexOf('function  index'));
    expect(callIndex(php, 'show', 'function')).toBe(php.indexOf('function show'));
    expect(callIndex(php, 'helper_x')).toBe(php.indexOf('helper_x'));
    expect(callIndex(php, 'helper')).toBe(-1);
    expect(callIndex('x .*()', '.*')).toBe(2);
    expect(callIndex('aaaa', '.*')).toBe(-1);
  });

  it('src builds no RegExp from a non-literal', () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = join(dir, n);
        if (statSync(f).isDirectory()) { if (n !== 'test' && n !== '__tests__') walk(f); continue; }
        if (!/\.tsx?$/.test(n) || n.endsWith('.d.ts')) continue;
        const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') {
            const a = node.arguments?.[0];
            if (!a || !(ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isRegularExpressionLiteral(a))) {
              offenders.push(`${relative(root, f)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
