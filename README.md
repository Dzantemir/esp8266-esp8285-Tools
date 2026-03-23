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
- Pre-build action: none / clean / full clean (Build only)
- Post-build action: none / flash / flash app
- Optional post-build analysis: size / size-components / size-files
- COM port verified before build when post-build flash is selected

### ⚡ Flash
- **Flash** — flash full firmware to device
- **Flash App** — flash application only
- **Flash Bootloader** — flash bootloader only
- **Flash Partition Table** — flash partition table only
- **Erase Flash** — full flash erase
- Configurable erase before flash (Flash only)
- Configurable action after flash: none / monitor
- Port availability check before flashing

### 🖥️ Monitor
- **Monitor** — toggles between start/stop (button changes state)
- Status bar shows Monitor button — red when running
- Configurable baud rate

### 🔧 SDK Configure
- **Menuconfig** — visual configuration (`idf.py menuconfig`)
- **Reconfigure** — re-run CMake
- **Reset Projectconfig** — delete `sdkconfig` and restore defaults on next build

### 📁 Project Folder
- Shows active project name with ✏️ edit button (edits `main/CMakeLists.txt`)
- **📦 Components** — always visible, lists `components/` subfolders
  - `[+]` button — **Create New Component** wizard
  - `[✏️]` button — edit component
  - `[🗑]` button — delete component

### ➕ Create New Component Wizard
4 steps: name → source files → header location → REQUIRES dependencies

### ➕ Create New Project Wizard
4 steps: parent folder → project name → header location → REQUIRES dependencies  
Generates `CMakeLists.txt`, `main.c`, header stub.

### 🛠️ Utilities
- **Make SPIFFS** — pack any folder into a SPIFFS binary image using `mkspiffs`
  - Opens folder picker (defaults to project root)
  - Calculates image size automatically (`folder size × 2 + 4096`, min 16 KB)
  - Warns if image exceeds project flash size
  - Saves `<foldername>.bin` to project root
  - `mkspiffs` installed automatically if not found
- **Custom Partitions** — open partition table editor

> ### 🗂️ Partition Table Editor
>
> Visual editor for ESP8266 flash partition tables.
> Drag-and-drop reordering, flash map visualization, presets, validation and auto-patching.
>
> - Drag-and-drop partition reordering (drag handle `⠿`)
> - Flash map visualization
> - **Default Partition** — standard single factory app layout
> - **Auto Offsets** — automatic offset recalculation from PT end
> - Reads PT offset, flash size and CSV filename from `sdkconfig` automatically
> - **Link to bin** — link any `.bin` file to a partition
> - Unsaved changes warning on close
> - New partitions get unique names automatically
> - Validation: alignment, overlaps, name length, duplicate names, custom subtype range (0x00–0xFE)
> - TYPE: `app` / `data` / `custom…` (hex subtype 0x00–0xFE)
> - DATA subtypes: `nvs`, `ota`, `phy`, `fat`, `spiffs`
> - APP subtypes: `factory`, `ota_0`, `ota_1`



### 📊 Analysis
- **Size** — firmware size report
- **Size Components** — per-component breakdown
- **Size Files** — per-file breakdown

### 🔧 VSCode Utilities
- **Generate IntelliSense** — creates `.vscode/c_cpp_properties.json`
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
4. Select COM port via **Serial Source Settings → Port**
5. Run **Build** → **Flash** → **Monitor**

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
| `esp-idf-tools.postBuildAction` | After build: `none` / `flash` / `app_flash` | `none` |
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
