# Changelog

## [1.8.7]
- Partition Editor: renamed "Default table" → "Default preset" for consistency
- Partition Editor: OTA and SPIFFS presets now replace partitions instantly (no confirmation dialog)
- Partition Editor: improved SPIFFS preset layout — larger SPIFFS partition (512KB app + rest for SPIFFS)
- Partition Editor: fixed `window.confirm()` blocking in VSCode webview — replaced with native VSCode dialogs

## [1.8.6]
- Partition Editor: merged two OTA preset buttons into one smart adaptive button
  - Automatically shows "OTA preset (1MB)" or "OTA preset (2MB+)" based on current flash size
- Partition Editor: replaced "NVS+FAT preset" with "SPIFFS preset"
- Partition Editor: renamed "Refresh Settings From sdkconfig" → "Refresh From Menuconfig"
- Partition Editor: added preset conflict messages (inline banner, auto-dismiss after 7s)

## [1.8.5]
- Partition Editor: fixed hex offset formatting — removed extra leading zero (0x09000 → 0x9000)
- Partition Editor: OTA 2MB+ button now disables when flash size < 2MB
- Partition Editor: NVS+FAT preset now includes actual FAT storage partition

## [1.8.4]
- Sidebar: moved experimental commands (eFuse, OTA data) into new "⚗️ Advanced (Experimental)" group
- Sidebar: group tooltip warns that eFuse writes are irreversible

## [1.8.3]
- Added validation for missing partition CSV file before running idf.py commands
- Added "Reset Config" command — deletes sdkconfig and sdkconfig.old to restore defaults

## [1.8.2]
- Partition Editor: enforced singleton panel (clicking "Create Custom Partitions" when editor is open now focuses existing panel)

## [1.8.1]
- Fixed global busy lock not releasing after non-build commands (clean, menuconfig, size)
- Extended marker file approach to all commands for reliable completion detection

## [1.8.0]
- Added global busy state — prevents running multiple commands simultaneously
- Status bar shows active command name with spinner
- All commands disabled during any running operation
- Partition Editor "Save CSV" button disables while busy

## [1.7.3]
- Initial public release
- ESP8266_RTOS_SDK (idf.py) support: build, flash, monitor, menuconfig, clean
- ESP8266_NonOS_SDK (make) support: build, flash, monitor
- Visual Partition Table Editor
- SPIFFS image creation via mkspiffs
- IntelliSense and tasks.json generation
- Project creation wizard
