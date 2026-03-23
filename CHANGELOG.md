# Changelog

## [1.4.4]
- Code cleanup: merged duplicate `onDidReceiveMessage` handlers in Partition Editor
- Code cleanup: moved `_lastSavedLinks` and `patchCMakeWithLinks` outside message handler (critical bug fix)
- Code cleanup: removed duplicate `setBinLink` handler in webview JS
- Code cleanup: removed duplicate `.refresh-btn` CSS
- Code cleanup: removed dead functions `openCsv`, `refreshFromMenuconfig`, `addPreset`

## [1.4.3]
- Partition Editor: `setDirty()` now also triggered when linking or removing a bin file

## [1.4.2]
- Partition Editor: unsaved changes warning shown when editor is closed without saving

## [1.4.1]
- Partition Editor: new partitions now get unique names (`new_part`, `new_part_1`, ...)

## [1.4.0]
- Partition Editor: Link to bin button turns green when a file is linked

## [1.3.9]
- Partition Editor: added unsaved changes tracking — warns on close if changes were not saved

## [1.3.8]
- Partition Editor: Link to bin button color changes to green when linked

## [1.3.7]
- Partition Editor: removed emoji from link button (display issue in webview)

## [1.3.6]
- Partition Editor: `reconfigure` now runs only when bin links actually changed

## [1.3.5]
- Partition Editor: fixed save notification showing `${currentCsvFilename}` as literal text

## [1.3.4]
- Partition Editor: fixed Windows backslash paths in generated CMakeLists.txt

## [1.3.3]
- Partition Editor: new **Link to bin** column — link any `.bin` file to a partition
- Partition Editor: on Save, automatically patches `CMakeLists.txt` with `esptool_py_flash_project_args` and runs `reconfigure`
- Partition Editor: link persists during editor session; cleared on close

## [1.3.2]
- Sidebar: Flash Bootloader and Flash Part. Table now have the same configure menu as Flash App (Monitor after flash)

## [1.3.1]
- Sidebar: Build App, Build Bootloader, Build Part. Table configure menu now has 2 steps (no pre-build clean step)
- Sidebar: Build configure menu retains 3 steps including pre-build clean

## [1.3.0]
- Sidebar: Build App, Build Bootloader, Build Part. Table — removed configure button (no pre-build clean needed for partial builds)

## [1.2.9]
- Partition Editor: renamed `↺ Default` button to `↺ Default Partition`

## [1.2.8]
- Make SPIFFS: warning threshold now uses project flash size from settings instead of hardcoded 4MB

## [1.2.7]
- Partition Editor: updated Refresh button tooltip to mention partition filename

## [1.2.6]
- Partition Editor: restored `saves to <filename>` in subtitle
- Partition Editor: renamed `↺ Default preset` back to `↺ Default`

## [1.2.5]
- Partition Editor: removed SPIFFS preset button
- Partition Editor: `↺ Refresh from Projectconfig` → `↺ Refresh`
- Partition Editor: `💾 Save CSV` → `💾 Save`

## [1.2.4]
- Partition Editor: removed `nvs_keys`, `coredump`, `esphttpd` from DATA_SUBTYPES (ESP32-only, not supported on ESP8266)

## [1.2.3]
- Partition Editor: added validation for custom subtype — must be 0x00–0xFE (uint8_t)

## [1.2.2]
- Partition Editor: restored `custom…` option in TYPE dropdown

## [1.2.1]
- Partition Editor: restored custom subtype input field for custom type partitions

## [1.2.0]
- Sidebar: renamed `ESP › Create Component` to `ESP › Create New Component`

## [1.1.9]
- Linux: removed `--user` flag from all `pip install` commands (incompatible with venv)

## [1.1.8]
- Create New Project wizard: added Step 3 (include folder) and Step 4 (REQUIRES dependencies)
- Create New Project: generates header file stub based on include choice
- Sidebar: added ✏️ edit button next to project folder — edits `main/CMakeLists.txt` (includes and REQUIRES)

## [1.1.7]
- package.json: fixed malformed `ESP NonOS › Flash` entry without `command` field

## [1.1.6]
- package.json: added missing `esp.resetConfig` command declaration

## [1.1.5]
- Code cleanup: removed dead NonOS references, `isRtos` variable, `esp.flashMonitor` command
- Code cleanup: removed NONOS SDK branch from `showRtosSdkInfo`

## [1.1.4]
- Status bar: reordered buttons — Build → Flash → Clean → Monitor → COM port

## [1.1.3]
- Status bar: added Clean button

## [1.1.2]
- Sidebar: Components group always visible when project is selected (even if empty)
- Sidebar: Create Component (`+`) button moved to Components group
- Status bar: COM port moved to last position

