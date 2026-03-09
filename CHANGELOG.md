# Changelog

## [0.9.7]
- Build: fixed requirements check — replaced `pip install --dry-run` (not supported in pip<21) with `pip check` (works with Python 3.7)

- Build: added requirements.txt check before build — if Python packages not satisfied, offers to install automatically (was silently failing at idf.py build step)

- Components: Edit wizard — added Step 0 "Rename" — renames the component folder (leave unchanged to skip)
- Components: success message shows "renamed → new_name" when folder was renamed

- Components: added ✏️ Edit button next to each component — opens pre-filled wizard (Source files, Header location, REQUIRES)
- Components: Edit wizard reads existing CMakeLists.txt and pre-fills all fields

- Sidebar: removed ⚠️ Python warning from tree — shown only when a command is invoked

## [0.9.2]
- Sidebar: full tree always visible even without project folder selected — commands show error only when needed
- Check order: all commands now follow strict sequence: Python → IDF path → Tools → Project folder → Port
- Port check dialog: removed "Flash anyway" button — only "Select another port" or Cancel
- Port check: added to NONOS Monitor (was missing)
- Startup: no more double notifications — environment check runs silently, warnings appear only in sidebar tree
- Startup: `checkAndInstallTools` now runs silently (no popup if Python not found at startup)
- Python error: unified — shown only once per command (removed duplicate messages from individual commands)
- Project folder error: unified message "ESP: Select project folder!" with "Select Folder" button in all 6 places
- pip install: status bar busy spinner shown during installation
- `version.txt`: validation now uses same regex as `idf_tools.py` (`v\d+\.\d+`) — reads first 16 bytes
- `version.txt`: removed `.git` folder check — was irrelevant to file content validity
- Code: removed unused `_busyCommands` variable
- Code: removed redundant `checkBusy()` call in `runWithPostFlash`
- New extension icon

## [1.9.1]
- Environment check on startup: validates Git, Python 3.7, SDK — shows warnings in sidebar tree
- Sidebar warnings: ⚠️ Git not installed / ⚠️ Python 3.7 not found — click to fix
- SDK setup: RTOS IDF and NonOS SDK buttons now offer **Clone via Git** option (only shown when Git is installed)
- Clone SDK: select target folder → `git clone --recursive` → auto-sets SDK path → auto-installs tools
- All commands (Build, Flash, Monitor, Clone) blocked while another command is running
- Build: checks Git and Python before starting — shows actionable error with download link if missing
- Build: fresh Python check on every run (bypasses cache) — detects if Python was uninstalled
- Install Tools: checks Python availability before starting installation
- Python error message: added hint to check "Add Python to PATH" during setup
- VSCode window focus: silently re-checks environment when returning from another app
- Removed setuptools==69.5.1 workaround (not needed with Python 3.7)

## [1.9.0]
- Project Folder: added **Components** subgroup — shows `components/` folder contents automatically
- Project Folder: inline `[+]` button on "Project Folder" header — launches Add Component wizard
- Project Folder: inline `[🗑]` button on each component — deletes with confirmation dialog
- Add Component wizard: 4-step wizard (name → source files → headers → REQUIRES)
- Add Component: generates `CMakeLists.txt` with correct `idf_component_register()`, `.c` and `.h` stubs
- Add Component: shows warning and exits for NonOS SDK (CMake not supported)
- code: added 18 section dividers throughout `extension.js` for easier navigation

## [1.8.9]
- Utilities: added **Add Component** command (later moved to Project Folder in 1.9.0)

## [1.8.8]
- Build commands: auto-save all unsaved files before build (`saveAll`)
- Partition Editor: fixed Default preset — factory size now always capped at 0xF0000 (960KB) due to ESP8266 1MB app boundary hardware limit

## [1.8.7]
- Published to VS Code Marketplace
- Added GitHub repository: https://github.com/Dzantemir/esp8266-esp8285-Tools
- Added README.md and CHANGELOG.md
- Partition Editor: renamed "Default table" → "Default preset"
- Partition Editor: OTA and SPIFFS presets now replace all partitions instantly
- Partition Editor: improved SPIFFS preset layout — 512KB app + rest for SPIFFS
- Partition Editor: fixed `window.confirm()` blocking in VSCode webview

## [1.8.6]
- Partition Editor: merged two OTA preset buttons into one adaptive button
  - Auto-switches label between "OTA preset (1MB)" and "OTA preset (2MB+)"
- Partition Editor: replaced "NVS+FAT preset" with "SPIFFS preset"
- Partition Editor: renamed "Refresh Settings From sdkconfig" → "Refresh From Menuconfig"
- Partition Editor: inline warning banner for preset conflicts (auto-dismiss 7s)

## [1.8.5]
- Partition Editor: fixed hex offset formatting (0x09000 → 0x9000)
- Partition Editor: OTA 2MB+ button disables when flash < 2MB
- Partition Editor: NVS+FAT preset now includes FAT storage partition

## [1.8.4]
- Sidebar: moved eFuse/OTA commands to "⚗️ Advanced (Experimental)" group
- Sidebar: group tooltip warns that eFuse writes are irreversible

## [1.8.3]
- Validation: check for missing partition CSV before running idf.py
- Added "Reset Config" — deletes sdkconfig and sdkconfig.old

## [1.8.2]
- Partition Editor: enforced singleton panel

## [1.8.1]
- Fixed global busy lock not releasing after non-build commands

## [1.8.0]
- Added global busy state — prevents parallel command execution
- Status bar shows active command with spinner

## [1.7.3]
- Initial public release
- ESP8266_RTOS_SDK (idf.py) support: build, flash, monitor, menuconfig, clean
- ESP8266_NonOS_SDK (make) support: build, flash, monitor
- Visual Partition Table Editor
- SPIFFS image creation via mkspiffs
- IntelliSense and tasks.json generation
- Project creation wizard
