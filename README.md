# silent-change

**`git status` said clean. The file was noise.**

Git does not re-read a file whose size and timestamps still match its index. If the bytes change underneath,
through a failing disk, a filesystem bug, a backup restore or a tool that resets timestamps, git keeps calling the
file clean. Most filesystems keep no checksum of file data, so nothing else on the machine will notice either.

`silent-change` reads every tracked file, hashes it the way git does, and tells you which ones differ from git's
copy while git calls them unmodified. One file, no dependencies, read-only.

```
$ node check.mjs
silent-change: 2 tracked files read in 1 of 1 repositories.
SILENT CHANGE: 1 file(s) differ from git's copy although git calls them unmodified:
  /home/me/app/src/config.ts  (24 bytes, binary data in a text file)
Nothing was restored. Copy each file as found before you touch it; `git -C <repo> show HEAD:<path>` prints the good copy.
```

## Install

As a Claude Code skill:

```sh
git clone https://github.com/<org>/silent-change ~/.claude/skills/silent-change
```

Or just run it (Node 18+ and git):

```sh
node check.mjs [repo ...] | --all <dir> [--json] [--quiet]
```

Check at the start of every Claude Code session (add to `~/.claude/settings.json`):

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "node ~/.claude/skills/silent-change/check.mjs --quiet" } ] } ] } }
```

Or daily from cron, mailing you only when it finds something:

```cron
0 7 * * * node ~/silent-change/check.mjs --all ~/code --quiet || mail -s "silent-change" you@example.com < /dev/null
```

## Exit codes

`0` no silent change · `1` at least one · `2` none found, but something could not be checked (not a pass) ·
`3` the check broke.

## What it does not cover

Untracked and ignored files; damage inside `.git` (use `git fsck`); files stored through a filter such as Git LFS
(reported as "not compared"); sha256-format repositories (reported as "could not check"). Files marked
assume-unchanged or skip-worktree that differ are listed separately, not as silent changes.

## How it was tested

A repository where a tracked file was overwritten in place with the same size and its timestamp restored:
`git status` printed nothing, `silent-change` reported the file and exited `1`, and git's index was byte-for-byte
unchanged afterwards. Also checked: a normal edit (skipped, git already sees it), assume-unchanged, `core.autocrlf`
with CRLF files (no false alarm), a path that is not a repository (exit `2`), and a sweep of about 81,000 tracked
files in 48 repositories in under a minute.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