## [1.1.1]
- Status bar / Sidebar: Monitor button text always shows `Monitor`; tooltip changes between `Start Monitor` and `Stop Monitor`

## [1.1.0]
- Sidebar: Monitor button toggles between start/stop states
- Status bar: added Build, Flash, Monitor buttons
- Monitor: status bar Monitor button turns red when monitor is running

## [1.0.9]
- Linux: removed `--user` from pip install (venv compatibility)

## [1.0.8]
- Sidebar: project folder now has ✏️ edit button
- Create New Project: step numbering fixed (2 steps after SDK choice removal)

## [1.0.7]
- Partition Editor: Refresh button tooltip updated

## [1.0.6]
- Fixed: `activeSdk is not defined` error in Create New Project wizard
- Create New Project: removed SDK type selection step (always RTOS)

## [1.0.5]
- Partition Editor: APP_SUBTYPES trimmed to `factory`, `ota_0`, `ota_1` only
- Partition Editor: removed `custom…` TYPE option and custom subtype input

## [1.0.4]
- Partition Editor: TYPE and SUBTYPE columns fixed to same width with `min/max-width`

## [1.0.3]
- Partition Editor: all 4 data columns set to 50px; subtype set to 100px

## [1.0.2]
- Partition Editor: TYPE and SUBTYPE columns set to equal width (80px)

## [1.0.1]
- Partition Editor: column widths adjusted

## [1.0.0]
- Partition Editor: column widths rebalanced

## [0.9.99]
- Sidebar: removed terminal size warning from Reconfigure tooltip

## [0.9.98]
- Sidebar: added idf.py command descriptions to all tooltips

## [0.9.97]
- Sidebar: `Open Monitor` renamed to `Monitor` in all menus

## [0.9.96]
- Build: post-build Flash and Flash App now use same settings as sidebar Flash/Flash App buttons
- Build: COM port checked before build starts when post-build flash is selected

## [0.9.95]
- Build: COM port check added for Flash action in Step 3/3

## [0.9.94]
- Build: COM port check added for Flash App action in Step 3/3

## [0.9.93]
- Build: Step 3/3 — replaced `Flash & Monitor` with `Flash App`

## [0.9.92]
- README updated

## [0.9.91]
- manifest: added GitHub repository, issues and homepage links

## [0.9.90]
- Partition Editor: Save now re-reads CSV filename on each save (picks up sdkconfig changes)

## [0.9.89]
- Partition Editor: delete button repositioned to right edge with 15px margin

## [0.9.88]
- Partition Editor: delete button always red

## [0.9.87]
- Partition Editor: equal padding on delete button

## [0.9.86]
- Partition Editor: subtype column 100px

## [0.9.85]
- Partition Editor: column widths rebalanced

## [0.9.84]
- Partition Editor: spacing between size button and delete button

## [0.9.83]
- Partition Editor: CSV filename in subtitle now updates on Refresh
- Partition Editor: subtitle and Refresh tooltip updated from `sdkconfig` to `Projectconfig`

## [0.9.82]
- Partition Editor: removed ENCRYPT column

## [0.9.81]
- Sidebar: Flash App configure menu — removed `Erase before flash` step (unsafe for app-only flash)

## [0.9.80]
- Sidebar: removed configure button from Flash App

## [0.9.79]
- Sidebar: removed configure button (`≡`) from Flash Bootloader and Flash Part. Table

## [0.9.78]
- Partition Editor: fixed drag-and-drop — drag only from handle `⠿`, fixed `dragleave` flicker

## [0.9.77]
- Make SPIFFS: removed output folder picker — always saves to project folder with folder name as filename

## [0.9.76]
- Make SPIFFS: dialog opens at project folder; empty folder warning removed

## [0.9.75]
- Make SPIFFS: system decides initial folder for dialog

## [0.9.74]
- Make SPIFFS: image size formula `× 2 + 4096`, minimum 4 blocks

## [0.9.73]
- Make SPIFFS: image size multiplier 1.25×

## [0.9.72]
- Make SPIFFS: image size multiplier 1.5×

## [0.9.71]
- Make SPIFFS: image size multiplier 2×

## [0.9.70]
- Make SPIFFS: fixed image size calculation (minimum 4 blocks, proper overhead)

## [0.9.69]
- Make SPIFFS: new flow — folder picker, size warning, output location choice

## [0.9.68]
- Make SPIFFS: dynamic image size from folder content; removed spiffsSize/Block/Page settings

## [0.9.67]
- Sidebar: `Reset sdkconfig` → `Reset Projectconfig`
- Partition Editor: `Refresh from sdkconfig` → `Refresh from Projectconfig`

## [0.9.66]
- Partition Editor: removed OTA preset button

## [0.9.65]
- Sidebar: `Tool Path Settings` → `Python Path Settings`
