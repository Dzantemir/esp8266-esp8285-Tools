# ESP8266 / ESP8285 Tools

A convenient VS Code extension for developing with **ESP8266** and **ESP8285** chips.  
Supports **ESP8266_RTOS_SDK** via `idf.py`.

---

## Features

### ⚙️ Build
- **Build** — full project build with configurable pre/post actions
- **Build App** — application only
- **Build Bootloader** — bootloader only
- **Build Partition Table** — partition table only
- Auto-saves all unsaved files before build
- Pre-build action: none / clean / full clean
- Post-build action: none / flash / flash app
- Optional post-build analysis: size / size-components / size-files
- COM port verified before build when post-build flash is selected

### ⚡ Flash
- **Flash** — flash full firmware to device
- **Flash App** — flash application only
- **Flash Bootloader** — flash bootloader only
- **Flash Partition Table** — flash partition table only
- **Erase Flash** — full flash erase
- Configurable erase before flash
- Configurable action after flash: none / monitor
- Port availability check before flashing
- If `build/flasher_args.json` is missing — automatically runs `reconfigure` first, then flash

### 🖥️ Monitor
- **Monitor** — toggles between start/stop (button changes state)
- Status bar shows Monitor button — red when running
- Configurable baud rate
- When terminal is killed (trash icon) — monitor state resets automatically
- Flash + Monitor runs as two separate `idf.py` calls: flash completes first, then monitor starts
- Monitor button activates only when monitor actually starts (not during flash)

### 🔧 SDK Configure
- **Menuconfig** — visual configuration (`idf.py menuconfig`)
- **Reconfigure** — re-run CMake
- **Reset Projectconfig** — delete `sdkconfig` and restore defaults on next build

### 📁 Project Folder
- Shows active project name
- **✏️** edit button — edits `main/CMakeLists.txt` (visible only when folder is selected)
- **✕** clear button — releases active project folder (visible only when folder is selected)
- Project folder selection always shows QuickPick menu — no auto-selection
- Cleared folder state persists across VS Code restarts
- **📦 Components** — lists `components/` subfolders
  - `[+]` — Create New Component wizard
  - `[✏️]` — edit component
  - `[🗑]` — delete component

### ➕ Create New Component Wizard
4 steps: name → source files → header location → REQUIRES dependencies

### ➕ Create New Project Wizard
4 steps: parent folder → project name → header location → REQUIRES dependencies  
Generates `CMakeLists.txt`, `main.c`, header stub.

### 🛠️ Make SPIFFS
Pack any folder into a SPIFFS binary image using the bundled `spiffsgen.py` script.

- Opens folder picker (defaults to project root)
- **Image size**: Auto (minimum size calculated by spiffsgen.py) or manual input (bytes / KB / hex)
- All SPIFFS parameters read from `sdkconfig` automatically:
  - `CONFIG_SPIFFS_PAGE_SIZE` → `--page-size`
  - `CONFIG_WL_SECTOR_SIZE` → `--block-size`
  - `CONFIG_SPIFFS_OBJ_NAME_LEN` → `--obj-name-len`
  - `CONFIG_SPIFFS_META_LENGTH` → `--meta-len`
  - `CONFIG_SPIFFS_USE_MAGIC` → `--use-magic` / `--no-magic`
  - `CONFIG_SPIFFS_USE_MAGIC_LENGTH` → `--use-magic-len` / `--no-magic-len`
- `--aligned-obj-ix-tables` always enabled (required for ESP8266)
- Checks Python → SDK folder → project folder before running
- Saves `<foldername>.bin` to project root

