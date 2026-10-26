/** Minimal line diff (LCS) for RepoZ Conflict Remediation. */
export type DiffLine = { op: 'same' | 'add' | 'del'; text: string };

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ op: 'same', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', text: x[i++] });
    else out.push({ op: 'add', text: y[j++] });
  }
  while (i < x.length) out.push({ op: 'del', text: x[i++] });
  while (j < y.length) out.push({ op: 'add', text: y[j++] });
  return out;
}
