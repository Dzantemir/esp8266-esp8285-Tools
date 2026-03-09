# ESP8266 / ESP8285 Tools

A convenient VS Code extension for developing with **ESP8266** and **ESP8285** chips.  
Supports both **ESP8266_RTOS_SDK** (`idf.py`) and **ESP8266_NonOS_SDK** (`make`).

---

## Features

### ⚙️ Build
- **Build** — full project build
- **Build App** — application only
- **Build Bootloader** — bootloader only
- **Build Partition Table** — partition table only
- Auto-saves all unsaved files before build

### ⚡ Flash
- **Flash** — flash firmware to device
- **Flash App / Bootloader / Partition Table** — flash individual components
- **Flash Encrypted / Flash Encrypted App** — encrypted flash variants
- **Erase Flash** — full flash erase
- Port availability check before flashing — prompts to select another port if device not connected

### 🖥️ Monitor
- **Monitor** — open serial monitor
- **Stop Monitor** — close serial monitor
- Configurable baud rate
- Port availability check before opening monitor

### 🔧 SDK Configure
- **Menuconfig** — visual configuration (`idf.py menuconfig`)
- **Reconfigure** — re-run CMake configuration
- **Reset Config** — delete sdkconfig and restore defaults

### 📁 Project Folder
- Shows active project name
- **📦 Components** — automatically lists `components/` subfolders
  - `[+]` button — launch **Add Component** wizard
  - `[✏️]` button — edit component (rename, sources, headers, dependencies)
  - `[🗑]` button — delete component with confirmation

### ➕ Add Component Wizard (RTOS SDK only)
Creates a new ESP-IDF component in `components/` with 4 steps:
1. Component name
2. Source `.c` files
3. Header location: `include/` folder, same folder `./`, or none
4. `REQUIRES` dependencies

Generates:
- `components/<name>/CMakeLists.txt` with correct `idf_component_register()`
- `.c` source stub
- `.h` header stub (if selected)

> No changes to root `CMakeLists.txt` needed — ESP-IDF SDK auto-detects `components/`

### ✏️ Edit Component Wizard (RTOS SDK only)
Edits an existing component — opens pre-filled wizard with 4 steps:
1. **Rename** — rename the component folder (leave unchanged to skip)
2. **Source files** — pre-filled from existing `CMakeLists.txt`
3. **Header location** — pre-selected from existing config
4. **REQUIRES dependencies** — pre-filled from existing config

Updates `CMakeLists.txt` in place. Creates any new source files that don't exist yet.

### 🛠️ Utilities
- **Make SPIFFS** — pack `data/` folder into SPIFFS image using `mkspiffs`
- **Custom Partitions** — open partition table editor

> ### 🗂️ Partition Table Editor
>
> Visual editor for ESP8266 flash partition tables.  
> Drag-and-drop reordering, flash map visualization, presets, validation and CSV support.
>
> - Drag-and-drop partition reordering
> - Flash map visualization
> - **OTA preset** — auto-selects 1MB or 2MB+ layout based on flash size
> - **SPIFFS preset** — classic layout: nvs + phy_init + factory (512KB) + spiffs (rest)
> - **Default preset** — standard single factory app (960KB max due to ESP8266 1MB boundary)
> - Auto Offsets — automatic offset calculation
> - Validation with ESP8266-specific checks (1MB app boundary, alignment, overlaps)
> - CSV save/open

### ⚗️ Advanced (Experimental)
- eFuse Common / Custom Table generation
- OTA data erase / read
- Show eFuse Table

### 🔧 VSCode Utilities
- **Generate IntelliSense** — creates `.vscode/c_cpp_properties.json` with correct ESP8266 includes
- **Generate tasks.json** — adds ESP build tasks for `Ctrl+Shift+B`

---

## Requirements

### For ESP8266_RTOS_SDK (idf.py):
- [Python 3.7.x](https://www.python.org/downloads/release/python-379/) — **must be 3.7.x**, newer versions are not compatible with ESP8266 SDK
- [ESP8266_RTOS_SDK](https://github.com/espressif/ESP8266_RTOS_SDK) — download and set path via extension settings

### For ESP8266_NonOS_SDK (make):
- [ESP8266_NonOS_SDK](https://github.com/espressif/ESP8266_NONOS_SDK) — set path via extension settings
- `make` toolchain in PATH

---

## Setup (Fresh Install)

1. Install the extension — sidebar shows the full command tree immediately
2. **Install Python 3.7** — click ⚠️ Python 3.7 not found in sidebar → Download Python 3.7
3. **Set up SDK** — in sidebar, click **RTOS IDF: not set** or **NonOS SDK: not set** and point to your SDK folder
4. **Install build tools** — extension detects missing tools and offers to install automatically
5. Select your COM port via **Serial Source Settings → Port**
6. Run **Build** → **Flash** → **Monitor**

---

## Command Check Order

Every command verifies prerequisites in this order before executing:

1. **Python 3.7** — if not found, shows download prompt
2. **IDF path** — if not set, shows settings prompt
3. **Build tools** — if missing, offers automatic installation
4. **Project folder** — if not selected, shows folder picker
5. **COM port** — if not connected, shows port selector

---

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `esp-idf-tools.idfPath` | Path to ESP8266_RTOS_SDK | |
| `esp-idf-tools.nonosSdkPath` | Path to ESP8266_NonOS_SDK | |
| `esp-idf-tools.sdkType` | SDK type: `auto`, `rtos`, `nonos` | `auto` |
| `esp-idf-tools.pythonPath` | Manual path to Python 3.7 folder | |
| `esp-idf-tools.comPort` | COM port (e.g. `COM3` or `/dev/ttyUSB0`) | |
| `esp-idf-tools.flashBaud` | Flash baud rate | `115200` |
| `esp-idf-tools.flashSize` | Flash size | `2MB` |
| `esp-idf-tools.flashMode` | SPI flash mode (`dio`, `qio`, …) | `dio` |
| `esp-idf-tools.flashFreq` | SPI flash frequency | `40m` |
| `esp-idf-tools.monitorBaud` | Serial monitor baud rate | `74880` |
| `esp-idf-tools.postBuildAction` | Auto action after build (`none`, `flash`, `flash_monitor`) | `none` |
| `esp-idf-tools.postFlashAction` | Auto action after flash (`none`, `monitor`) | `none` |
| `esp-idf-tools.useCompressedUpload` | Use compressed upload (`-z`) | `true` |
| `esp-idf-tools.saveSettingsToWorkspace` | Save settings per-project | `true` |

---

## Supported Platforms

- ✅ Windows 10/11 (PowerShell)
- ✅ Linux (bash)
- ✅ macOS (bash/zsh)

---

## License

MIT
