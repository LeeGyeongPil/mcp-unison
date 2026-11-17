/** A small line-based unified diff for the CLI preview. */

type Op = { t: " " | "-" | "+"; line: string };

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // Longest common subsequence table; config files are tiny so O(n*m) is fine.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: "-", line: a[i++] });
    } else {
      ops.push({ t: "+", line: b[j++] });
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

export function unifiedDiff(
  before: string,
  after: string,
  labelBefore: string,
  labelAfter: string,
  context = 3,
): string {
  if (before === after) return "";
  const ops = diffOps(splitLines(before), splitLines(after));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true;
  });

  const out: string[] = [`--- ${labelBefore}`, `+++ ${labelAfter}`];
  let idx = 0;
  let aLine = 1;
  let bLine = 1;
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].t !== "+") aLine++;
      if (ops[idx].t !== "-") bLine++;
      idx++;
      continue;
    }
    const startA = aLine;
    const startB = bLine;
    const body: string[] = [];
    let countA = 0;
    let countB = 0;
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx];
      body.push(`${op.t}${op.line}`);
      if (op.t !== "+") {
        countA++;
        aLine++;
      }
      if (op.t !== "-") {
        countB++;
        bLine++;
      }
      idx++;
    }
    out.push(`@@ -${countA === 0 ? startA - 1 : startA},${countA} +${countB === 0 ? startB - 1 : startB},${countB} @@`);
    out.push(...body);
  }
  return out.join("\n") + "\n";
}
