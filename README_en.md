# UUID Manager

Client-side UUID/UID manager for Mindustry 154.3.

Current version: `v1.2.4`

## Features

- Edit `UUID` (8-byte Base64) directly under player name in Join Game.
- Live preview of `UID` (3-char shortID) and `UID(SHA1)`.
- Save multiple UUIDs with notes and quick switching.
- Per-server auto-switch by exact `ip:port`.
- Built-in UID database:
  - Run `Bruteforce all 3-char UIDs (8s)` from settings.
  - Import databases from clipboard, deduplicated by `uid3 + long id`.
  - Settings lookup lists all long IDs for the same 3-char UID with per-item copy buttons.
  - Query from settings or directly in Join Game after DB build.
- Built-in GitHub update checker: auto-detects new releases, shows release notes, and supports in-game package download.

## Install

Import built artifacts into Mindustry mods folder:

- Recommended: `构建/uuidmanager-1.2.4.zip`
- Alternative: `构建/uuidmanager-1.2.4.jar`

## Build Locally

Run in `uuidManager/`:

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
