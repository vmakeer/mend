// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models write, in four
// formats, to a tree of files. It reads a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A
// patch or JSON tool calls, finds the lines each edit names at the first of three matching tiers (exact, trailing
// whitespace ignored, both ends ignored), and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in the order their edits ran: [old path, new path]. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split into its line break, its lines and whether it ends with a line break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
}

/** One line of a hunk or chunk body: context (in both old and new), old (removed) or new (added). */
type Op = { type: 'context' | 'old' | 'new'; text: string };

/** A line compared at a matching tier (SPEC.md section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/**
 * The occurrences of O in the file's lines, at the first tier where one occurs at or after `from`
 * (and, for an end-of-file chunk, ending at the file's last line). With --strict only tier 0 is tried.
 */
function findOccurrence(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const oKeys = o.map((s) => tierKey(s, t));
    const lKeys = lines.map((s) => tierKey(s, t));
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (lKeys[i + j] !== oKeys[j]) {
          ok = false;
          break;
        }
      }
      if (ok && (!eofOnly || i + o.length === lines.length)) positions.push(i);
    }
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/**
 * The lines that replace O's match at `pos`: a context line is written as the file's own matched line, never the
 * patch's; at tier 2 every other line that starts with O's first line's indent has that indent replaced by the
 * file's first matched line's indent.
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(fileLines[pos] ?? '');
    const firstO = ops.find((o) => o.type === 'context' || o.type === 'old');
    p = firstO === undefined ? '' : leadingWs(firstO.text);
  }
  let oIdx = 0;
  for (const op of ops) {
    if (op.type === 'context') {
      out.push(fileLines[pos + oIdx]);
      oIdx++;
    } else if (op.type === 'old') {
      oIdx++;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  /** A, the old start line of the hunk header (1-based; B and D are not used). */
  a: number;
  ops: Op[];
  /** Whether a `\` line follows the hunk's last `+` line (a created file's final break). */
  backslashAfterLastNew: boolean;
  /** Whether a `\` line follows the hunk's last context or `+` line (a changed file's final break). */
  backslashAfterLastCtxNew: boolean;
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  /** The `---`/`+++` pair's paths (null: /dev/null); undefined when the section has no pair. */
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  sawHunk: boolean;
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters, to the first tab, trimmed. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's body: the lines after its header that belong to it (empty lines at the end are not part of it). */
function collectUnifiedBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

/** A hunk body's lines as operations, plus whether a `\` line follows its last `+` / context-or-`+` line. */
function parseBodyLines(body: string[]): {
  ops: Op[];
  backslashAfterLastNew: boolean;
  backslashAfterLastCtxNew: boolean;
} {
  const ops: Op[] = [];
  let lastNewIdx = -1;
  let lastCtxNewIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.startsWith('+')) {
      ops.push({ type: 'new', text: l.slice(1) });
      lastNewIdx = i;
      lastCtxNewIdx = i;
    } else if (l.startsWith(' ')) {
      ops.push({ type: 'context', text: l.slice(1) });
      lastCtxNewIdx = i;
    } else if (l.startsWith('-')) {
      ops.push({ type: 'old', text: l.slice(1) });
    } else if (l === '') {
      ops.push({ type: 'context', text: '' });
      lastCtxNewIdx = i;
    }
    // A `\` line is not an operation; it refers to the body line before it.
  }
  const backslashAfter = (idx: number): boolean =>
    idx >= 0 && body[idx + 1] !== undefined && body[idx + 1].startsWith('\\');
  return { ops, backslashAfterLastNew: backslashAfter(lastNewIdx), backslashAfterLastCtxNew: backslashAfter(lastCtxNewIdx) };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1], gitNew: m[2], newFile: false, deletedFile: false, hunks: [], sawHunk: false };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.sawHunk) {
        // Already part of this section's header: it names the paths.
        cur.pairOld = diffPath(l);
        cur.pairNew = diffPath(lines[i + 1]);
      } else {
        cur = {
          pairOld: diffPath(l),
          pairNew: diffPath(lines[i + 1]),
          newFile: false,
          deletedFile: false,
          hunks: [],
          sawHunk: false,
        };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && !cur.sawHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = collectUnifiedBody(lines, i + 1);
      const parsed = parseBodyLines(body);
      cur.hunks.push({
        a: Number(m[1]),
        ops: parsed.ops,
        backslashAfterLastNew: parsed.backslashAfterLastNew,
        backslashAfterLastCtxNew: parsed.backslashAfterLastCtxNew,
      });
      cur.sawHunk = true;
      i = next;
      continue;
    }
    if (cur !== null && !cur.sawHunk) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line
      // in a header are ignored.
    }
    i++;
  }
  return sections;
}

