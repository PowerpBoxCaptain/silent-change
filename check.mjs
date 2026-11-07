#!/usr/bin/env node
// silent-change — has a tracked file's CONTENT changed on disk without git noticing?
//
// `git status` trusts its index: when a file's size and timestamps still match what git recorded, git does not
// read the file again. If the bytes change underneath (a failing disk, a filesystem bug, a tool that restores
// timestamps, someone with their own reasons), git keeps calling the file clean. Most filesystems keep no checksum
// of file data, so nothing else on the machine will say so either.
//
// This reads every tracked file, hashes it the way git does, and compares with the hash git holds. A file whose
// content differs while git does not list it as modified is a SILENT CHANGE.
//
// It only reads. It never restores a file, never refreshes git's index, never stages, never takes git's lock.
//
// Usage:
//   node check.mjs [repo ...]        check these repositories (default: the current one)
//   node check.mjs --all <dir>       check every repository found under <dir> (4 levels deep, skips node_modules)
//   node check.mjs --json            print the result as JSON
//   node check.mjs --quiet           print one line when clean
//
// Exit codes: 0 no silent change · 1 at least one silent change · 2 none found, but something could not be checked
//             · 3 the check itself broke.
//
// License: AGPL-3.0-only.

import { readFileSync, lstatSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');
const allAt = argv.indexOf('--all');
const allDir = allAt >= 0 ? argv[allAt + 1] : null;
const named = argv.filter((a, i) => !a.startsWith('--') && !(allAt >= 0 && i === allAt + 1));

const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };   // never write git's index, never take its lock
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { env, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const gitHash = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const TEXT = /\.(c|h|cc|cpp|cs|css|go|html?|java|jsx?|tsx?|mjs|cjs|json|jsonl|md|php|py|rb|rs|sh|sql|toml|txt|ya?ml)$/i;
const isSha256Repo =(repo) => git(repo, ['rev-parse', '--show-object-format']).toString().trim() === 'sha256';

function findRepos(dir, depth = 0, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.name === '.git')) out.push(dir);
  if (depth >= 4) return out;
  for (const e of entries) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') findRepos(join(dir, e.name), depth + 1, out);
  return out;
}

// Paths git already reports as changed: those are not silent.
function changedPaths(repo) {
  const parts = git(repo, ['status', '--porcelain', '-uno', '-z']).toString('utf8').split('\0');
  const set = new Set();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]; if (!p) continue;
    set.add(p.slice(3));
    if (p[0] === 'R' || p[0] === 'C') i++;                  // a rename or copy carries its old path as the next field
  }
  return set;
}

// Paths git was told to stop looking at (assume-unchanged, skip-worktree): reported apart, not as silent.
function toldToIgnore(repo) {
  const set = new Set();
  for (const e of git(repo, ['ls-files', '-v', '-z']).toString('utf8').split('\0')) {
    if (e && (e[0] === 'S' || (e[0] >= 'a' && e[0] <= 'z'))) set.add(e.slice(2));
  }
  return set;
}

// Attributes that make git store something other than the bytes on disk.
function attrs(repo, path) {
  const out = git(repo, ['check-attr', '-z', 'filter', 'text', 'eol', '--', path]).toString('utf8').split('\0');
  const a = {}; for (let i = 0; i + 2 < out.length; i += 3) a[out[i + 1]] = out[i + 2];
  return a;
}

