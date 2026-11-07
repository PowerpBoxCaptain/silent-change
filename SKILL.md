---
name: silent-change
description: Check whether any git-tracked file's content changed on disk while `git status` still calls it clean (disk or filesystem corruption, tools that restore timestamps, tampering). Use when the user asks "is my tree really what git thinks?", after a crash, power loss, disk warning or restore from backup, before trusting a build or release from this machine, or when a file "looks wrong" but git shows no change. Read-only.
---

# silent-change

`git status` does not read your files. When a file's size and timestamps match what git recorded, git assumes
the content matches too. If the bytes change underneath, git keeps saying "clean", and most filesystems keep no
checksum of file data, so nothing else will say otherwise.

`check.mjs` reads every tracked file, hashes it exactly as git does, and compares that with the hash git holds.

## Run it

```sh
node <skill-dir>/check.mjs                 # the current repository
node <skill-dir>/check.mjs path/a path/b   # these repositories
node <skill-dir>/check.mjs --all ~/code    # every repository under a folder (4 levels, skips node_modules)
node <skill-dir>/check.mjs --json          # machine-readable
```

Exit codes: `0` no silent change · `1` at least one · `2` none found, but something could not be checked ·
`3` the check broke. Treat `2` as "not a pass".

## What to do with a finding

1. **Do not restore the file yet.** Copy it as found to a dated folder outside the repository.
2. Look at it: size, timestamp, what the bytes are (`xxd file | head`). Noise followed by zeros points at storage;
   readable but different text points at a tool or a person.
3. Tell the user what you found. The good copy is `git -C <repo> show HEAD:<path>`; restoring is their call.
4. If storage is the suspect, check the disk (`smartctl`, `dmesg`) before trusting anything else on it.

## What it does not do

- It never restores, stages, refreshes git's index or takes git's lock. It only reads.
- It covers **tracked** files only. Untracked and ignored files are not checked.
- A file git already lists as modified is not "silent" and is skipped.
- Files stored through a filter (Git LFS and similar) are counted as "not compared", not passed.
- Files marked assume-unchanged or skip-worktree that differ are listed apart: git was told to look away.
- Damage inside `.git` itself is `git fsck`'s job, not this check's.
- Repositories using the sha256 object format are reported as "could not check".
