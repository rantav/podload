# Podload

![Podload logo](public/logo.svg)

Podload is a macOS desktop app for discovering and downloading podcast episodes. Add a podcast homepage or RSS URL, browse episodes, batch download or skip, and keep your library state synced between machines.

## Features

- Discover RSS/Atom feeds from podcast homepages.
- Manage multiple podcasts and remember progress.
- Batch-select episodes for download or skip.
- Play downloaded audio locally.
- Export/import a minimal state file (IDs + status) for easy migration.
- Load older episodes with feed paging.

## How it works

Podload uses Tauri + React. Feeds are parsed from RSS/Atom XML, episodes are listed in a modern library UI, and downloads are saved to a user-selected folder on disk. The app persists a compact state so large feeds won’t bloat local storage.

## Development

Install dependencies:
```\n+pnpm install\n+```

Run the desktop app:
```\n+pnpm run tauri dev\n+```

Run checks:
```\n+make check\n+```

## Export / Import state

Use **Import state** or **Export state** in the sidebar to move the library between computers. The exported JSON only contains podcast IDs, feed URLs, and episode statuses; titles and descriptions are rehydrated on import.

## Build & install (macOS)

```\n+make install-mac\n+```