function check(repo) {
  if (isSha256Repo(repo)) throw new Error('sha256 object format is not supported yet');
  const changed = changedPaths(repo), ignored = toldToIgnore(repo);
  const autocrlf = (() => { try { return git(repo, ['config', 'core.autocrlf']).toString().trim(); } catch { return ''; } })();
  const result = { repo, read: 0, silent: [], ignoredButDiffer: [], notComparable: [] };
  for (const e of git(repo, ['ls-files', '-s', '-z']).toString('utf8').split('\0')) {
    if (!e) continue;
    const tab = e.indexOf('\t'); const [mode, sha] = e.slice(0, tab).split(' '); const path = e.slice(tab + 1);
    if (mode !== '100644' && mode !== '100755') continue;   // symlinks and submodules are not file contents
    let data;
    try { if (!lstatSync(join(repo, path)).isFile()) continue; data = readFileSync(join(repo, path)); } catch { continue; } // missing: git status says so
    result.read++;
    if (changed.has(path) || gitHash(data) === sha) continue;
    const a = attrs(repo, path);
    if (a.filter && a.filter !== 'unspecified' && a.filter !== 'unset') { result.notComparable.push({ path, why: `filter=${a.filter}` }); continue; }
    const mayConvert = (autocrlf && autocrlf !== 'false') || (a.text && a.text !== 'unspecified' && a.text !== 'unset') || (a.eol && a.eol !== 'unspecified');
    if (mayConvert && gitHash(Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === sha) continue;
    const entry = { path, bytes: data.length, binaryInTextFile: TEXT.test(path) && data.subarray(0, 8000).includes(0) };
    (ignored.has(path) ? result.ignoredButDiffer : result.silent).push(entry);
  }
  return result;
}

let repos;
try {
  repos = allDir ? findRepos(resolve(allDir)) : (named.length ? named : ['.']).map((r) => resolve(r));
  if (!repos.length) throw new Error(`no git repository found under ${allDir}`);
} catch (e) { console.error(`silent-change: broke: ${e.message}`); process.exit(3); }

const results = [], unchecked = [];
for (const repo of repos) {
  try { results.push(check(repo)); }
  catch (e) { unchecked.push({ repo, why: String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160) }); }
}

const silent = results.flatMap((r) => r.silent.map((f) => ({ repo: r.repo, ...f })));
const ignoredButDiffer = results.flatMap((r) => r.ignoredButDiffer.map((f) => ({ repo: r.repo, ...f })));
const notComparable = results.flatMap((r) => r.notComparable.map((f) => ({ repo: r.repo, ...f })));
const files = results.reduce((n, r) => n + r.read, 0);
const code = silent.length ? 1 : unchecked.length ? 2 : 0;

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ files, repositories: repos.length, checked: results.length, silent, ignoredButDiffer, notComparable, unchecked, exit: code }, null, 2) + '\n');
  process.exit(code);
}

const lines = [`silent-change: ${files} tracked files read in ${results.length} of ${repos.length} repositories.`];
if (silent.length) {
  lines.push(`SILENT CHANGE: ${silent.length} file(s) differ from git's copy although git calls them unmodified:`);
  for (const f of silent.slice(0, 50)) lines.push(`  ${join(f.repo, f.path)}  (${f.bytes} bytes${f.binaryInTextFile ? ', binary data in a text file' : ''})`);
  if (silent.length > 50) lines.push(`  ...and ${silent.length - 50} more (use --json for all)`);
  lines.push('Nothing was restored. Copy each file as found before you touch it; `git -C <repo> show HEAD:<path>` prints the good copy.');
} else if (!QUIET || unchecked.length || ignoredButDiffer.length) lines.push('No tracked file differs from git without git knowing.');
if (ignoredButDiffer.length) {
  lines.push(`Also differ, but git was told to ignore them (assume-unchanged or skip-worktree): ${ignoredButDiffer.length}`);
  ignoredButDiffer.slice(0, 10).forEach((f) => lines.push(`  ${join(f.repo, f.path)}`));
}
if (notComparable.length) lines.push(`Not compared (git stores them through a filter, e.g. LFS): ${notComparable.length} file(s).`);
if (unchecked.length) { lines.push('COULD NOT CHECK (this is not a pass):'); unchecked.forEach((u) => lines.push(`  ${u.repo}: ${u.why}`)); }
if (!QUIET) lines.push('Covers tracked files only. This check changes nothing.');
process.stdout.write(lines.join('\n') + '\n');
process.exit(code);
