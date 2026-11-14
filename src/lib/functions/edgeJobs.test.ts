import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_JOBS_HOST, jobsHostFrom } from './edgeJobs';

const edgeNode = path.resolve(__dirname, '../../../packages/cappz-edge-node');
const source = (file: string) => readFileSync(path.join(edgeNode, file), 'utf8');

describe('jobs server address (15.42.0)', () => {
  it('defaults to loopback', () => {
    expect(DEFAULT_JOBS_HOST).toBe('127.0.0.1');
    expect(jobsHostFrom(undefined)).toBe('127.0.0.1');
    expect(jobsHostFrom(null)).toBe('127.0.0.1');
    expect(jobsHostFrom('')).toBe('127.0.0.1');
    expect(jobsHostFrom('   ')).toBe('127.0.0.1');
  });

  it('takes the address the operator names', () => {
    expect(jobsHostFrom('0.0.0.0')).toBe('0.0.0.0');
    expect(jobsHostFrom(' 192.168.50.14 ')).toBe('192.168.50.14');
    expect(jobsHostFrom('::1')).toBe('::1');
  });

  it('every entry point binds through CAPPZ_JOBS_HOST, and serveJobs falls back to loopback', () => {
    for (const entry of ['main.ts', 'timers.ts']) {
      expect(source(entry)).toContain("jobsHostFrom(Deno.env.get('CAPPZ_JOBS_HOST'))");
    }
    const jobs = source('jobs.ts');
    expect(jobs).toContain('hostname: opts.hostname ?? DEFAULT_JOBS_HOST');
    expect(jobs).not.toContain("'0.0.0.0'");
  });
});
