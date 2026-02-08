# UUID Manager

Client-side UUID/UID manager for Mindustry 154.3.

Current version: `v1.4.2`

## Features

- Edit `UUID` (8-byte Base64) directly under player name in Join Game.
- Live preview of `UID` (3-char shortID) and `UID(SHA1)`.
- Save multiple UUIDs with notes and quick switching.
- Per-server auto-switch by exact `ip:port`.
- Built-in UID database:
  - Run `Bruteforce all 3-char UIDs` from settings (supports rounds).
  - Import databases from clipboard, deduplicated by `uid3 + long id`.
  - Settings lookup lists all long IDs for the same 3-char UID with per-item copy buttons.
  - Query from settings or directly in Join Game after DB build.
- Built-in GitHub update checker: auto-detects new releases, shows release notes, and supports in-game package download.

## Changelog

### v1.4.2

- Further fix OOM risk in the post-bruteforce save phase by reducing shard write peak usage and capping per-UID saved values.
- Improve large DB compaction/cleanup to reduce crash risk from historical oversized data.

### v1.4.1

- Fix bruteforce progress dialog crash: use the correct native `Bar` class.
- Improve DB loading when manifest is missing: fallback to loading shard files and show DB path in meta text.

### v1.4.0

- Fix a possible freeze after bruteforce finishes when entering the save step (save runs in background and uses lower memory).
- Add a "rounds" input (<100) next to the bruteforce button to run multiple rounds and merge into local DB.
- Replace ASCII progress with native progress bar: centered text, percentage only.

### v1.3.2

- Switch local UID DB storage to 64MB shards with shard-by-shard loading.
- Make `uuidmanager.uiddb.json` human-readable with indentation and line breaks.
- Support importing databases larger than 64MB via shard manifest + shard files, always merged incrementally.

### v1.3.1

- Fix an issue where update prompt could fail to appear even when GitHub version is newer.
- Add a fallback prompt that always provides a direct download link if update dialog creation fails.

## Install

Import built artifacts into Mindustry mods folder:

- Recommended: `构建/uuidmanager-1.4.2.zip`
- Alternative: `构建/uuidmanager-1.4.2.jar`

## Build Locally

Run in `uuidManager_repo/`:

```bash
./gradlew distAll
```

Outputs:

- `build/libs/uuidmanager.zip`
- `build/libs/uuidmanager.jar`
- versioned copies in workspace root `构建/`.

## Notes

- This is a client-side tool; matching UUID does not automatically grant admin rights.
- Approval code is cached after first successful validation.
