# Changelog

## [1.8.6]
- Partition Editor: on open — bin file sizes silently re-checked and SIZE updated if changed outside VS Code
- Partition Editor: on save — bin file size validated against available partition area; save blocked if file too large
- Partition Editor: webview handles `applySizeUpdatesOnOpen` message to apply silent SIZE corrections

## [1.8.5]
- Partition Editor: Refresh button now also re-checks all linked bin file sizes
- Partition Editor: if bin file size changed — partition SIZE updated automatically with notification
- Partition Editor: if bin file is missing — link removed with notification

## [1.8.4]
- Code cleanup: removed duplicate `_provider` variable — uses `provider` everywhere
- Code cleanup: removed redundant `_partitionPanels` Set — `_partitionPanel` covers everything
- Code cleanup: removed `require('path')` inside `getSdkconfigValue` — uses global `path`
- Fix: `chainTimer` (Flash+Monitor) — added timeout (30 min) and terminal exit check to prevent interval leak
- Fix: `spiffsgen.py` argument order — positional args now correctly precede options

## [1.8.3]
- Make SPIFFS: image size selection — QuickPick with Auto, presets (64 KB–flash size), and manual input
- Make SPIFFS: manual input validates: positive number, multiple of block size, not exceeding flash size
- Make SPIFFS: accepts bytes, KB suffix, or hex (e.g. `65536`, `64K`, `0x10000`)

## [1.8.2]
- Generate IntelliSense: removed `intelliSenseMode` field — C/C++ extension auto-detects from `compile_commands.json`
- Auto-generate IntelliSense on project open: same fix applied

## [1.8.1]
- Flash / Erase Flash: if `build/flasher_args.json` is missing, automatically runs `idf.py reconfigure` first

## [1.8.0]
- Project Folder: cleared state persists across VS Code restarts — no auto-restore on relaunch

## [1.7.9]
- Project Folder: selection always shows QuickPick menu even with a single workspace folder

## [1.7.8]
- Project Folder: edit (✏️) button hidden when no folder is selected

## [1.7.7]
- Flash+Monitor: monitor button activates only when monitor actually starts, not during flash phase
- Fix: `chainTimer` was triggering immediately — switched to file-only polling without terminal name check

## [1.7.6]
- Project Folder: removed auto-selection logic from `getActiveRoot()` — only explicit user selection

## [1.7.5]
- Project Folder: clear (✕) button properly prevents auto-reselection of folder on refresh

## [1.7.4]
- Project Folder: `contextValue` now `projectFolderGroupActive` when folder selected, `projectFolderGroup` when not
- Project Folder: edit and clear buttons use separate `when` conditions based on active state

## [1.7.3]
- Project Folder: added clear (✕) inline button — releases active project folder without closing VS Code
- Project Folder: `esp.clearProject` command registered

## [1.7.2]
- Partition Editor: fixed broken SIZE cell template — correct escaping restored after Python edit

## [1.7.1]
- Flash+Monitor: monitor runs as a separate `idf.py` call after flash completes (no longer combined)
- Monitor button flips to "stop" only when monitor actually starts via `onChainStart` callback

## [1.7.0]
- Partition Editor: SIZE field becomes read-only when a bin file is linked (input + dropdown hidden)
- Partition Editor: SIZE unlocks when bin link is removed

## [1.6.9]
- Partition Editor: when bin file is linked, partition SIZE is automatically set to file size (rounded to 4096)
- Partition Editor: link cancelled if file exceeds available area between partitions

## [1.6.8]
- Partition Editor: Link to bin button shown only for `fat` and `spiffs` subtypes
- Partition Editor: bin link cleared automatically when subtype changes away from `fat`/`spiffs`
- Partition Editor: bin link cleared when type changes

## [1.6.7]
- Monitor: killing terminal (trash icon) now resets monitor state and refreshes button

## [1.6.6]
- Flash+Monitor / Erase+Flash+Monitor: erase+flash combined in one `idf.py` call; monitor launched separately

## [1.6.5]
- Make SPIFFS: `--aligned-obj-ix-tables` added as mandatory flag (required for ESP8266)

## [1.6.4]
- Make SPIFFS: all SPIFFS parameters now read from `sdkconfig` (`page-size`, `block-size`, `obj-name-len`, `meta-len`, `use-magic`, `use-magic-len`)

## [1.6.3]
- Flash: fixed double ampersand `& &` on Windows when Python path already contains `& ` prefix

## [1.6.2]
- Make SPIFFS: replaced `mkspiffs` binary with bundled `spiffsgen.py` Python script
- Make SPIFFS: removed `getMkspiffsCmd()` and `patchToolsJson()` — no longer needed
- Make SPIFFS: image size auto-calculated by `spiffsgen.py` (omit `image_size` argument)
- Make SPIFFS: prerequisite checks: Python → SDK folder → project folder
- Make SPIFFS: SPIFFS parameters read from `sdkconfig`

## [1.4.4]
- Code cleanup: merged duplicate `onDidReceiveMessage` handlers in Partition Editor
- Code cleanup: moved `_lastSavedLinks` and `patchCMakeWithLinks` outside message handler
- Code cleanup: removed duplicate `setBinLink` handler in webview JS
- Code cleanup: removed duplicate `.refresh-btn` CSS
- Code cleanup: removed dead functions `openCsv`, `refreshFromMenuconfig`, `addPreset`

## [1.4.3]
- Partition Editor: `setDirty()` triggered when linking or removing a bin file

## [1.4.2]
- Partition Editor: unsaved changes warning shown on close

## [1.4.1]
- Partition Editor: new partitions get unique names (`new_part`, `new_part_1`, ...)

## [1.4.0]
- Partition Editor: Link to bin button turns green when a file is linked

## [1.3.3]
- Partition Editor: added **Link to bin** column — link any `.bin` file to a partition
- Partition Editor: on Save, patches `CMakeLists.txt` with `esptool_py_flash_project_args`

## [1.1.8]
- Create New Project wizard: added Step 3 (include folder) and Step 4 (REQUIRES dependencies)
- Sidebar: added ✏️ edit button next to project folder

## [1.1.0]
- Sidebar: Monitor button toggles between start/stop states
- Status bar: added Build, Flash, Monitor buttons