/** A section's old and new path: the `---`/`+++` pair, else rename from/to, else the `diff --git` paths. */
function sectionPaths(sec: USection): { old: string | null; nw: string | null } {
  const old =
    sec.pairOld !== undefined
      ? sec.pairOld
      : sec.renameFrom !== undefined
        ? sec.renameFrom
        : sec.gitOld !== undefined
          ? sec.gitOld
          : null;
  const nw =
    sec.pairNew !== undefined
      ? sec.pairNew
      : sec.renameTo !== undefined
        ? sec.renameTo
        : sec.gitNew !== undefined
          ? sec.gitNew
          : null;
  return { old, nw };
}

/** A section's hunks applied in order to a file's text, each to the result of the ones before it. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { br, lines, final } = splitFile(before);
  let cur = lines;
  let curFinal = final;
  let d = 0;
  for (const hunk of hunks) {
    const O = hunk.ops.filter((o) => o.type !== 'new').map((o) => o.text);
    const nLen = hunk.ops.filter((o) => o.type !== 'old').length;
    if (O.length === 0) {
      const p = Math.min(Math.max(hunk.a + d, 0), cur.length);
      const atEnd = p === cur.length;
      const ins = hunk.ops.filter((o) => o.type === 'new').map((o) => o.text);
      cur = [...cur.slice(0, p), ...ins, ...cur.slice(p)];
      if (atEnd) curFinal = !hunk.backslashAfterLastCtxNew;
      d += nLen;
    } else {
      const found = findOccurrence(cur, O, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + O.length === cur.length;
      const replacement = buildReplacement(hunk.ops, cur, best, found.tier);
      cur = [...cur.slice(0, best), ...replacement, ...cur.slice(best + O.length)];
      if (atEnd) curFinal = !hunk.backslashAfterLastCtxNew;
      d += nLen - O.length;
    }
  }
  return joinFile(cur, br, curFinal);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const { old, nw } = sectionPaths(sec);
    if (old === null || sec.newFile) {
      // A creation: the file is the `+` lines of all its hunks, in order.
      if (nw === null) return () => {};
      const hunks = sec.hunks;
      return (tree: Tree) => {
        if (!safe(nw)) throw new Fail('unsafe', nw);
        if (tree.get(nw) !== null) throw new Fail('exists', nw);
        const out: string[] = [];
        let lastNewBackslash = false;
        for (const hunk of hunks) {
          let hasNew = false;
          for (const op of hunk.ops) {
            if (op.type === 'new') {
              out.push(op.text);
              hasNew = true;
            }
          }
          if (hasNew) lastNewBackslash = hunk.backslashAfterLastNew;
        }
        tree.now.set(nw, out.length === 0 ? '' : out.join('\n') + (lastNewBackslash ? '' : '\n'));
      };
    }
    if (nw === null || sec.deletedFile) {
      // A deletion: its hunks are not read.
      return (tree: Tree) => {
        if (!safe(old)) throw new Fail('unsafe', old);
        if (tree.get(old) === null) throw new Fail('missing', old);
        tree.now.set(old, null);
      };
    }
    if (old !== nw) {
      // A move: the hunks apply to the old file's lines; the result is written at the new path.
      const hunks = sec.hunks;
      return (tree: Tree) => {
        if (!safe(old)) throw new Fail('unsafe', old);
        if (!safe(nw)) throw new Fail('unsafe', nw);
        const before = tree.get(old);
        if (before === null) throw new Fail('missing', old);
        if (tree.get(nw) !== null) throw new Fail('exists', nw);
        const after = applyHunks(before, hunks, strict, old);
        tree.now.set(old, null);
        tree.now.set(nw, after);
        tree.moves.push([old, nw]);
      };
    }
    // A change of the one path.
    const hunks = sec.hunks;
    return (tree: Tree) => {
      if (!safe(old)) throw new Fail('unsafe', old);
      const before = tree.get(old);
      if (before === null) throw new Fail('missing', old);
      tree.now.set(old, applyHunks(before, hunks, strict, old));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { br, lines, final } = splitFile(before);
    const found = findOccurrence(lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0];
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ type: 'old', text: t })),
      ...newLines.map((t): Op => ({ type: 'new', text: t })),
    ];
    const replacement = buildReplacement(ops, lines, pos, found.tier);
    const out = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevReplace; j--) {
        const l = lines[j];
        if (blank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let sep = -1;
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (sep === -1 && lines[j].trimEnd() === '=======') sep = j;
        else if (sep !== -1 && lines[j].trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (sep === -1 || end === -1) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
      prevPath = path;
      prevReplace = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  /** The chunk's anchor, or null when the `@@` line carries no text. */
  anchor: string | null;
  ops: Op[];
  /** Whether a `*** End of File` line closed this chunk. */
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(
  path: string,
  sec: Array<{ text: string; no: number }>,
  headerLine: number,
  strict: boolean,
): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (sec.length > 0 && sec[0].text.startsWith('*** Move to: ')) {
    moveTo = sec[0].text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let sawChunk = false;
  for (; idx < sec.length; idx++) {
    const s = sec[idx];
    const l = s.text;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${s.no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      sawChunk = true;
    } else if (l.startsWith('@@')) {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
      sawChunk = true;
    } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (sawChunk) throw new Exit2(`error: parse ${s.no}`);
        cur = { anchor: null, ops: [], eof: false };
        sawChunk = true;
      }
      if (l.startsWith(' ')) cur.ops.push({ type: 'context', text: l.slice(1) });
      else if (l.startsWith('-')) cur.ops.push({ type: 'old', text: l.slice(1) });
      else if (l.startsWith('+')) cur.ops.push({ type: 'new', text: l.slice(1) });
      else cur.ops.push({ type: 'context', text: '' });
    } else {
      throw new Exit2(`error: parse ${s.no}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { br, lines, final } = splitFile(before);
    let curLines = lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const a = findOccurrence(curLines, [chunk.anchor], strict, cursor, false);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.positions[0] + 1;
      }
      const O = chunk.ops.filter((o) => o.type !== 'new').map((o) => o.text);
      if (O.length === 0) {
        const p = chunk.eof ? curLines.length : Math.min(cursor, curLines.length);
        const replacement = buildReplacement(chunk.ops, curLines, p, 0);
        curLines = [...curLines.slice(0, p), ...replacement, ...curLines.slice(p)];
        cursor = p + replacement.length;
      } else {
        const found = findOccurrence(curLines, O, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0];
        const replacement = buildReplacement(chunk.ops, curLines, pos, found.tier);
        curLines = [...curLines.slice(0, pos), ...replacement, ...curLines.slice(pos + O.length)];
        cursor = pos + replacement.length;
      }
    }
    const after = joinFile(curLines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, after);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    } else throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(prefix.length).trim();
    const headerLine = i + 1;
    const sec: Array<{ text: string; no: number }> = [];
    i++;
    while (i < last) {
      const m = lines[i];
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      sec.push({ text: m, no: i + 1 });
      i++;
    }
    while (sec.length > 0 && blank(sec[sec.length - 1].text)) sec.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of sec) {
        if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else if (s.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${s.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (sec.length > 0) throw new Exit2(`error: parse ${sec[0].no}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, sec, headerLine, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.has(oldP) ? tree.now.get(oldP)! : oldWas;
    const newWas = tree.original(newP);
    const newNow = tree.now.has(newP) ? tree.now.get(newP)! : newWas;
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  const changed = [...tree.now.keys()].sort(byteOrder);
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
