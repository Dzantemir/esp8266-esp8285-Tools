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

### ⚡ Flash
- **Flash** — flash firmware to device
- **Flash App / Bootloader / Partition Table** — flash individual components
- **Flash & Monitor** — flash then immediately open serial monitor
- **Erase Flash** — full flash erase

### 🖥️ Monitor
- **Monitor** — open serial monitor
- **Stop Monitor** — close serial monitor
- Configurable baud rate

### 🔧 SDK Configure
- **Menuconfig** — visual configuration (idf.py menuconfig)
- **Reconfigure** — re-run CMake configuration
- **Reset Config** — delete sdkconfig and restore defaults

### 🗂️ Partition Table Editor
Visual editor for ESP8266 flash partition tables:
- Drag-and-drop partition reordering
- Flash map visualization
- **OTA preset** — auto-selects 1MB or 2MB+ layout based on flash size
- **SPIFFS preset** — classic SPIFFS layout with large data partition
- **Default preset** — standard single factory app layout
- Auto Offsets — automatic offset calculation
- CSV save/open

### 🛠️ Utilities
- **Make SPIFFS** — pack `data/` folder into SPIFFS image using `mkspiffs`
- **Create Custom Partitions** — open partition table editor

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
- [ESP8266_RTOS_SDK](https://github.com/espressif/ESP8266_RTOS_SDK) installed
- Python 3 with `idf.py` in PATH or configured via extension settings

### For ESP8266_NonOS_SDK (make):
- [ESP8266_NonOS_SDK](https://github.com/espressif/ESP8266_NONOS_SDK) installed
- `make` toolchain in PATH

### For SPIFFS:
- [mkspiffs](https://github.com/igrr/mkspiffs) in PATH

---

## Setup

1. Install the extension
2. Open your ESP8266 project folder
3. In the **ESP-IDF** sidebar panel, set the SDK path via **SDK Path Settings**
4. Select your COM port via **Serial Source Settings**
5. Run **Build** → **Flash** → **Monitor**

---

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `esp-idf-tools.idfPath` | Path to ESP8266_RTOS_SDK | |
| `esp-idf-tools.comPort` | COM port (e.g. `COM3` or `/dev/ttyUSB0`) | |
| `esp-idf-tools.flashBaud` | Flash baud rate | `115200` |
| `esp-idf-tools.flashSize` | Flash size | `2MB` |
| `esp-idf-tools.flashMode` | SPI flash mode (`dio`, `qio`, …) | `dio` |
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
