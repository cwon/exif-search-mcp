# exif_mcp (Node MCP Server)

A Model Context Protocol (MCP) server that filters photos by EXIF and copies matched files into a dated, prompt-named folder.

This repository ships a Node.js/TypeScript implementation in `node/` and uses vendored ExifTool binaries via `exiftool-vendored` for robust, fast metadata extraction without requiring users to install ExifTool separately.

## Support

If this project helps you, please consider supporting: [Buy Me a Coffee](https://buymeacoffee.com/yowl)

## Features

- Filter by: date range, time window, ISO, artist/creator, camera make/model, GPS bounding box or center+radius, altitude range
- Output directory named by local date and prompt slug: `YYYY-MM-DD_<prompt>`
- Copy matched files
- Uses vendored ExifTool for cross‑platform support

## Requirements

- Node.js 20.17+ or 22.9+ (recommended: Node 22 LTS)
- macOS, Linux, or Windows

## Project layout

- `node/` — TypeScript MCP server implementation
  - `src/cli.ts` — MCP stdio server entrypoint
  - `dist/cli.js` — compiled output

## Install

From the repo root:

```bash
cd node
npm install
npm run build
```

This will also install `exiftool-vendored`, which provides platform-appropriate ExifTool binaries automatically.

## Run locally

- Using tsx (dev):

```bash
cd node
npm run dev -- --base-dir "/path/to/photos"
```

- Using the compiled JS:

```bash
cd node
node dist/cli.js --base-dir "/path/to/photos"
```

- Using npm start (compiled):

```bash
cd node
npm start -- --base-dir "/path/to/photos"
```

Notes:

- If not provided, `base_dir` defaults to `~/Pictures`. You can override with `PHOTO_MCP_BASE_DIR` or pass `--base-dir`.
- Output root defaults to Desktop if not provided; otherwise, it falls back to `base_dir`.

## Tool: filter_and_copy

Input schema (JSON keys in snake_case):

- `original_prompt` (string, required)
- `base_dir` (string, optional; defaults to `~/Pictures` or `PHOTO_MCP_BASE_DIR` if set)
- `output_root` (string, optional; default Desktop or `base_dir`)
- `copy_mode` ("copy") optional; copy only
- `date_range` { `from`: string, `to`: string } with `YYYY-MM-DD`
- `time_of_day` { `from`: string, `to`: string } with `HH:MM`
- `iso` { `min`: number, `max`: number }
- `artist` (string)
- `camera` { `make`: string, `model`: string }
- `location` object (optional):
  - `bbox`: [minLon, minLat, maxLon, maxLat]
  - `center`: { `lat`: number, `lon`: number }
  - `radius_m`: number
- `altitude` { `min`: number, `max`: number } — meters, negative means below sea level

Response:

- `scanned`, `matched`, `skipped_missing_meta`, `output_dir`, `files[]`

### Examples (no Google Maps API needed)

- Center + radius (meters):

```json
{
  "original_prompt": "Namsan radius 500m",
  "base_dir": "/path/to/photos",
  "copy_mode": "copy",
  "location": {
    "center": { "lat": 37.5512, "lon": 126.9882 },
    "radius_m": 500
  }
}
```

- Bounding box:

```json
{
  "original_prompt": "Seoul bbox",
  "base_dir": "/path/to/photos",
  "copy_mode": "copy",
  "location": {
    "bbox": [126.76, 37.4, 127.18, 37.7]
  }
}
```

## Date and time handling

- The output folder date uses the LOCAL timezone (`YYYY-MM-DD`).
- EXIF `DateTimeOriginal` is parsed from local components directly (no implicit UTC conversion) to avoid timezone shifts.

## ExifTool integration

- The server uses `exiftool-vendored` to resolve the ExifTool binary automatically.
- Resolution order used by the server when invoking ExifTool:
  1. `EXIFTOOL_PATH` environment variable, if set
  2. vendored binary path resolved via `exiftool.exiftoolPath()`
  3. `exiftool` found on `PATH`

You shouldn’t need to install ExifTool separately. If you want a custom build, set `EXIFTOOL_PATH` to your binary.

## Environment variables

- `PHOTO_MCP_BASE_DIR` — default photos base directory if `base_dir` is not provided
- `EXIFTOOL_PATH` — full path to a custom ExifTool binary (overrides vendored)

## Configure with MCP clients (Claude Desktop)

Claude Desktop starts MCP servers as external processes via JSON configuration. Update paths to match your system.

### macOS/Linux

- Node MCP server (this project):

```json
{
  "mcpServers": {
    "photo-mcp-node": {
      "command": "/usr/bin/env",
      "args": [
        "node",
        "/Users/you/go_proj/exif_mcp/node/dist/cli.js",
        "--base-dir",
        "/Volumes/Untitled/DCIM/100_FUJI"
      ],
      "env": {
        "PATH": "/Users/you/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
      }
    }
  }
}
```

- Google Maps MCP server (example):

```json
{
  "mcpServers": {
    "google-maps": {
      "command": "/usr/bin/env",
      "args": ["npx", "-y", "@modelcontextprotocol/server-google-maps"],
      "env": {
        "PATH": "/Users/you/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "GOOGLE_MAPS_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

Why `/usr/bin/env`? GUI apps often don’t inherit your login-shell PATH. This pattern ensures Node 22 on your PATH is used consistently.

### Windows

- Node MCP server (this project):

```json
{
  "mcpServers": {
    "photo-mcp-node": {
      "command": "node",
      "args": [
        "C:\\Users\\you\\go_proj\\exif_mcp\\node\\dist\\cli.js",
        "--base-dir",
        "D:\\DCIM\\100_FUJI"
      ],
      "env": {
        "PATH": "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows"
      }
    }
  }
}
```

- Google Maps MCP server (example):

```json
{
  "mcpServers": {
    "google-maps": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-google-maps"],
      "env": {
        "PATH": "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
        "GOOGLE_MAPS_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

Notes for Windows:

- Don’t use `/usr/bin/env` on Windows.
- If you use nvm-windows, set PATH so the active version’s `node.exe` is first, or reference it directly (e.g., `C:\\Users\\you\\AppData\\Roaming\\nvm\\v22.18.0\\node.exe`).

## Troubleshooting

- Error: `ERR_UNKNOWN_BUILTIN_MODULE: node:timers/promises` — You’re using an older Node (e.g., v14). Upgrade to Node 20.17+ or 22.9+ and ensure your GUI app uses that version (see PATH examples above).
- `npm v11.x is known not to run on Node.js v14.x` — Same root cause: fix PATH to point to Node 22+ when launching MCP servers.
- ExifTool errors — Set `EXIFTOOL_PATH` to a known-good binary or ensure `exiftool-vendored` installed successfully.
- No matches copied — Check your filter constraints (date/time format, bbox order: `[minLon, minLat, maxLon, maxLat]`). Verify `DateTimeOriginal` exists in the files.

## Development scripts

In `node/`:

```bash
npm run dev   # tsx dev
npm run build # compile to dist/
```

## License

MIT for this repo (unless otherwise noted). `exiftool-vendored` and ExifTool are licensed separately—see their respective projects.
