# Changelog

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