> ### 🗂️ Partition Table Editor
>
> Visual editor for ESP8266 flash partition tables — drag-and-drop, flash map, validation, bin linking.
>
> - Drag-and-drop partition reordering (drag handle `⠿`)
> - Flash map visualization
> - **Default Partition** — standard single factory app layout
> - **Auto Offsets** — automatic offset recalculation from PT end
> - Reads PT offset, flash size and CSV filename from `sdkconfig`
> - **Link to bin** — available only for `fat` and `spiffs` subtypes
>   - When a bin file is linked — SIZE is set automatically to match file size (rounded to 4096)
>   - SIZE field becomes read-only while a bin is linked
>   - On open — bin file sizes silently re-checked and SIZE updated if file changed
>   - On **Refresh** — bin file sizes re-checked, partitions updated, missing files unlinked
>   - On save — bin file checked against available area; save blocked if file is too large
> - Unsaved changes warning on close
> - New partitions get unique names automatically
> - Validation: alignment, overlaps, name length, duplicate names, custom subtype range
> - TYPE: `app` / `data` / `custom…` (hex subtype 0x00–0xFE)
> - DATA subtypes: `nvs`, `ota`, `phy`, `fat`, `spiffs`
> - APP subtypes: `factory`, `ota_0`, `ota_1`

### 📊 Analysis
- **Size** — firmware size report
- **Size Components** — per-component breakdown
- **Size Files** — per-file breakdown

### 🔧 VSCode Utilities
- **Generate IntelliSense** — creates `.vscode/c_cpp_properties.json`
  - Uses `compile_commands.json` as primary source (most accurate for Xtensa)
  - No `intelliSenseMode` override — C/C++ extension auto-detects from compile commands
- **Generate tasks.json** — adds ESP build tasks for `Ctrl+Shift+B`

### 📊 Status Bar
Quick access buttons: **Build** → **Flash** → **Clean** → **Monitor** → **COM port**

---

## Requirements

- [Python 3.7.x](https://www.python.org/downloads/release/python-379/) — **must be 3.7.x**
- [ESP8266_RTOS_SDK](https://github.com/espressif/ESP8266_RTOS_SDK)

---

## Setup

1. Install the extension
2. Set SDK path — click **RTOS IDF: not set** in sidebar
3. Install build tools — extension installs automatically via `idf_tools.py`
4. Select project folder — click **Project Folder → folder not found** in sidebar
5. Select COM port via **Serial Source Settings → Port**
6. Run **Build** → **Flash** → **Monitor**

---

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `esp-idf-tools.idfPath` | Path to ESP8266_RTOS_SDK | |
| `esp-idf-tools.pythonPath` | Manual path to Python 3.7 | |
| `esp-idf-tools.comPort` | COM port (`COM3` or `/dev/ttyUSB0`) | |
| `esp-idf-tools.flashBaud` | Flash baud rate | `115200` |
| `esp-idf-tools.flashSize` | Flash size | `2MB` |
| `esp-idf-tools.flashMode` | SPI flash mode | `dio` |
| `esp-idf-tools.flashFreq` | SPI flash frequency | `40m` |
| `esp-idf-tools.monitorBaud` | Monitor baud rate | `74880` |
| `esp-idf-tools.eraseBeforeFlash` | Erase flash before flashing | `false` |
| `esp-idf-tools.postFlashAction` | After flash: `none` / `monitor` | `none` |
| `esp-idf-tools.postBuildAction` — After build: `none` / `flash` / `app_flash` | `none` |
| `esp-idf-tools.useCompressedUpload` | Compressed upload (`-z`) | `true` |
| `esp-idf-tools.overrideFlashConfig` | Use manual flash settings | `false` |
| `esp-idf-tools.reuseTerminal` | Reuse existing terminal | `true` |
| `esp-idf-tools.saveSettingsToWorkspace` | Save settings per-project | `true` |

---

## Supported Platforms

- ✅ Windows 10/11 (PowerShell)
- ✅ Linux (bash)
- ✅ macOS (bash/zsh)

---

## Links

- [GitHub Repository](https://github.com/Dzantemir/esp8266-esp8285-Tools)
- [ESP8266_RTOS_SDK](https://github.com/espressif/ESP8266_RTOS_SDK)
- [Report Issues](https://github.com/Dzantemir/esp8266-esp8285-Tools/issues)

---

## License

MIT
