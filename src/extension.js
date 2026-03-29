'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');


// ╔══════════════════════════════════════════════════════════════════╗
// ║  HELPERS: State, Platform, Logging, Config, Path                   ║
// ╚══════════════════════════════════════════════════════════════════╝
// ─── Module-level state ───────────────────────────────────────────────────────
let terms             = {};
let activeRoot        = null;
let globalCtx         = null;
let outputChannel     = null;
let portCache         = { data:[], timestamp: 0 };
let _pythonCmd        = null;
let _pythonCmdTime    = 0;
let _idfPathOverride  = null;  // temporary override until onDidChangeConfiguration fires
let _toolsVerified    = false; // true once idf_tools.py check passed — reset on SDK/Python change

const PYTHON_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let _statusBarPort    = null;      // StatusBarItem — port
let _statusBarBusy    = null;      // StatusBarItem — busy indicator
let _statusBarBuild   = null;      // StatusBarItem — build button
let _statusBarFlash   = null;      // StatusBarItem — flash button
let _statusBarMonitor = null;      // StatusBarItem — monitor toggle button
let _statusBarClean   = null;      // StatusBarItem — clean button
let _monitorRunning   = false;     // true while monitor terminal is active
let _globalBusy       = false;     // true while ANY command is running
let _globalBusyName   = '';        // name of running command (for messages)
let provider          = null;      // EspProvider instance (set in activate)
let _partitionPanel   = null;      // singleton — only one editor at a time
let _pushSdkconfigUpdate = null;   // callback — auto-refresh partition editor after menuconfig

// ─── Platform ─────────────────────────────────────────────────────────────────
const IS_WIN   = os.platform() === 'win32';
const IS_MAC   = os.platform() === 'darwin';
const IS_LINUX = os.platform() === 'linux';

// ─── Path escape helper (Экранирование пробелов в путях) ─────────────────
function q(p) {
    if (!p) return '""';
    if (IS_WIN) {
        return `'${p.replace(/'/g, "''")}'`;
    }
    return `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('ESP-IDF Tools');
    }
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─── Config helpers ───────────────────────────────────────────────────────────
function cfg(key) {
    return vscode.workspace.getConfiguration('esp-idf-tools', null).get(key);
}

async function setCfg(key, val) {
    const config = vscode.workspace.getConfiguration('esp-idf-tools');
    if (cfg('saveSettingsToWorkspace') && vscode.workspace.workspaceFolders?.length) {
        await config.update(key, val, vscode.ConfigurationTarget.Workspace);
    } else {
        try { await config.update(key, undefined, vscode.ConfigurationTarget.Workspace); } catch {}
        await config.update(key, val, vscode.ConfigurationTarget.Global);
    }
}

// ─── Path helpers ─────────────────────────────────────────────────────────────
function expandHome(p) {
    if (!p) return p;
    return (p.startsWith('~/') || p === '~') ? path.join(os.homedir(), p.slice(2)) : p;
}

function getValidIdfPath() {
    const p = expandHome(_idfPathOverride || cfg('idfPath')) || process.env.IDF_PATH;
    if (!p || !fs.existsSync(p)) return null;
    if (!fs.existsSync(path.join(p, 'tools', 'idf_tools.py'))) return null;
    return p;
}

// ─── Shell detection ────────────────────────────────────────────────────────────
function getUserShell() {
    if (IS_WIN) return cfg('shellPath') || 'powershell.exe';
    return cfg('shellPath') || process.env.SHELL || '/bin/bash';
}

// ─── Python detection (cached) ────────────────────────────────────────────────
// Returns Python cmd only if version is 3.7.x — warns user if wrong version found
// Strip PowerShell-only "& " prefix — cp.exec uses cmd.exe where & is invalid
function toExecCmd(cmd) { return (cmd || '').replace(/^& /, ''); }

// ─── pip availability check ───────────────────────────────────────────────────
// Returns true if pip is available, false if not.
// warn=true  → shows a warning notification (used in getPythonCmd / cmdSetPythonPath)
// warn=false → shows an error notification (used before pip install, blocks execution)
async function checkPip(pythonCmd, warn = true) {
    const execCmd = toExecCmd(pythonCmd);
    const hasPip = await new Promise(r =>
        cp.exec(`${execCmd} -m pip --version`, { timeout: 8000 }, (e, stdout, stderr) => {
            log(`[pip] check execCmd="${execCmd}" ok=${!e} out="${(stdout||'').trim()}" err="${(stderr||'').trim()}"`);
            r(!e);
        })
    );
    if (hasPip) return true;

    const msg = warn
        ? `ESP: Python 3.7 found but pip is missing.`
        : `ESP: pip not found — cannot install requirements.`;
    const showFn = warn ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;

    const ans = await showFn(msg, 'Install pip', 'Download Python 3.7');

    if (ans === 'Install pip') {
        log(`[pip] installing via ensurepip for ${pythonCmd}`);

        setBusy('Install pip');

        // Показываем терминал чтобы пользователь видел ход установки
        const t = getTerm('ESP: Install pip');
        t.show(true);

        const markerFile = path.join(os.tmpdir(), `esp_pip_${Date.now()}.tmp`);
        const termCmd = (IS_WIN && pythonCmd.startsWith('"')) ? `& ${pythonCmd}` : pythonCmd;
        t.sendText(`${termCmd} -m ensurepip --upgrade${buildMarkerCmd(markerFile)}`);

        await watchCommandDone(markerFile, 'ESP: Install pip');
        clearBusy();

        // Перепроверяем pip после установки
        const pipOk = await new Promise(r =>
            cp.exec(`${pythonCmd} -m pip --version`, { timeout: 5000 }, (e) => r(!e))
        );
        if (pipOk) {
            vscode.window.showInformationMessage('ESP: pip installed successfully!');
            log(`[pip] ensurepip succeeded for ${pythonCmd}`);
            return true;
        } else {
            vscode.window.showErrorMessage('ESP: Failed to install pip. Try reinstalling Python 3.7.');
            log(`[pip] ensurepip failed for ${pythonCmd}`);
            return false;
        }
    }

    if (ans === 'Download Python 3.7')
        vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));

    log(`[pip] not found for ${pythonCmd}`);
    return false;
}

async function getPythonCmd(force = false, silent = false) {
    if (!force && _pythonCmd && (Date.now() - _pythonCmdTime < PYTHON_CACHE_TTL)) return _pythonCmd;

    // Helper: returns "X.Y" version string or null
    const getVersion = (cmd) => new Promise(r =>
        cp.exec(`${cmd} --version`, { timeout: 3000 }, (e, stdout, stderr) => {
            const m = (stdout + stderr).trim().match(/Python (\d+\.\d+)/);
            r(m ? m[1] : null);
        })
    );

    // Helper: cache and return found pythonCmd
    const found = async (cmd, label) => {
        // cp.exec uses cmd.exe (no &), terminal needs & prefix for quoted paths in PowerShell
        const termCmd = (IS_WIN && cmd.startsWith('"')) ? `& ${cmd}` : cmd;
        _pythonCmd     = termCmd;
        _pythonCmdTime = Date.now();
        log(`Python 3.7 detected (${label}): ${termCmd}`);
        await checkPip(cmd); // checkPip использует cp.exec — передаём без &
        return termCmd;
    };

    // Helper: show final "not found" error
    const notFound = (wrongVersion) => {
        log(`Python not found (wrongVersion=${wrongVersion})`);
        if (silent) return null;
        const msg = wrongVersion
            ? `ESP: Python ${wrongVersion} found but ESP8266 SDK requires Python 3.7.x.`
            : 'ESP: Python 3.7 not found. Install it or set the folder manually.';
        vscode.window.showWarningMessage(msg, 'Set Python 3.7 folder', 'Download Python 3.7')
            .then(ans => {
                if (ans === 'Set Python 3.7 folder')
                    vscode.commands.executeCommand('esp.setPythonPath');
                else if (ans === 'Download Python 3.7')
                    vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));
            });
        return null;
    };

    let wrongVersion = null; // first non-3.7 version seen — used in final error message

    // ── Step 1: Manual path ───────────────────────────────────────────────────
    const manualFolder = cfg('pythonPath') || '';
    if (manualFolder) {
        const manualExe = IS_WIN
            ? path.join(manualFolder, 'python.exe')
            : path.join(manualFolder, 'python3');

        if (!fs.existsSync(manualExe)) {
            const ans = await vscode.window.showWarningMessage(
                `ESP: python.exe not found in: ${manualFolder}`,
                'Fix manually', 'Try auto-detect'
            );
            if (ans !== 'Try auto-detect') {
                vscode.commands.executeCommand('esp.setPythonPath');
                return null;
            }
        } else {
            const ver = await getVersion(`"${manualExe}"`);
            if (ver && ver.startsWith('3.7')) return found(`"${manualExe}"`, 'manual');

            const problem = ver
                ? `Manual Python path has Python ${ver} (need 3.7.x)`
                : `Python not found at: ${manualFolder}`;
            const ans = await vscode.window.showWarningMessage(
                `ESP: ${problem}.`, 'Fix manually', 'Try auto-detect'
            );
            if (ans !== 'Try auto-detect') {
                vscode.commands.executeCommand('esp.setPythonPath');
                return null;
            }
            if (ver && !wrongVersion) wrongVersion = ver;
        }
        // Fall through to auto-detect
    }

    // ── Step 2: по имени напрямую ─────────────────────────────────────────────
    const nameCandidates = IS_WIN ? ['python'] : ['python3.7', 'python3', 'python'];
    for (const cmd of nameCandidates) {
        const ver = await getVersion(cmd);
        if (ver && ver.startsWith('3.7')) return found(cmd, `name:${cmd}`);
        if (ver && !wrongVersion) wrongVersion = ver;
    }

    // ── Step 3: реестр Windows ───────────────────────────────────────────────
    if (IS_WIN) {
        const regRoots = [
            'HKCU\\SOFTWARE\\Python\\PythonCore',              // user install
            'HKLM\\SOFTWARE\\Python\\PythonCore',              // system 64-bit
            'HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore', // system 32-bit
        ];
        for (const root of regRoots) {
            // Перечисляем все подключи PythonCore, фильтруем те что начинаются на 3.7
            // (может быть "3.7", "3.7-32", "3.7-64" и т.д.)
            const subkeys = await new Promise(r =>
                cp.exec(`reg query "${root}"`, { timeout: 3000 }, (e, stdout) => {
                    if (e) { r([]); return; }
                    const keys = stdout.split('\r\n')
                        .map(l => l.trim())
                        .filter(l => {
                            const last = l.split('\\').pop();
                            return last && last.startsWith('3.7');
                        });
                    r(keys);
                })
            );
            for (const subkey of subkeys) {
                // Читаем ExecutablePath — там уже готовый полный путь к python.exe
                const exePath = await new Promise(r =>
                    cp.exec(`reg query "${subkey}\\InstallPath" /v ExecutablePath`, { timeout: 3000 }, (e, stdout) => {
                        if (e) { r(null); return; }
                        const m = stdout.match(/ExecutablePath\s+REG_SZ\s+(.+)/);
                        r(m ? m[1].trim() : null);
                    })
                );
                if (!exePath || !fs.existsSync(exePath)) continue;
                const ver = await getVersion(`"${exePath}"`);
                if (ver && ver.startsWith('3.7')) return found(`"${exePath}"`, `registry:${subkey}`);
                if (ver && !wrongVersion) wrongVersion = ver;
            }
        }
    }

    // ── Step 4: сканируем PATH ────────────────────────────────────────────────
    const sep      = IS_WIN ? ';' : ':';
    const exeNames = IS_WIN ? ['python.exe'] : ['python3.7', 'python3', 'python'];
    for (const dir of (process.env.PATH || '').split(sep)) {
        if (!dir) continue;
        if (IS_WIN && dir.toLowerCase().includes('windowsapps')) continue; // MS Store stub
        if (!fs.existsSync(dir)) continue;

        for (const exe of exeNames) {
            const full = path.join(dir, exe);
            if (!fs.existsSync(full)) continue;
            const ver = await getVersion(`"${full}"`);
            if (ver && ver.startsWith('3.7')) return found(`"${full}"`, `PATH scan: ${full}`);
            if (ver && !wrongVersion) wrongVersion = ver;
        }
    }

    // ── Step 5: ничего не нашли ───────────────────────────────────────────────
    return notFound(wrongVersion);
}

// ─── Pre-flight check: Python first, then project folder ─────────────────────
// Returns true if ready. Shows appropriate error and returns false if not.
async function requireReady() {
    const pythonCmd = await getPythonCmd();
    if (!pythonCmd) return false; // getPythonCmd already showed the error
    const root = getActiveRoot();
    if (!root) {
        warnNoProject();
        return false;
    }
    return true;
}

// ─── Shared one-liner helpers ────────────────────────────────────────────────
function warnNoProject() {
    vscode.window.showErrorMessage('ESP: Select project folder!', 'Select Folder')
        .then(a => { if (a === 'Select Folder') vscode.commands.executeCommand('esp.selectProject'); });
}

// Returns pip install command parts for requirements.txt (IS_WIN aware)
function pipInstallReqsParts(idfPath, pythonCmd, reqTxt) {
    return IS_WIN
        ? [`$env:IDF_PATH=${q(idfPath)}`, `${pythonCmd} -m pip install -r ${q(reqTxt)}`]
        : [`export IDF_PATH=${q(idfPath)}`, `${pythonCmd} -m pip install -r ${q(reqTxt)}`];
}

// ─── Tools platform key (OS + arch) ──────────────────────────────────────────
function getToolsPlatform() {
    if (IS_WIN)  return os.arch() === 'x64' ? 'win64'       : 'win32';
    if (IS_MAC)  return os.arch() === 'arm64' ? 'macos-arm64' : 'macos';
    return os.arch() === 'x64' ? 'linux-amd64' : 'linux-i686';
}

// Returns manual tools path (override or config)
// Returns true if manual tools mode is active and toolsPath is set
// Read tools.json, verify each tool binary exists for current platform
// Returns { ok: bool, missing: string[], binDirs: string[] }

// ╔══════════════════════════════════════════════════════════════════╗
// ║  RTOS SDK: idf.py runner                                           ║
// ╚══════════════════════════════════════════════════════════════════╝
async function runIdf(args, termName, isBuildCommand = false, extraEnvVars = {}, chainArgs = null, onChainStart = null) {
    // Block if another command is already running
    if (checkBusy()) return;

    // ── Python check FIRST — most important for new users ────────────────────
    const pythonCmd = await getPythonCmd(true);
    if (!pythonCmd) return; // getPythonCmd already showed the error

    // ── IDF path + tools check BEFORE project folder ─────────────────────────
    const idfPath = getValidIdfPath();
    if (!idfPath) {
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid! Check extension settings.');
        return;
    }

    const toolsOk = await checkToolsOrPrompt(idfPath, pythonCmd);
    if (!toolsOk) return;
    if (!await checkPythonDeps(idfPath, pythonCmd)) return;
    // ─────────────────────────────────────────────────────────────────────────

    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    // Save all unsaved files before build commands
    if (isBuildCommand) {
        await vscode.workspace.saveAll(false);
    }

    // Verify this is a valid ESP-IDF (RTOS) project
    if (!fs.existsSync(path.join(root, 'CMakeLists.txt')) && !fs.existsSync(path.join(root, 'sdkconfig'))) {
        vscode.window.showErrorMessage('ESP: No CMakeLists.txt or sdkconfig found. Is this an ESP-IDF project?');
        return;
    }

    // Check custom partition CSV exists (if configured)
    if (!await checkPartitionCsv(root)) return;

    const envPrefix   = buildIdfEnvPrefix(idfPath, pythonCmd);
    const extraEnvCmd = buildEnvSetCmd(extraEnvVars);
    const idfPy       = path.join(idfPath, 'tools', 'idf.py');

    const quoteArg = a => {
        if (typeof a === 'string' && (a.includes(' ') || (a.includes(path.sep) && !a.startsWith('-')))) return q(a);
        return a;
    };
    const makeIdfCmd = args => `${pythonCmd} ${q(idfPy)} ${args.map(quoteArg).join(' ')}`;

    if (checkBusy()) return;
    setBusy(termName);

    const t = getTerm(termName);
    t.show(true);

    if (isBuildCommand) {
        // ── CALL 1: [clean/fullclean] build [size] [size-components] [size-files] ──
        let buildArgs = [...args];
        const preAction = cfg('preBuildAction');
        if (preAction === 'clean' || preAction === 'fullclean') {
            buildArgs.unshift(preAction);
        }
        const analysisCmds = cfg('postBuildAnalysis') || [];
        if (analysisCmds.length > 0) {
            buildArgs.push(...analysisCmds);
        }

        // ── CALL 2 (optional): flash after build ──────────────────────────────
        const postAction = cfg('postBuildAction');
        const willFlash  = postAction === 'flash' || postAction === 'app_flash';

        // Check port BEFORE starting build — so we don't waste time building
        // if the device isn't connected. runWithPostFlash is called after build success.
        if (willFlash) {
            let port = cfg('comPort');
            if (!port) { port = await cmdSelectPort(); if (!port) { clearBusy(); return; } }
            const portHolder = { port };
            const portOk = await confirmPortOrReselect(portHolder);
            if (!portOk) { clearBusy(); return; }
            if (portHolder.port !== cfg('comPort')) await setCfg('comPort', portHolder.port);
        }

        log(`[Call 1] idf.py ${buildArgs.join(' ')}`);

        const idfCmd1 = makeIdfCmd(buildArgs);

        const markerFile = path.join(os.tmpdir(), `esp_bld_${Date.now()}.tmp`);
        const markerSuffix = buildMarkerCmd(markerFile);

        // After build completes — call runWithPostFlash using Flash/Flash App settings
        watchBuildResult(markerFile, termName, root).then(exitCode => {
            if (exitCode === 0 && willFlash) {
                const flashAction = postAction === 'app_flash' ? 'app-flash' : 'flash';
                runWithPostFlash(flashAction);
            }
        }).finally(() => clearBusy());

        if (IS_WIN) {
            t.sendText([`Set-Location ${q(root)}`, envPrefix, extraEnvCmd + idfCmd1].join('; ') + markerSuffix);
        } else {
            t.sendText([`cd ${q(root)}`, envPrefix, extraEnvCmd + idfCmd1].join(' && ') + markerSuffix);
        }
        return;
    }

    // ── Non-build commands (menuconfig, size, flash standalone...) ────────────
    let finalArgs = [...args];
    const idfCmd = makeIdfCmd(finalArgs);

    const markerFile2 = path.join(os.tmpdir(), `esp_cmd_${Date.now()}.tmp`);
    const markerSuffix2 = buildMarkerCmd(markerFile2);
    watchCommandDone(markerFile2, termName).finally(() => clearBusy());

    // If chainArgs provided — run a second idf.py call after the first succeeds
    const idfCmd2 = chainArgs ? makeIdfCmd(chainArgs) : null;

    if (idfCmd2 && onChainStart) {
        // Write a chain-start marker just before the second command so we can
        // fire onChainStart (e.g. flip monitor button) at the right moment
        const chainMarker = path.join(os.tmpdir(), `esp_chain_${Date.now()}.tmp`);
        const chainStarted = Date.now();
        const CHAIN_TIMEOUT = 30 * 60 * 1000; // 30 min — same as watchCommandDone

        const chainTimer = setInterval(() => {
            // Stop polling if terminal closed or timed out — flash failed
            const termGone = !t || t.exitStatus !== undefined;
            const timedOut = Date.now() - chainStarted > CHAIN_TIMEOUT;
            if (termGone || timedOut) {
                clearInterval(chainTimer);
                try { fs.unlinkSync(chainMarker); } catch {}
                return;
            }
            if (fs.existsSync(chainMarker)) {
                clearInterval(chainTimer);
                try { fs.unlinkSync(chainMarker); } catch {}
                onChainStart();
            }
        }, 400);

        const writeChainMarker = IS_WIN
            ? `'0' | Out-File -NoNewline -Encoding ASCII ${q(chainMarker)}`
            : `echo 0 > ${q(chainMarker)}`;

        if (IS_WIN) {
            const second = `; if ($LASTEXITCODE -eq 0) { ${writeChainMarker}; ${idfCmd2} }`;
            t.sendText(`Set-Location ${q(root)}; ${envPrefix}; ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        } else {
            const second = ` && ${writeChainMarker} && ${idfCmd2}`;
            t.sendText(`cd ${q(root)} && ${envPrefix} && ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        }
    } else {
        if (IS_WIN) {
            const second = idfCmd2 ? `; if ($LASTEXITCODE -eq 0) { ${idfCmd2} }` : '';
            t.sendText(`Set-Location ${q(root)}; ${envPrefix}; ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        } else {
            const second = idfCmd2 ? ` && ${idfCmd2}` : '';
            t.sendText(`cd ${q(root)} && ${envPrefix} && ${extraEnvCmd}${idfCmd}${second}${markerSuffix2}`);
        }
    }
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  FLASH & MONITOR                                                   ║
// ╚══════════════════════════════════════════════════════════════════╝
function buildEnvSetCmd(envObj) {
    const entries = Object.entries(envObj);
    if (!entries.length) return '';
    if (IS_WIN) {
        return entries.map(([k, v]) => `$env:${k}=${q(String(v))}`).join('; ') + '; ';
    } else {
        return entries.map(([k, v]) => `export ${k}=${q(String(v))}`).join(' && ') + ' && ';
    }
}

async function runFlash(action = 'flash', eraseFirst = false) {
    if (checkBusy()) return;  // ← block immediately if build/install is running

    // ── Python check FIRST ────────────────────────────────────────────────────
    const pythonCmdFlash = await getPythonCmd(true);
    if (!pythonCmdFlash) return; // getPythonCmd already showed the error

    // ── Tools check BEFORE port ───────────────────────────────────────────────
    const idfPathFlash = getValidIdfPath();
    if (!idfPathFlash) {
        vscode.window.showErrorMessage('ESP: IDF_PATH not set or invalid! Check extension settings.');
        return;
    }
    const toolsOkFlash = await checkToolsOrPrompt(idfPathFlash, pythonCmdFlash);
    if (!toolsOkFlash) return;
    // ── Project folder check BEFORE port ─────────────────────────────────────
    const rootFlash = getActiveRoot();
    if (!rootFlash) {
        warnNoProject();
        return;
    }

    // ── Save all unsaved files before flash ──────────────────────────────────
    await vscode.workspace.saveAll(false);
    // ─────────────────────────────────────────────────────────────────────────

    const overrideFlash = cfg('overrideFlashConfig');
    let flashArgs   = [];
    let extraEnvVars = {};

    // Port check AFTER project folder verified
    let port = cfg('comPort');
    if (!port) {
        port = await cmdSelectPort();
        if (!port) return;
    }
    if (port && !/^[a-zA-Z0-9./\\\\_-]+$/.test(port)) {
        vscode.window.showErrorMessage('ESP: Invalid port name! Shell metacharacters are not allowed.');
        return;
    }

    // ── Check port is physically available before flash or monitor ────────────
    if (port) {
        const portHolder = { port };
        const ok = await confirmPortOrReselect(portHolder);
        if (!ok) return;
        port = portHolder.port;
        if (port !== cfg('comPort')) await setCfg('comPort', port);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (overrideFlash) {
        const baud        = cfg('flashBaud')           || 115200;
        const mode        = cfg('flashMode')           || 'dio';
        const freq        = cfg('flashFreq')           || '40m';
        const size        = cfg('flashSize')           || '2MB';
        const compressed  = cfg('useCompressedUpload') ?? true;
        const beforeFlash = cfg('beforeFlashing')      || 'default_reset';
        const afterFlash  = cfg('afterFlashing')       || 'hard_reset';

        flashArgs = [
            '-p', port, '-b', String(baud),
            '--flash_mode', mode, '--flash_freq', freq, '--flash_size', size,
            compressed ? '-z' : '-u',
            '--before', beforeFlash, '--after', afterFlash
        ];
    } else if (port) {
        flashArgs = ['-p', port];
    }


    const isMonitor  = action.endsWith('_monitor');
    const baseAction = isMonitor ? action.replace('_monitor', '') : action;
    let args  = [];
    let title = '';

    if (baseAction === 'monitor') {
        const monitorBaud = cfg('monitorBaud') || 74880;
        if (port) {
            args = ['-p', port, '-b', String(monitorBaud), 'monitor'];
        } else {
            args = ['monitor'];
        }
        title = 'ESP › Monitor';
    } else {
        // erase_flash + flash → always combined in one idf.py call
        args = eraseFirst
            ? [...flashArgs, 'erase_flash', baseAction]
            : [...flashArgs, baseAction];
        const humanAction = baseAction.replace(/-/g, ' ').replace(/_/g, ' ');
        title = `ESP › ${eraseFirst ? 'Erase & ' : ''}${humanAction.charAt(0).toUpperCase() + humanAction.slice(1)}`;

        if (isMonitor) {
            title += ' & Monitor';
        }
    }

    if (baseAction === 'monitor') {
        // Standalone monitor — flip button immediately
        _monitorRunning = true;
        refreshMonitorButton();
    }

    // Monitor always runs as a separate idf.py call after flash completes
    let monitorChainArgs = null;
    let onChainStart = null;
    if (isMonitor) {
        const monitorBaud = cfg('monitorBaud') || 74880;
        monitorChainArgs = port
            ? ['-p', port, '-b', String(monitorBaud), 'monitor']
            : ['monitor'];
        // Flip monitor button only when flash is done and monitor actually starts
        onChainStart = () => { _monitorRunning = true; refreshMonitorButton(); };
    }

    // ── Check flasher_args.json — idf.py erase_flash / flash needs it ────────
    // If missing, run reconfigure first (generates build files), then flash/erase.
    // Note: monitor chain is dropped in this case — user can run it manually after.
    const flasherArgsJson = path.join(rootFlash, 'build', 'flasher_args.json');
    if (!fs.existsSync(flasherArgsJson) && baseAction !== 'monitor') {
        vscode.window.showInformationMessage(
            'ESP: build/flasher_args.json not found — running reconfigure first.'
        );
        await runIdf(['reconfigure'], `ESP › Reconfigure → ${title.replace('ESP › ','')}`,
            false, {}, args, onChainStart);
        return;
    }

    await runIdf(args, title, false, extraEnvVars, monitorChainArgs, onChainStart);
}

async function runWithPostFlash(action) {
    const postAction       = cfg('postFlashAction');
    const eraseBeforeFlash = cfg('eraseBeforeFlash') ?? false;

    const finalAction = (postAction === 'monitor' && !action.endsWith('_monitor'))
        ? action + '_monitor'
        : action;

    return runFlash(finalAction, eraseBeforeFlash);
}

function cmdStopMonitor() {
    clearBusy(); // release lock when user manually stops monitor
    const monitorTermNames =['ESP › Monitor', 'ESP › Flash & Monitor', 'ESP › flash monitor & Monitor'];
    let found = false;
    for (const name of monitorTermNames) {
        const t = terms[name];
        if (t && t.exitStatus === undefined) {
            t.sendText('\x1d', false);
            log(`Sent Ctrl+] to terminal: ${name}`);
            found = true;
        }
    }
    if (!found) {
        vscode.window.showWarningMessage('ESP: No active monitor terminal found.');
    }
    _monitorRunning = false;
    refreshMonitorButton();
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  HOTPLUG: Port Detection                                           ║
// ╚══════════════════════════════════════════════════════════════════╝
// ─── Full environment check: python → sdk → tools ──────────────────────
// Shows warnings in tree AND one-time popup dialog
// silent=true: only update tree warnings, no popups
// ─── RTOS SDK structure check ────────────────────────────────────────────────
// Returns array of missing paths. Empty = all good.
function checkRtosSdkStructure(idfPath) {
    if (!idfPath) return [];
    const missing = [];
    const chk = (rel, isDir) => {
        const full = path.join(idfPath, ...rel.split('/'));
        if (!fs.existsSync(full)) missing.push(rel + (isDir ? '/' : ''));
    };
    // folders
    chk('components',              true);
    chk('tools',                   true);
    chk('tools/cmake',             true);
    chk('tools/kconfig_new',       true);
    // files
    chk('CMakeLists.txt',          false);
    chk('Kconfig',                 false);
    chk('requirements.txt',        false);
    chk('tools/idf_tools.py',      false);
    chk('tools/idf.py',            false);
    chk('tools/tools.json',        false);
    chk('tools/tools_schema.json', false);
    chk('tools/check_python_dependencies.py', false);
    return missing;
}

async function checkEnvironment(silent = false) {
    const warnings = [];

    // 1. Check Python 3.7 (first — most important for beginners)
    const pythonCmd = await getPythonCmd(true, silent); // force — silent on startup
    if (!pythonCmd) {
        warnings.push({
            label: '⚠️ Python 3.7 not found',
            tooltip: 'Python 3.7 is required for ESP8266 SDK\nClick to download Python 3.7',
            command: 'esp.fixPython',
        });
    }


    // 2. Check RTOS SDK structure (if configured)
    const idfPathForCheck = getValidIdfPath();
    if (idfPathForCheck) {
        const sdkMissing = checkRtosSdkStructure(idfPathForCheck);
        if (sdkMissing.length > 0) {
            warnings.push({
                label:   '⚠️ RTOS SDK: missing required files',
                tooltip: 'Required files/folders not found in RTOS SDK:\n' + sdkMissing.map(f => '  • ' + f).join('\n') + '\nClick to re-select SDK folder',
                command: 'esp.fixSdk',
            });
        }
    }

    // Update tree warnings
    if (provider) provider.setEnvWarnings(warnings);

    if (warnings.length === 0) return true;

    // Show popup only if not silent
    if (!silent) {
        const firstWarning = warnings[0];
        const label = firstWarning.label.replace('⚠️ ', '');
        const ans = await vscode.window.showErrorMessage(
            `ESP-IDF: ${label}. See sidebar for details.`,
            'Fix Now'
        );
        if (ans === 'Fix Now') {
            vscode.commands.executeCommand(firstWarning.command);
        }
    }

    return false;
}

// ─── Fix commands triggered from tree warnings ────────────────────────────────

async function cmdFixPython() {
    vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));
}

async function cmdFixSdk() {
    const cfgKey  = 'idfPath';
    const sdkName = 'RTOS SDK';
    const envVar  = 'IDF_PATH';

    const action = await new Promise(resolve => {
        const qp = vscode.window.createQuickPick();
        qp.title       = `ESP8266: Setup ${sdkName}`;
        qp.placeholder = 'How do you want to set up the SDK?';
        qp.ignoreFocusOut = true;
        qp.items = [
            { label: '$(folder-opened) Select existing SDK folder', description: 'Already downloaded — just point to it', value: 'set'   },
            { label: '$(x) Reset',                                  description: `Use ${envVar} environment variable`,    value: 'reset' },
        ];
        qp.buttons = [{
            iconPath: new vscode.ThemeIcon('info'),
            tooltip:  `Show expected ${sdkName} folder structure`
        }];
        qp.onDidTriggerButton(async () => {
            const msg = [
                    `📁 ESP8266_RTOS_SDK\\`,
                    `├── components\\    ← required`,
                    `├── tools\\         ← required`,
                    `├── CMakeLists.txt  ← required`,
                    `├── Kconfig         ← required`,
                    `└── requirements.txt ← required`,
                    ``,
                    `Download:`,
                    `  github.com/espressif/ESP8266_RTOS_SDK`,
                  ].join('\n');
            const btn = await vscode.window.showInformationMessage(
                `Expected ${sdkName} folder structure`,
                { modal: true, detail: msg },
                'Copy to Clipboard', 'OK'
            );
            if (btn === 'Copy to Clipboard') vscode.env.clipboard.writeText(msg);
        });
        qp.onDidAccept(() => { const sel = qp.selectedItems[0]; qp.hide(); resolve(sel || null); });
        qp.onDidHide(()  => resolve(null));
        qp.show();
    });
    if (!action) return;

    // ── Reset ──────────────────────────────────────────────────────────────────
    if (action.value === 'reset') {
        await setCfg(cfgKey, '');
        vscode.window.showInformationMessage(`ESP: ${sdkName} reset → using ${envVar} from environment`);
        return;
    }

    // ── Set existing folder ────────────────────────────────────────────────────
    if (action.value === 'set') {
        const folder = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false,
            openLabel: `Select ${sdkName} folder`
        });
        if (!folder?.[0]) return;
        const selected = folder[0].fsPath;

        // Validate RTOS SDK structure
        const missing = checkRtosSdkStructure(selected);
        if (missing.length) {
            const ok = await vscode.window.showWarningMessage(
                `Required files not found — this does not look like a valid RTOS SDK. Use anyway?`,
                { modal: true, detail: `Missing:\n${missing.map(f => `  • ${f}`).join('\n')}` },
                'Yes', 'Cancel'
            );
            if (ok !== 'Yes') return;
        }
        await setCfg(cfgKey, selected);
        ensureVersionTxt(selected); _pythonCmd = null; _toolsVerified = false;
        provider.refresh();
        vscode.window.showInformationMessage(`✅ ${sdkName} → ${selected}`);
        checkEnvironment(true);
        checkAndInstallTools();
        return;
    }
}

// ─── Check tools before command, prompt to install if missing ────────────────
// Returns true if tools are ready, false if missing (user must install first)
async function checkToolsOrPrompt(idfPath, pythonCmd) {
    // Fast path — already verified this session (reset on SDK/Python change)
    if (_toolsVerified) return true;

    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (!fs.existsSync(idfToolsPy)) { _toolsVerified = true; return true; } // can't check — allow command

    return new Promise(resolve => {
        cp.exec(
            `${toExecCmd(pythonCmd)} "${idfToolsPy}" check`,
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (err, stdout, stderr) => {
                const toolsMissing = err || (stderr && stderr.includes('ERROR:'));
                if (!toolsMissing) {
                    _toolsVerified = true;
                    resolve(true);
                    return;
                }

                // Parse which tools are missing from idf_tools.py check output
                // Format: "ERROR: The following required tools were not found: mconf ninja idf-exe mkspiffs"
                const combined = (stdout || '') + (stderr || '');
                const match = combined.match(/ERROR:\s+The following required tools were not found:\s*(.+)/i);
                const missingList = match ? match[1].trim() : '';
                const detail = missingList
                    ? `Missing tools: ${missingList}`
                    : 'Run "Install Tools" to set up the build environment.';

                // Tools missing — show blocking prompt
                const ans = await vscode.window.showErrorMessage(
                    missingList
                        ? `⚠️ ESP-IDF: Build tools not found (${missingList}). Install them first?`
                        : '⚠️ ESP-IDF: Build tools are not installed. Install them first?',
                    'Install Now', 'Cancel'
                );

                if (ans === 'Install Now') {
                    // Verify Python still available before starting install
                    const freshPython = await getPythonCmd(true);
                    if (!freshPython) {
                        const a = await vscode.window.showErrorMessage(
                            'ESP: Python not found! Please install Python 3.7 first.',
                            'Download Python 3.7'
                        );
                        if (a === 'Download Python 3.7') {
                            vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/release/python-379/'));
                        }
                        resolve(false);
                        return;
                    }

                    const t = getTerm('ESP › Install Tools');
                    t.show(true);
                    setBusy('Installing Tools');

                    const markerFile = path.join(os.tmpdir(), `esp_install_${Date.now()}.tmp`);
                    const reqTxt = path.join(idfPath, 'requirements.txt');

                    // Block if pip missing — no point running install without it
                    const pipOk = await checkPip(freshPython);
                    if (!pipOk) { clearBusy(); resolve(false); return; }

                    const parts = IS_WIN
                        ? [`$env:IDF_PATH=${q(idfPath)}`, `${pythonCmd} ${q(idfToolsPy)} install`,
                           ...(fs.existsSync(reqTxt) ? [`${pythonCmd} -m pip install -r ${q(reqTxt)}`] : [])]
                        : [`export IDF_PATH=${q(idfPath)}`, `${pythonCmd} ${q(idfToolsPy)} install`,
                           ...(fs.existsSync(reqTxt) ? [`${pythonCmd} -m pip install -r ${q(reqTxt)}`] : [])];
                    t.sendText(buildCmd(parts) + buildMarkerCmd(markerFile));

                    watchCommandDone(markerFile, 'ESP › Install Tools').then(() => {
                        _toolsVerified = true; // ✅ mark as verified after successful install
                        clearBusy();
                        vscode.window.showInformationMessage('✅ ESP-IDF tools installed! You can now run Build.');
                    });
                }
                resolve(false); // block the command regardless — install or cancel
            }
        );
    });
}

// ─── Resolve bundled spiffsgen.py path ───────────────────────────────────────
function getSpiffsgenScript() {
    return path.join(globalCtx.extensionPath, 'scripts', 'spiffsgen.py');
}

// ─── Check python deps before each command ───────────────────────────────────
// Returns true if OK, false if user skipped (command should abort)
async function checkPythonDeps(idfPath, pythonCmd) {
    if (!idfPath || !pythonCmd) return true; // can't check — allow command
    const checkDepsPy = path.join(idfPath, 'tools', 'check_python_dependencies.py');
    if (!fs.existsSync(checkDepsPy)) return true; // no script — allow command
    const pyExec = pythonCmd.replace(/^& /, '').replace(/'/g, '');
    return new Promise(resolve => {
        cp.exec(
            `"${pyExec}" "${checkDepsPy}"`,
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (depErr) => {
                if (!depErr) { resolve(true); return; }
                const ans = await vscode.window.showWarningMessage(
                    'ESP-IDF: Python requirements not satisfied. Install now?',
                    'Install', 'Skip'
                );
                if (ans === 'Install') {
                    const reqTxt = path.join(idfPath, 'requirements.txt');
                    const t2 = getTerm('ESP › Install Requirements');
                    t2.show(true);
                    setBusy('Installing requirements');
                    const markerFile = path.join(os.tmpdir(), `esp_req_${Date.now()}.tmp`);
                    const parts = pipInstallReqsParts(idfPath, pythonCmd, reqTxt);
                    t2.sendText(buildCmd(parts) + buildMarkerCmd(markerFile));
                    watchCommandDone(markerFile, 'ESP › Install Requirements').then(() => {
                        clearBusy();
                        vscode.window.showInformationMessage('✅ Python requirements installed!');
                    });
                }
                resolve(false); // abort command — let user install first
            }
        );
    });
}

async function checkAndInstallTools(silent = true) {
    // Use getValidIdfPath() so env var IDF_PATH is also considered
    const idfPath = getValidIdfPath();
    if (!idfPath) return;

    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (!fs.existsSync(idfToolsPy)) return;

    const pythonCmd = await getPythonCmd(false, silent); // silent on startup, loud on Refresh
    if (!pythonCmd) return;

    return new Promise(resolve => {
        cp.exec(
            `${toExecCmd(pythonCmd)} "${idfToolsPy}" check`,
            { env: { ...process.env, IDF_PATH: idfPath } },
            async (err, stdout, stderr) => {
                const toolsMissing = err || (stderr && stderr.includes('ERROR:'));
                if (toolsMissing) {
                    // Parse which tools are missing
                    // Format: "ERROR: The following required tools were not found: mconf ninja idf-exe mkspiffs"
                    const combined = (stdout || '') + (stderr || '');
                    const match = combined.match(/ERROR:\s+The following required tools were not found:\s*(.+)/i);
                    const missingList = match ? match[1].trim() : '';
                    const msg = missingList
                        ? `ESP-IDF: Required build tools not found (${missingList}). Install now?`
                        : 'ESP-IDF: Required build tools are not installed. Install now?';

                    const ans = await vscode.window.showInformationMessage(msg, 'Install', 'Cancel');
                    if (ans === 'Install') {
                        // Block if pip missing
                        const pipOk = await checkPip(pythonCmd);
                        if (!pipOk) { clearBusy(); resolve(); return; }

                        const t = getTerm('ESP › Install Tools');
                        t.show(true);

                        // Lock all commands while installing
                        setBusy('Installing Tools');

                        const markerFile = path.join(os.tmpdir(), `esp_install_${Date.now()}.tmp`);
                        const marker = buildMarkerCmd(markerFile);

                        const reqTxt = path.join(idfPath, 'requirements.txt');
                        const parts = IS_WIN
                            ? [`$env:IDF_PATH=${q(idfPath)}`, `${pythonCmd} ${q(idfToolsPy)} install`,
                               ...(fs.existsSync(reqTxt) ? [`${pythonCmd} -m pip install -r ${q(reqTxt)}`] : [])]
                            : [`export IDF_PATH=${q(idfPath)}`, `${pythonCmd} ${q(idfToolsPy)} install`,
                               ...(fs.existsSync(reqTxt) ? [`${pythonCmd} -m pip install -r ${q(reqTxt)}`] : [])];
                        t.sendText(buildCmd(parts) + marker);

                        // Watch for completion and unlock
                        watchCommandDone(markerFile, 'ESP › Install Tools').then(() => {
                            clearBusy();
                            vscode.window.showInformationMessage('✅ ESP-IDF tools installed successfully!');
                        });
                    }
                } else {
                    // ── Tools OK — check Python requirements ─────────────────
                    // Use SDK's own check_python_dependencies.py with IDF_PATH set
                    const checkDepsPy = path.join(idfPath, 'tools', 'check_python_dependencies.py');
                    const reqTxt2     = path.join(idfPath, 'requirements.txt');
                    if (fs.existsSync(checkDepsPy)) {
                        // check_python_dependencies.py: double quotes required (cmd.exe)
                        const pyExec  = pythonCmd.replace(/^& /, '').replace(/'/g, '');
                        cp.exec(
                            `"${pyExec}" "${checkDepsPy}"`,
                            { env: { ...process.env, IDF_PATH: idfPath } },
                            async (depErr) => {
                                if (depErr) {
                                    const ans = await vscode.window.showWarningMessage(
                                        'ESP-IDF: Python requirements not satisfied. Install now?',
                                        'Install', 'Skip'
                                    );
                                    if (ans === 'Install') {
                                        const t2 = getTerm('ESP › Install Requirements');
                                        t2.show(true);
                                        setBusy('Installing requirements');
                                        const markerFile2 = path.join(os.tmpdir(), `esp_req_${Date.now()}.tmp`);
                                        const parts2 = pipInstallReqsParts(idfPath, pythonCmd, reqTxt2);
                                        t2.sendText(buildCmd(parts2) + buildMarkerCmd(markerFile2));
                                        watchCommandDone(markerFile2, 'ESP › Install Requirements').then(() => {
                                            clearBusy();
                                            vscode.window.showInformationMessage('✅ Python requirements installed!');
                                        });
                                    }
                                }
                                resolve();
                            }
                        );
                    } else {
                        resolve();
                    }
                    return;
                }
                resolve();
            }
        );
    });
}

// ─── Global busy lock ────────────────────────────────────────────────────────
function setBusy(name) {
    _globalBusy     = true;
    _globalBusyName = name;
    vscode.commands.executeCommand('setContext', 'esp.busy', true);
    if (_statusBarBusy) {
        _statusBarBusy.text            = `$(sync~spin) ESP: ${name}`;
        _statusBarBusy.tooltip         = `ESP: running — ${name}\nAll commands are locked until finished\nClick to open terminal`;
        _statusBarBusy.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        _statusBarBusy.show();
    }
    log(`[BUSY] locked by: ${name}`);
}

function clearBusy() {
    _globalBusy     = false;
    _globalBusyName = '';
    vscode.commands.executeCommand('setContext', 'esp.busy', false);
    if (_statusBarBusy) {
        _statusBarBusy.hide();
        _statusBarBusy.backgroundColor = undefined;
    }
    log('[BUSY] released');
}

function checkBusy() {
    if (_globalBusy) {
        vscode.window.showWarningMessage(
            `ESP: "${_globalBusyName}" is running. Wait for it to finish.`,
            'Show Terminal'
        ).then(c => { if (c === 'Show Terminal') vscode.commands.executeCommand('workbench.action.terminal.focus'); });
        return true;
    }
    return false;
}

// ─── Status Bar ───────────────────────────────────────────────────────────────
function createStatusBar(ctx) {
    // Busy indicator — priority 106 → leftmost
    _statusBarBusy = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 106);
    _statusBarBusy.command = 'workbench.action.terminal.focus';
    ctx.subscriptions.push(_statusBarBusy);

    // Build button — priority 105
    _statusBarBuild = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    _statusBarBuild.text    = '$(tools) Build';
    _statusBarBuild.tooltip = 'ESP: Build project (idf.py build)';
    _statusBarBuild.command = 'esp.build';
    _statusBarBuild.show();
    ctx.subscriptions.push(_statusBarBuild);

    // Flash button — priority 104
    _statusBarFlash = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    _statusBarFlash.text    = '$(zap) Flash';
    _statusBarFlash.tooltip = 'ESP: Flash project (idf.py flash)';
    _statusBarFlash.command = 'esp.flash';
    _statusBarFlash.show();
    ctx.subscriptions.push(_statusBarFlash);

    // Clean button — priority 103
    _statusBarClean = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    _statusBarClean.text    = '$(trash) Clean';
    _statusBarClean.tooltip = 'ESP: Clean build output (idf.py clean)';
    _statusBarClean.command = 'esp.clean';
    _statusBarClean.show();
    ctx.subscriptions.push(_statusBarClean);

    // Monitor toggle button — priority 102
    _statusBarMonitor = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    refreshMonitorButton();
    ctx.subscriptions.push(_statusBarMonitor);

    // Port — priority 101 → last
    _statusBarPort = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    _statusBarPort.command = 'esp.selectPort';
    ctx.subscriptions.push(_statusBarPort);

    refreshStatusBar();
}

function refreshMonitorButton() {
    if (!_statusBarMonitor) return;
    if (_monitorRunning) {
        _statusBarMonitor.text            = '$(debug-stop) Monitor';
        _statusBarMonitor.tooltip         = 'Stop Monitor';
        _statusBarMonitor.command         = 'esp.stopMonitor';
        _statusBarMonitor.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        _statusBarMonitor.text            = '$(terminal) Monitor';
        _statusBarMonitor.tooltip         = 'Start Monitor\nidf.py monitor';
        _statusBarMonitor.command         = 'esp.monitor';
        _statusBarMonitor.backgroundColor = undefined;
    }
    _statusBarMonitor.show();
    if (provider) provider.refresh();
}

function refreshStatusBar() {
    if (!_statusBarPort) return;
    const port          = cfg('comPort');
    const overrideFlash = cfg('overrideFlashConfig');
    const modeLabel     = overrideFlash ? 'Manual' : 'Menuconfig';
    if (port) {
        _statusBarPort.text            = `$(plug) ${port}`;
        _statusBarPort.tooltip         = `ESP port: ${port} [${modeLabel} mode]\nClick to change port`;
        _statusBarPort.backgroundColor = undefined;
    } else {
        _statusBarPort.text            = `$(plug) No port`;
        _statusBarPort.tooltip         = `ESP: No port selected  [${modeLabel} mode]\nClick to select port`;
        _statusBarPort.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    _statusBarPort.show();
}

// ─── Compiler path detection for IntelliSense ────────────────────────────────
function findXtensaGcc() {
    const espressifTools = path.join(os.homedir(), '.espressif', 'tools');
    const xtensaRoot = path.join(espressifTools, 'xtensa-lx106-elf');
    if (!fs.existsSync(xtensaRoot)) return '';
    try {
        const gccBin = IS_WIN ? 'xtensa-lx106-elf-gcc.exe' : 'xtensa-lx106-elf-gcc';
        const versions = fs.readdirSync(xtensaRoot)
            .filter(d => fs.statSync(path.join(xtensaRoot, d)).isDirectory())
            .sort().reverse();
        for (const ver of versions) {
            const candidate = path.join(xtensaRoot, ver, 'bin', gccBin);
            if (fs.existsSync(candidate)) { log(`Found xtensa gcc: ${candidate}`); return candidate; }
        }
    } catch { /* ignore */ }
    return '';
}

// ─── Terminal management ──────────────────────────────────────────────────────
function getTerm(name) {
    const reuse = cfg('reuseTerminal');
    if (reuse && terms[name] && terms[name].exitStatus === undefined) {
        return terms[name];
    }
    if (terms[name]) {
        try { terms[name].dispose(); } catch {}
        delete terms[name];
    }
    const shellPath = getUserShell();
    const options = { name, shellPath };
    if (IS_WIN && shellPath.toLowerCase().includes('powershell') && cfg('useExecutionPolicyBypass')) {
        options.shellArgs = ['-ExecutionPolicy', 'Bypass', '-NoLogo', '-NoProfile'];
    }
    const t = vscode.window.createTerminal(options);
    terms[name] = t;
    return t;
}

function buildCmd(parts) {
    return IS_WIN ? parts.join('; ') : parts.join(' && ');
}

// ─── Create version.txt if missing or content invalid ────────────────────────
// idf_tools.py parses it with: re.search(r'v([0-9]+\.[0-9]+).*', content)
// So valid content must start with e.g. "v5.1" or "v3.2.1"
function ensureVersionTxt(idfPath) {
    if (!idfPath || !fs.existsSync(idfPath)) return;
    const versionFile = path.join(idfPath, 'version.txt');

    let needsWrite = false;
    if (!fs.existsSync(versionFile)) {
        needsWrite = true;
    } else {
        // Read first 16 bytes — enough to check format
        const head = fs.readFileSync(versionFile, 'utf8').slice(0, 16).trim();
        // Valid if matches idf_tools.py regex: v<digits>.<digits>
        needsWrite = !/^v\d+\.\d+/.test(head);
    }

    if (needsWrite) {
        try {
            fs.writeFileSync(versionFile, 'v5.1');
            log(`[version.txt] Written 'v5.1' to: ${versionFile}`);
        } catch (e) {
            log(`[version.txt] Failed to write: ${e.message}`);
        }
    }
}

// ─── IDF env prefix ───────────────────────────────────────────────────────────
function buildIdfEnvPrefix(idfPath, pythonCmd) {
    const py = pythonCmd || (IS_WIN ? 'python' : 'python3');
    const idfToolsPy = path.join(idfPath, 'tools', 'idf_tools.py');
    if (IS_WIN) {
        return [
            `$env:IDF_PATH=${q(idfPath)}`,
            `try { ${py} ${q(idfToolsPy)} export --format key-value 2>$null | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object { $k,$v = $_ -split '=',2; if ($k -eq 'PATH') { $env:PATH = ($v -replace [regex]::Escape('%PATH%'), $env:PATH) } else { Set-Item "Env:$k" $v } } } catch {}`,
        ].join('; ');
    } else {
        return `export IDF_PATH=${q(idfPath)}; eval $(${py} ${q(idfToolsPy)} export --format shell 2>/dev/null) 2>/dev/null || true;`;
    }
}

// ─── Build notifications via marker file ─────────────────────────────────────
// Lightweight watcher — just resolves/clearBusy when terminal command finishes
function watchCommandDone(markerFile, termName) {
    return new Promise(resolve => {
        const started   = Date.now();
        const maxWaitMs = 30 * 60 * 1000; // 30 min safety cap
        const timer = setInterval(() => {
            // Terminal was closed — release immediately
            if (!terms[termName] || terms[termName].exitStatus !== undefined) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                resolve(); clearBusy(); return;
            }
            // Timeout
            if (Date.now() - started > maxWaitMs) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                log(`[BUSY] command watcher timed out: ${termName}`);
                resolve(); clearBusy(); return;
            }
            // Marker appeared — command finished
            if (fs.existsSync(markerFile)) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                resolve(); clearBusy();
                // Auto-refresh partition editor if menuconfig just finished
                if (_pushSdkconfigUpdate && termName === 'ESP › Menuconfig') {
                    setTimeout(() => { try { _pushSdkconfigUpdate(); } catch {} }, 300);
                }
            }
        }, 400);
    });
}

function watchBuildResult(markerFile, taskName, root) {
    const started   = Date.now();
    const maxWaitMs = 15 * 60 * 1000;
    return new Promise(resolve => {
    const timer = setInterval(() => {
        if (!terms[taskName] || terms[taskName].exitStatus !== undefined) {
            clearInterval(timer);
            try { fs.unlinkSync(markerFile); } catch {}
            resolve(); return;
        }
        if (!fs.existsSync(markerFile)) {
            if (Date.now() - started > maxWaitMs) {
                clearInterval(timer);
                try { fs.unlinkSync(markerFile); } catch {}
                log(`Build marker timed out: ${markerFile}`);
                resolve();
            }
            return;
        }
        clearInterval(timer);
        let _exitCode = -1;
        try {
            _exitCode = parseInt(fs.readFileSync(markerFile, 'utf8').trim(), 10);
            try { fs.unlinkSync(markerFile); } catch {}
            if (_exitCode === 0) {
                const cc = root ? path.join(root, 'build', 'compile_commands.json') : null;
                const hasCc = cc && fs.existsSync(cc);
                const hint = hasCc ? ' IntelliSense updated.' : '';
                vscode.window.showInformationMessage(`✅ ${taskName} completed.${hint}`);
                log(`${taskName} ✅ OK`);

            } else {
                vscode.window.showErrorMessage(
                    `❌ ${taskName} failed (exit ${_exitCode})`, 'Show Output'
                ).then(c => { if (c === 'Show Output') outputChannel?.show(true); });
                log(`${taskName} ❌ failed (exit ${_exitCode})`);
            }
        } catch (e) {
            log(`Build marker read error: ${e.message}`);
        }
        resolve(_exitCode);
    }, 400);
    });
}

function buildMarkerCmd(markerFile) {
    if (IS_WIN) {
        return `; if ($LASTEXITCODE -eq 0) { '0' | Out-File -NoNewline -Encoding ASCII ${q(markerFile)} } else { '1' | Out-File -NoNewline -Encoding ASCII ${q(markerFile)} }`;
    } else {
        return `; _r=$?; echo $_r > ${q(markerFile)}; [ $_r -eq 0 ]`;
    }
}

// ─── Set Python 3.7 path (Manual Toolpath Settings) ──────────────────────────
async function cmdSetPythonPath() {
    const current = cfg('pythonPath') || '';
    const items = [
        {
            label: '$(search)  Auto-detect',
            description: 'Search automatically via PATH / Python Launcher',
            value: 'auto'
        },
        {
            label: '$(folder)  Select folder...',
            description: current ? `Current: ${current}` : 'Specify Python 3.7 installation folder',
            value: 'folder'
        }
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'ESP-IDF Tools › Python 3.7 Path',
        placeHolder: current ? `Manual: ${current}` : 'Currently: auto-detect',
        ignoreFocusOut: true,
    });
    if (!picked) return;

    if (picked.value === 'auto') {
        await setCfg('pythonPath', '');
        _pythonCmd = null; _toolsVerified = false;
        if (provider) provider.refresh();
        vscode.window.showInformationMessage('ESP: Python path reset to auto-detect.');
        checkEnvironment(true);
        return;
    }

    const uris = await vscode.window.showOpenDialog({
        title: 'Select folder containing python.exe (e.g. C:\\Python37-32)',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Python 3.7 folder',
    });
    if (!uris || !uris.length) return;

    const folder = uris[0].fsPath;
    await setCfg('pythonPath', folder);
    _pythonCmd = null; _toolsVerified = false;
    if (provider) provider.refresh();
    vscode.window.showInformationMessage(`ESP: Python 3.7 path set to: ${folder}`);
    // Validate the selected folder: check version + pip
    const exePath = IS_WIN ? path.join(folder, 'python.exe') : path.join(folder, 'python3');
    const verCheck = await new Promise(r =>
        cp.exec(`"${exePath}" --version`, { timeout: 3000 }, (e, so, se) => {
            const m = (so + se).match(/Python (\d+\.\d+)/);
            r(m ? m[1] : null);
        })
    );
    if (!verCheck || !verCheck.startsWith('3.7')) {
        vscode.window.showWarningMessage(
            verCheck
                ? `ESP: Python ${verCheck} found in selected folder. Need 3.7.x!`
                : `ESP: python.exe not found in: ${folder}`
        );
    } else {
        await checkPip(`"${exePath}"`); // warn if pip missing
    }
    checkEnvironment(true);
}

// ─── Activation ──────────────────────────────────────────────────────────────

// ╔══════════════════════════════════════════════════════════════════╗
// ║  SIDEBAR: TreeItem classes + TreeDataProvider                      ║
// ╚══════════════════════════════════════════════════════════════════╝
class EspItem extends vscode.TreeItem {
    constructor(label, opts = {}) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command     = opts.command ? { command: opts.command, title: label } : undefined;
        this.iconPath    = opts.icon
            ? new vscode.ThemeIcon(opts.icon, opts.iconColor ? new vscode.ThemeColor(opts.iconColor) : undefined)
            : undefined;
        this.description = opts.desc   || '';
        this.tooltip     = opts.tooltip || label;
        if (opts.contextValue) this.contextValue = opts.contextValue;
        if (opts._compName)    this._compName    = opts._compName;
    }
}

class EspGroup extends vscode.TreeItem {
    constructor(id, label, children, contextValue = undefined, defaultState = vscode.TreeItemCollapsibleState.Collapsed) {
        let state = defaultState;
        if (globalCtx) {
            const saved = globalCtx.workspaceState.get(`espGroupState_${id}`);
            if (saved !== undefined) state = saved;
        }
        super(label, state);
        this.id = id;
        this._children = children;
        if (contextValue) this.contextValue = contextValue;
    }
}

class EspProvider {
    constructor() {
        this._emitter    = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
        this.envWarnings = [];
    }
    refresh()                 { this._emitter.fire(undefined); }
    setEnvWarnings(warnings)  { this.envWarnings = warnings; this.refresh(); }
    getTreeItem(el)           { return el; }

    getChildren(el) {
        if (el instanceof EspGroup) return el._children;
        if (el) return [];

        const root          = getActiveRoot();
        const port          = cfg('comPort') || '—';
        const configuredIdf = expandHome(cfg('idfPath'));
        const validIdf      = getValidIdfPath();
        const folders       = vscode.workspace.workspaceFolders || [];
        const projectName   = root ? path.basename(root) : 'folder not found';

        const projectGroup = new EspGroup('projectGroup', '📁  Project Folder', [
            new EspItem(projectName, {
                command: 'esp.selectProject',
                icon:    root ? (folders.length > 1 ? 'folder-active' : 'folder') : 'error',
                tooltip: root || 'Select project workspace folder',
                desc:    root ? (folders.length > 1 ? 'click to change' : '') : 'click to select',
            }),
            ...( (() => {
                if (!root) return [];
                const compDir = path.join(root, 'components');
                const comps = fs.existsSync(compDir)
                    ? fs.readdirSync(compDir).filter(n => fs.statSync(path.join(compDir, n)).isDirectory())
                    : [];
                const compItems = comps.map(name => {
                    const item = new EspItem(name, {
                        icon:    'package',
                        tooltip: `Component: ${name}\n${path.join(compDir, name)}`,
                    });
                    item.contextValue = 'componentItem';
                    item._compName = name;
                    return item;
                });
                const compGroup = new EspGroup('componentsGroup', '📦  Components', compItems, undefined,
                    vscode.TreeItemCollapsibleState.Expanded);
                compGroup.contextValue = 'componentsGroup';
                return [ compGroup ];
            })() )
        ]);
        projectGroup.contextValue = root ? 'projectFolderGroupActive' : 'projectFolderGroup';

        const createProjectItem = new EspItem('Create New Project', {
            command: 'esp.createProject',
            icon: 'new-folder',
            tooltip: 'Create a new ESP8266 project from template'
        });

        const overrideFlash = cfg('overrideFlashConfig');
        const flashBaud   = cfg('flashBaud')            || 115200;
        const flashMode   = cfg('flashMode')            || 'dio';
        const flashFreq   = cfg('flashFreq')            || '40m';
        const flashSize   = cfg('flashSize')            || '2MB';
        const compressed  = cfg('useCompressedUpload')  ?? true;
        const beforeFlash = cfg('beforeFlashing')       || 'default_reset';
        const afterFlash  = cfg('afterFlashing')        || 'hard_reset';
        const monitorBaud = cfg('monitorBaud')          || 74880;

        let idfLabel   = 'not set';
        let idfDesc    = 'click to specify';
        let idfTooltip = 'Click to specify ESP8266_RTOS_SDK folder';

        if (validIdf) {
            idfLabel   = path.basename(validIdf);
            idfTooltip = validIdf;
            idfDesc    = configuredIdf ? '' : '(from environment)';
        } else if (configuredIdf) {
            idfLabel   = path.basename(configuredIdf);
            idfDesc    = 'error (invalid path)';
            idfTooltip = 'tools/idf_tools.py not found';
        }

        const manualSettings = [
            new EspItem(`Port: ${port}`,                             { command: 'esp.selectPort',           icon: 'plug',            tooltip: 'Click to select port', desc: port === '—' ? 'not selected' : '' }),
            new EspItem(`Baud rate: ${flashBaud}`,                   { command: 'esp.selectFlashBaud',      icon: 'dashboard',       tooltip: 'Flash speed' }),
            new EspItem(`Flash Mode: ${flashMode}`,                  { command: 'esp.selectFlashMode',      icon: 'chip',            tooltip: 'SPI Flash mode' }),
            new EspItem(`Flash Freq: ${flashFreq}`,                  { command: 'esp.selectFlashFreq',      icon: 'pulse',           tooltip: 'SPI Flash frequency' }),
            new EspItem(`Flash Size: ${flashSize}`,                  { command: 'esp.selectFlashSize',      icon: 'database',        tooltip: 'SPI Flash size' }),
            new EspItem(`Compression: ${compressed ? 'Yes' : 'No'}`, { command: 'esp.toggleCompressedUpload', icon: 'file-zip',      tooltip: 'Use compression when flashing' }),
            new EspItem(`Before flash: ${beforeFlash}`,              { command: 'esp.selectBeforeFlashing', icon: 'debug-step-over', tooltip: 'Action before flashing' }),
            new EspItem(`After flash: ${afterFlash}`,                { command: 'esp.selectAfterFlashing',  icon: 'debug-step-out',  tooltip: 'Action after flashing' }),
            new EspItem(`Monitor Baud: ${monitorBaud}`,              { command: 'esp.selectMonitorBaud',    icon: 'terminal',        tooltip: 'Monitor baud rate' }),
        ];

        let sourceItem;
        if (overrideFlash) {
            sourceItem = new EspGroup('sourceGroup', 'Source: Manual', manualSettings, 'sourceItem', vscode.TreeItemCollapsibleState.Expanded);
        } else {
            sourceItem = new EspItem('Source: Menuconfig', {
                command: 'esp.toggleOverride',
                icon: 'settings',
                tooltip: 'Click to switch to Manual settings',
                contextValue: 'sourceItem'
            });
        }
        if (!(sourceItem instanceof EspGroup)) {
            sourceItem.iconPath = new vscode.ThemeIcon('settings');
        }

        // ── Manual Toolpath Settings ────────────────────────────────
        const pythonManualPath = cfg('pythonPath') || '';
        const pythonLabel = pythonManualPath
            ? `Python 3.7: ${pythonManualPath}`
            : 'Python 3.7: auto-detect';

        const manualToolpathGroup = new EspGroup('manualToolpathGroup', '🐍  Python Path Settings', [
            new EspItem(pythonLabel, {
                command: 'esp.setPythonPath',
                icon:    'symbol-misc',
                tooltip: pythonManualPath
                    ? `Manual: ${pythonManualPath}\nClick to change or switch to auto-detect`
                    : 'Auto-detect Python 3.7\nClick to set folder manually',
                desc: pythonManualPath ? '' : 'auto',
            }),
        ]);

        // ── Shared groups ───────────────────────────────────────────
        const pathSettingsGroup = (extraItems = []) => new EspGroup('pathSettingsGroup', '🔗  SDK Path Settings', [
            new EspItem(`RTOS IDF: ${idfLabel}`, { command: 'esp.selectIdf', icon: 'folder-opened', tooltip: idfTooltip, desc: idfDesc, contextValue: 'rtosIdfItem' }),
            ...extraItems,
        ]);

        const vscodeUtilitiesGroup = new EspGroup('vscodeUtilitiesGroup', '🔧  VScode Utilities', [
            new EspItem('Generate IntelliSense', { command: 'esp.generateIntelliSense', icon: 'symbol-class', tooltip: 'Generate .vscode/c_cpp_properties.json' }),
            new EspItem('Generate tasks.json',   { command: 'esp.generateTasks',        icon: 'tasklist',     tooltip: 'Generate .vscode/tasks.json (Ctrl+Shift+B → ESP: Build)' }),
        ]);

        // ── Env warnings (не блокируют SDK команды) ─────────────────
        const warningItems = this.envWarnings.map(w =>
            new EspItem(w.label, { command: w.command, icon: 'warning', tooltip: w.tooltip })
        );

        // ── No SDK — show full tree anyway, warning already in warningItems ──────

        // ── No project folder — show full tree anyway, commands will warn ──────

        // ── NonOS SDK ────────────────────────────────────────────────
        // ── RTOS SDK ─────────────────────────────────────────────────
        return [
            createProjectItem,
            projectGroup,

            new EspGroup('buildGroup', '⚙️  Build', [
                new EspItem('Build',             { command: 'esp.build',           icon: 'tools',       iconColor: 'charts.green', tooltip: 'idf.py build\nBuild the project',          contextValue: 'buildItem' }),
                new EspItem('Build App',         { command: 'esp.buildApp',        icon: 'file-binary', iconColor: 'charts.green', tooltip: 'idf.py app\nBuild only the app',            contextValue: 'buildItemSimple' }),
                new EspItem('Build Bootloader',  { command: 'esp.buildBootloader', icon: 'file-binary', iconColor: 'charts.green', tooltip: 'idf.py bootloader\nBuild only bootloader',     contextValue: 'buildItemSimple' }),
                new EspItem('Build Part. Table', { command: 'esp.buildPartition',  icon: 'file-binary', iconColor: 'charts.green', tooltip: 'idf.py partition_table\nBuild only partition table', contextValue: 'buildItemSimple' }),
            ]),

            new EspGroup('flashGroup', '⚡  Flash', [
                new EspItem('Flash',               { command: 'esp.flash',           icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py flash\nFlash the project',              contextValue: 'flashItem' }),
                new EspItem('Flash App',           { command: 'esp.flashApp',        icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py app-flash\nFlash the app only',          contextValue: 'flashAppItem' }),
                new EspItem('Flash Bootloader',    { command: 'esp.flashBootloader', icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py bootloader-flash\nFlash bootloader only',          contextValue: 'flashAppItem' }),
                new EspItem('Flash Part. Table',   { command: 'esp.flashPartition',  icon: 'zap',   iconColor: 'charts.blue', tooltip: 'idf.py partition_table-flash\nFlash partition table only', contextValue: 'flashAppItem' }),
                new EspItem('Erase Flash',         { command: 'esp.eraseFlash',      icon: 'trash', iconColor: 'charts.blue', tooltip: 'idf.py erase_flash\nErase entire flash chip' }),
            ]),

            new EspGroup('monitorGroup', '🖥️  Monitor', [
                new EspItem('Monitor', _monitorRunning
                    ? { command: 'esp.stopMonitor', icon: 'debug-stop', iconColor: 'charts.purple', tooltip: 'Stop Monitor' }
                    : { command: 'esp.monitor',     icon: 'terminal',   iconColor: 'charts.purple', tooltip: 'Start Monitor\nidf.py monitor' }),
            ]),

            new EspGroup('cleanGroup', '🗑️  Clean', [
                new EspItem('Clean',      { command: 'esp.clean',     icon: 'trash',     iconColor: 'charts.red', tooltip: 'idf.py clean\nDelete build output files from the build directory' }),
                new EspItem('Full Clean', { command: 'esp.fullclean', icon: 'clear-all', iconColor: 'charts.red', tooltip: 'idf.py fullclean\nDelete the entire build directory contents' }),
            ]),

            new EspGroup('analysisGroup', '📊  Analysis', [
                new EspItem('Size',            { command: 'esp.size',           icon: 'graph', iconColor: 'charts.yellow', tooltip: 'idf.py size\nPrint basic size information about the app' }),
                new EspItem('Size Components', { command: 'esp.sizeComponents', icon: 'graph', iconColor: 'charts.yellow', tooltip: 'idf.py size-components\nPrint per-component size information' }),
                new EspItem('Size Files',      { command: 'esp.sizeFiles',      icon: 'graph', iconColor: 'charts.yellow', tooltip: 'idf.py size-files\nPrint per-source-file size information' }),
            ]),

            new EspGroup('settingsGroup', '⚙️  Serial Source Settings', [sourceItem]),

            new EspGroup('configureGroup', '🔩  SDK Configure', [
                new EspItem('Menuconfig',      { command: 'esp.menuconfig',  icon: 'settings-gear', iconColor: 'charts.orange', tooltip: 'idf.py menuconfig\nRun "menuconfig" project configuration tool\n⚠️ Requires terminal: min 80 columns × 19 rows' }),
                new EspItem('Reconfigure',     { command: 'esp.reconfigure', icon: 'refresh',       iconColor: 'charts.orange', tooltip: 'idf.py reconfigure\nRe-run CMake' }),
                new EspItem('Reset Projectconfig', { command: 'esp.resetConfig', icon: 'discard',       iconColor: 'charts.orange', tooltip: 'Delete sdkconfig — reset to defaults on next build' }),
            ]),

            pathSettingsGroup(),
            manualToolpathGroup,

            new EspGroup('utilsGroup', '🛠️  Utilities', [
                new EspItem('Make SPIFFS',              { command: 'esp.spiffs',          icon: 'database', iconColor: 'charts.foreground', tooltip: 'mkspiffs — pack data/ folder into SPIFFS image' }),
                new EspItem('Custom Partitions', { command: 'esp.partitionEditor', icon: 'layout',   iconColor: 'charts.foreground', tooltip: 'Open visual partition table editor' }),
            ]),
            vscodeUtilitiesGroup,
        ];
    }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ACTIVATION / DEACTIVATION                                         ║
// ╚══════════════════════════════════════════════════════════════════╝
// ─── Configure Tools (Auto / Manual) ─────────────────────────────────────────

function activate(ctx) {
    globalCtx = ctx;
    provider = new EspProvider();

    const folders   = vscode.workspace.workspaceFolders;
    const savedRoot = ctx.workspaceState.get('espActiveRoot');
    // savedRoot === null means user explicitly cleared — don't auto-restore
    // savedRoot === undefined means first launch — don't auto-pick either
    if (savedRoot && folders?.find(f => f.uri.fsPath === savedRoot)) {
        activeRoot = savedRoot;
    }

    ctx.subscriptions.push(
        vscode.window.onDidCloseTerminal(closed => {
            for (const [name, t] of Object.entries(terms)) {
                if (t === closed) {
                    delete terms[name];
                    log(`Terminal closed: "${name}"`);
                    // If the closed terminal was a monitor terminal — reset state
                    const monitorTermNames = ['ESP › Monitor', 'ESP › Flash & Monitor', 'ESP › flash monitor & Monitor'];
                    if (monitorTermNames.includes(name)) {
                        _monitorRunning = false;
                        clearBusy();
                        refreshMonitorButton();
                        log(`Monitor terminal killed — state reset`);
                    }
                    break;
                }
            }
        })
    );

    createStatusBar(ctx);

    if (IS_LINUX) checkDialoutGroup();
    setTimeout(() => autoGenerateDevFiles(), 2000);

    const treeView = vscode.window.createTreeView('esp-idf-tools.projectView', { treeDataProvider: provider });

    // Full environment check AFTER treeView is registered so warnings appear in tree
    setTimeout(() => {
        const startupIdfPath = getValidIdfPath();
        if (startupIdfPath) ensureVersionTxt(startupIdfPath);
        checkEnvironment(true).then(ok => { if (ok) checkAndInstallTools(); });
    }, 500);

    treeView.onDidCollapseElement(e => {
        if (e.element.id) ctx.workspaceState.update(`espGroupState_${e.element.id}`, vscode.TreeItemCollapsibleState.Collapsed);
    });
    treeView.onDidExpandElement(e => {
        if (e.element.id) ctx.workspaceState.update(`espGroupState_${e.element.id}`, vscode.TreeItemCollapsibleState.Expanded);
    });

    ctx.subscriptions.push(
        treeView,
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('esp-idf-tools')) return;
            if (e.affectsConfiguration('esp-idf-tools.idfPath')) {
                if (cfg('idfPath') === _idfPathOverride) _idfPathOverride = null;
                _pythonCmd = null; _toolsVerified = false;

                checkAndInstallTools();
                setTimeout(() => autoGenerateDevFiles(), 1000);
            }
            provider.refresh();
            refreshStatusBar();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            const current = vscode.workspace.workspaceFolders ||[];
            if (!current.find(f => f.uri.fsPath === activeRoot)) {
                activeRoot = current[0]?.uri.fsPath || null;
                if (globalCtx) ctx.workspaceState.update('espActiveRoot', activeRoot);
            }
            provider.refresh();
            setTimeout(() => autoGenerateDevFiles(), 1000);
        }),
    );

    const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('esp.build',           () => runIdf(['build'],           'ESP › Build', true));
    reg('esp.buildApp',        () => runIdf(['app'],             'ESP › Build App', true));
    reg('esp.buildBootloader', () => runIdf(['bootloader'],      'ESP › Build Bootloader', true));
    reg('esp.buildPartition',  () => runIdf(['partition_table'], 'ESP › Build Partition Table', true));
    reg('esp.size',            () => runIdf(['size'],            'ESP › Size',            true));
    reg('esp.sizeComponents',  () => runIdf(['size-components'], 'ESP › Size Components', true));
    reg('esp.sizeFiles',       () => runIdf(['size-files'],      'ESP › Size Files',      true));
    reg('esp.menuconfig',      () => runIdf(['menuconfig'],      'ESP › Menuconfig'));
    reg('esp.reconfigure',     () => runIdf(['reconfigure'],     'ESP › Reconfigure'));
    reg('esp.resetConfig',     async () => { await cmdResetConfig(); provider.refresh(); });
    reg('esp.clean',           () => runIdf(['clean'],           'ESP › Clean'));
    reg('esp.fullclean',       () => runIdf(['fullclean'],       'ESP › Full Clean'));


    reg('esp.flash',           () => runWithPostFlash('flash'));
    reg('esp.monitor',         () => runFlash('monitor'));
    reg('esp.flashApp',        () => runWithPostFlash('app-flash'));
    reg('esp.flashBootloader', () => runWithPostFlash('bootloader-flash'));
    reg('esp.flashPartition',  () => runWithPostFlash('partition_table-flash'));
    reg('esp.eraseFlash',      () => runFlash('erase_flash'));
    reg('esp.stopMonitor',     () => cmdStopMonitor());


    reg('esp.spiffs',          () => cmdMakeSpiffs());
    reg('esp.addComponent',    async () => { await cmdAddComponent(); provider.refresh(); });
    reg('esp.deleteComponent', async (item) => { await cmdDeleteComponent(item); provider.refresh(); });
    reg('esp.editComponent',   async (item) => { await cmdEditComponent(item);   provider.refresh(); });
    reg('esp.partitionEditor', () => cmdPartitionEditor());

    reg('esp.generateIntelliSense', async () => { await cmdGenerateIntelliSense(); });
    reg('esp.generateTasks',        async () => { await cmdGenerateTasks(); });

    reg('esp.createProject',  async () => { await cmdCreateProject();  provider.refresh(); });
    reg('esp.editProject',    async () => { await cmdEditProject();    provider.refresh(); });
    reg('esp.clearProject',   () => {
        activeRoot = null;
        if (globalCtx) globalCtx.workspaceState.update('espActiveRoot', null);
        provider.refresh();
        refreshStatusBar();
    });
    reg('esp.selectPort',     async () => { const p = await cmdSelectPort();  provider.refresh(); refreshStatusBar(); return p; });
    reg('esp.selectIdf',      async () => { await cmdFixSdk(true);  provider.refresh(); refreshStatusBar(); });
    reg('esp.selectProject',  async () => { await cmdSelectProject();  provider.refresh(); });
    reg('esp.configureBuild',       async () => { await cmdConfigureBuild();       provider.refresh(); });
    reg('esp.configureBuildSimple', async () => { await cmdConfigureBuildSimple(); provider.refresh(); });
    reg('esp.configureFlash',    async () => { await cmdConfigureFlash();    provider.refresh(); });
    reg('esp.configureFlashApp', async () => { await cmdConfigureFlashApp(); provider.refresh(); });
    reg('esp.toggleOverride', async () => { await setCfg('overrideFlashConfig', !cfg('overrideFlashConfig')); provider.refresh(); refreshStatusBar(); });
    reg('esp.selectFlashBaud',         async () => { await cmdSelectFlashBaud();         provider.refresh(); });
    reg('esp.selectFlashMode',         async () => { await cmdSelectFlashMode();         provider.refresh(); });
    reg('esp.selectFlashFreq',         async () => { await cmdSelectFlashFreq();         provider.refresh(); });
    reg('esp.selectFlashSize',         async () => { await cmdSelectFlashSize();         provider.refresh(); });
    reg('esp.toggleCompressedUpload',  async () => { await cmdToggleCompressedUpload();  provider.refresh(); });
    reg('esp.selectBeforeFlashing',    async () => { await cmdSelectBeforeFlashing();    provider.refresh(); });
    reg('esp.selectAfterFlashing',     async () => { await cmdSelectAfterFlashing();     provider.refresh(); });
    reg('esp.selectMonitorBaud',       async () => { await cmdSelectMonitorBaud();       provider.refresh(); });
    reg('esp.refreshViews', () => {
        _toolsVerified = false;
        _pythonCmd     = null;  // force re-detect python
        const idfPath  = getValidIdfPath();
        if (idfPath) ensureVersionTxt(idfPath);
        provider.refresh();
        checkEnvironment(true);
        checkAndInstallTools(false);
    });
    reg('esp.showRtosSdkInfo', async () => {
        const rtosMsg = [
                '📁 ESP8266_RTOS_SDK\\',
                '├── components\\    ← required',
                '├── tools\\         ← required',
                '├── CMakeLists.txt  ← required',
                '├── Kconfig         ← required',
                '└── requirements.txt ← required',
                '',
                'Download:',
                '  github.com/espressif/ESP8266_RTOS_SDK',
            ].join('\n');
        const rtosBtn = await vscode.window.showInformationMessage(
            'Expected RTOS SDK folder structure',
            { modal: true, detail: rtosMsg },
            'Copy to Clipboard', 'OK'
        );
        if (rtosBtn === 'Copy to Clipboard') vscode.env.clipboard.writeText(rtosMsg);
    });
    reg('esp.fixPython',               () => cmdFixPython());
    reg('esp.fixSdk',                  () => cmdFixSdk());
    reg('esp.setPythonPath',           async () => { await cmdSetPythonPath(); });
    reg('esp.collapseAll',             () => vscode.commands.executeCommand('workbench.actions.treeView.esp-idf-tools.projectView.collapseAll'));
}

function deactivate() {
    clearBusy();
    for (const t of Object.values(terms)) { try { t.dispose(); } catch {} }
    terms = {};
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  PROJECT SETUP: IntelliSense, Tasks, Auto-generate                 ║
// ╚══════════════════════════════════════════════════════════════════╝
async function autoGenerateDevFiles() {
    if (!cfg('autoGenerateOnOpen')) return;

    const root     = getActiveRoot();
    const idfPath  = getValidIdfPath();
    if (!root || !idfPath) return;

    const vscodeDir      = path.join(root, '.vscode');
    const intelliSense   = path.join(vscodeDir, 'c_cpp_properties.json');
    const tasksFile      = path.join(vscodeDir, 'tasks.json');

    const needIntelliSense = !fs.existsSync(intelliSense);
    const needTasks        = !fs.existsSync(tasksFile);

    if (!needIntelliSense && !needTasks) return;

    const pythonCmd = await getPythonCmd();
    if (!pythonCmd) return;

    try { fs.mkdirSync(vscodeDir, { recursive: true }); } catch {}

    const generated =[];

    if (needIntelliSense) {
        try {
            const compilerPath        = findXtensaGcc();
            const compileCommandsPath = '${workspaceFolder}/build/compile_commands.json';
            const config = {
                configurations:[{
                    name: 'ESP8266',
                    includePath:['${workspaceFolder}/**', `${idfPath}/components/**`],
                    defines:['ESP_PLATFORM', '__xtensa__', '__XTENSA__'],
                    ...(compilerPath ? { compilerPath } : {}),
                    compileCommands: compileCommandsPath,
                    cStandard: 'gnu11',
                    cppStandard: 'gnu++14',
                    browse: {
                        path:['${workspaceFolder}', idfPath],
                        limitSymbolsToIncludedHeaders: true
                    }
                }],
                version: 4
            };
            fs.writeFileSync(intelliSense, JSON.stringify(config, null, 4));
            generated.push('c_cpp_properties.json');
            log('Auto-generated c_cpp_properties.json');
        } catch (e) {
            log(`Auto-generate IntelliSense failed: ${e.message}`);
        }
    }

    if (needTasks) {
        try {
            const envPrefix  = buildIdfEnvPrefix(idfPath, pythonCmd);
            const shellOpts  = IS_WIN
                ? { executable: 'powershell.exe', args:['-ExecutionPolicy', 'Bypass', '-NoLogo', '-Command'] }
                : { executable: getUserShell(), args:['-c'] };
            const makeShellCmd = (idfArgs) => IS_WIN
                ? `${envPrefix}; idf.py ${idfArgs.join(' ')}`
                : `${envPrefix} && idf.py ${idfArgs.join(' ')}`;
            const makeTask = (label, idfArgs, isDefault = false) => ({
                label, type: 'shell',
                command: makeShellCmd(idfArgs),
                options: { cwd: '${workspaceFolder}', ...(IS_WIN ? { shell: shellOpts } : {}) },
                ...(isDefault ? { group: { kind: 'build', isDefault: true } } : {}),
                presentation: { reveal: 'always', focus: true, panel: 'shared', clear: true },
                problemMatcher: '$esp-idf-gcc',
            });
            const tasksJson = {
                version: '2.0.0',
                tasks:[
                    makeTask('ESP: Build',            ['build'], true),
                    makeTask('ESP: Build App',        ['app']),
                    makeTask('ESP: Build Bootloader', ['bootloader']),
                    makeTask('ESP: Clean',            ['clean']),
                    makeTask('ESP: Full Clean',       ['fullclean']),
                    makeTask('ESP: Size',             ['size']),
                ]
            };
            fs.writeFileSync(tasksFile, JSON.stringify(tasksJson, null, 4));
            generated.push('tasks.json');
            log('Auto-generated tasks.json');
        } catch (e) {
            log(`Auto-generate tasks.json failed: ${e.message}`);
        }
    }

    if (generated.length) {
        vscode.window.showInformationMessage(
            `ESP-IDF: Auto-generated ${generated.join(' and ')} for this project.`
        );
    }
}

function checkDialoutGroup() {
    cp.exec('id -nG', { encoding: 'utf8' }, (err, stdout) => {
        if (err) return;
        const groups = stdout.trim().split(' ');
        if (!groups.includes('dialout') && !groups.includes('uucp')) {
            vscode.window.showWarningMessage(
                'ESP: User not in dialout group. Serial port access errors possible.',
                'How to fix'
            ).then(choice => {
                if (choice === 'How to fix') {
                    vscode.window.showInformationMessage(
                        `Run: sudo usermod -aG dialout ${os.userInfo().username} — then restart your session.`
                    );
                }
            });
        }
    });
}

function getActiveRoot() {
    if (activeRoot && fs.existsSync(activeRoot)) return activeRoot;
    return null;
}

// ── Prerequisite check: Python first, then project folder ─────────────────────
// Returns true if all OK, false if something is missing (shows error message).
async function cmdGenerateIntelliSense() {
    const root = getActiveRoot();
    if (!await requireReady()) return;
    const idfPath = getValidIdfPath();
    if (!idfPath) { vscode.window.showErrorMessage('ESP: IDF path not set!'); return; }

    const vscodeDir  = path.join(root, '.vscode');
    const outFile    = path.join(vscodeDir, 'c_cpp_properties.json');
    const compilerPath = findXtensaGcc();

    const compileCommandsPath = '${workspaceFolder}/build/compile_commands.json';

    const config = {
        configurations:[{
            name: 'ESP8266',
            includePath:[
                '${workspaceFolder}/**',
                `${idfPath}/components/**`,
            ],
            defines:[
                'ESP_PLATFORM',
                '__xtensa__',
                '__XTENSA__',
            ],
            ...(compilerPath ? { compilerPath } : {}),
            compileCommands: compileCommandsPath,
            cStandard: 'gnu11',
            cppStandard: 'gnu++14',
            browse: {
                path: ['${workspaceFolder}', idfPath],
                limitSymbolsToIncludedHeaders: true
            }
        }],
        version: 4
    };

    if (fs.existsSync(outFile)) {
        const choice = await vscode.window.showWarningMessage(
            '.vscode/c_cpp_properties.json already exists. Overwrite?',
            'Overwrite', 'Cancel'
        );
        if (choice !== 'Overwrite') return;
    }

    try {
        fs.mkdirSync(vscodeDir, { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(config, null, 4));

        const hint = compilerPath
            ? `Compiler: ${path.basename(compilerPath)}`
            : 'Compiler not found — run "idf.py build" first for full IntelliSense';

        const action = await vscode.window.showInformationMessage(
            `✅ c_cpp_properties.json generated. ${hint}`,
            'Open File'
        );
        if (action === 'Open File') {
            vscode.window.showTextDocument(vscode.Uri.file(outFile));
        }
        log(`Generated c_cpp_properties.json (compiler: ${compilerPath || 'not found'})`);
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to write c_cpp_properties.json: ${e.message}`);
    }
}

async function cmdGenerateTasks() {
    const root = getActiveRoot();
    if (!await requireReady()) return;
    const idfPath = getValidIdfPath();
    if (!idfPath) { vscode.window.showErrorMessage('ESP: IDF path not set!'); return; }
    const pythonCmd = await getPythonCmd();
    if (!pythonCmd) return; // getPythonCmd already showed the error

    const envPrefix = buildIdfEnvPrefix(idfPath, pythonCmd);

    const makeShellCmd = (idfArgs) => IS_WIN
        ? `${envPrefix}; idf.py ${idfArgs.join(' ')}`
        : `${envPrefix} && idf.py ${idfArgs.join(' ')}`;

    const shellOpts = IS_WIN
        ? { executable: 'powershell.exe', args:['-ExecutionPolicy', 'Bypass', '-NoLogo', '-Command'] }
        : { executable: getUserShell(), args: ['-c'] };

    const makeTask = (label, idfArgs, isDefaultBuild = false) => ({
        label,
        type: 'shell',
        command: makeShellCmd(idfArgs),
        options: {
            cwd: '${workspaceFolder}',
            ...(IS_WIN ? { shell: shellOpts } : {})
        },
        ...(isDefaultBuild ? { group: { kind: 'build', isDefault: true } } : {}),
        presentation: { reveal: 'always', focus: true, panel: 'shared', clear: true },
        problemMatcher: '$esp-idf-gcc',
    });

    const tasksJson = {
        version: '2.0.0',
        tasks:[
            makeTask('ESP: Build',            ['build'],           true),
            makeTask('ESP: Build App',        ['app']),
            makeTask('ESP: Build Bootloader',['bootloader']),
            makeTask('ESP: Clean',            ['clean']),
            makeTask('ESP: Full Clean',       ['fullclean']),
            makeTask('ESP: Size',             ['size']),
        ]
    };

    const vscodeDir = path.join(root, '.vscode');
    const outFile   = path.join(vscodeDir, 'tasks.json');

    if (fs.existsSync(outFile)) {
        const choice = await vscode.window.showWarningMessage(
            '.vscode/tasks.json already exists. Overwrite?',
            'Overwrite', 'Cancel'
        );
        if (choice !== 'Overwrite') return;
    }

    try {
        fs.mkdirSync(vscodeDir, { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(tasksJson, null, 4));

        const action = await vscode.window.showInformationMessage(
            '✅ tasks.json generated. Use Ctrl+Shift+B to build.',
            'Open File'
        );
        if (action === 'Open File') {
            vscode.window.showTextDocument(vscode.Uri.file(outFile));
        }
        log('Generated .vscode/tasks.json');
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to write tasks.json: ${e.message}`);
    }
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  COMPONENT MANAGEMENT: Add / Delete                                ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── NonOS Makefile patcher ───────────────────────────────────────────────────
// action: 'add' | 'remove' | 'rename' (oldName → newName)

async function cmdDeleteComponent(item) {
    const root = getActiveRoot();
    if (!root) return;

    const compName = item?._compName || item?.label;
    if (!compName) { vscode.window.showErrorMessage('ESP: Cannot determine component name.'); return; }

    const compDir = path.join(root, 'components', compName);
    if (!fs.existsSync(compDir)) {
        vscode.window.showErrorMessage(`ESP: Component folder not found: ${compDir}`);
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        `Delete component "${compName}"? This will remove the entire folder.`,
        { modal: true },
        'Delete'
    );
    if (choice !== 'Delete') return;

    try {
        fs.rmSync(compDir, { recursive: true, force: true });
        vscode.window.showInformationMessage(`✅ Component "${compName}" deleted.`);
    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to delete component: ${e.message}`);
    }
}

async function cmdAddComponent() {
    const root = getActiveRoot();
    if (!root) {
        warnNoProject();
        return;
    }

    // ── NonOS SDK: create .c/.h + patch Makefile ─────────────────────────────

    // ── RTOS SDK: CMake-based component ──────────────────────────────────────
    const compName = await vscode.window.showInputBox({
        title:       'Add Component — Step 1/4: Component Name',
        prompt:      'Name of the new component',
        placeHolder: 'my_component',
        validateInput: text => {
            if (!text?.match(/^[a-zA-Z0-9_]+$/)) return 'Use letters, numbers and _ only';
            if (fs.existsSync(path.join(root, 'components', text))) return 'Component already exists';
            return null;
        }
    });
    if (!compName) return;

    // Step 2 — source files
    const srcsInput = await vscode.window.showInputBox({
        title:       'Add Component — Step 2/4: Source Files',
        prompt:      'Source .c files (comma-separated)',
        placeHolder: `${compName}.c`,
        value:       `${compName}.c`,
    });
    if (srcsInput === undefined) return;
    const srcs = srcsInput.split(',').map(s => s.trim()).filter(Boolean);

    // Step 3 — headers
    const headersChoice = await vscode.window.showQuickPick([
        { label: '$(folder) Separate include/ folder', description: 'INCLUDE_DIRS "include"', value: 'include' },
        { label: '$(file)   Same folder as .c files',  description: 'INCLUDE_DIRS "."',       value: 'dot'     },
        { label: '$(x)      No header files',           description: 'no INCLUDE_DIRS',        value: 'none'    },
    ], {
        title: 'Add Component — Step 3/4: Header Files',
        placeHolder: 'Where are the .h files?',
    });
    if (!headersChoice) return;

    // Step 4 — REQUIRES
    const reqInput = await vscode.window.showInputBox({
        title:       'Add Component — Step 4/4: Dependencies (REQUIRES)',
        prompt:      'Other components this depends on (comma-separated, leave empty if none)',
        placeHolder: 'fatfs, driver',
    });
    if (reqInput === undefined) return;
    const requires = reqInput.split(',').map(s => s.trim()).filter(Boolean);

    // Build CMakeLists.txt content
    const srcsLine    = srcs.map(s => `"${s}"`).join(' ');
    const incLine     = headersChoice.value === 'include' ? '\n                       INCLUDE_DIRS "include"'
                      : headersChoice.value === 'dot'     ? '\n                       INCLUDE_DIRS "."'
                      : '';
    const reqLine     = requires.length ? `\n                       REQUIRES ${requires.join(' ')}` : '';
    const cmakeContent = `idf_component_register(SRCS ${srcsLine}${incLine}${reqLine}\n)\n`;

    // Create folders and files
    const compDir = path.join(root, 'components', compName);
    try {
        fs.mkdirSync(compDir, { recursive: true });
        if (headersChoice.value === 'include') {
            fs.mkdirSync(path.join(compDir, 'include'), { recursive: true });
        }

        // CMakeLists.txt
        fs.writeFileSync(path.join(compDir, 'CMakeLists.txt'), cmakeContent);

        // Source files
        for (const src of srcs) {
            const srcPath = path.join(compDir, src);
            if (!fs.existsSync(srcPath)) {
                const baseName = src.replace(/\.c$/, '');
                fs.writeFileSync(srcPath,
`#include "${baseName}.h"

// TODO: implement ${baseName}
`);
            }
        }

        // Header files
        if (headersChoice.value !== 'none') {
            const headerDir = headersChoice.value === 'include'
                ? path.join(compDir, 'include')
                : compDir;
            const headerPath = path.join(headerDir, `${compName}.h`);
            if (!fs.existsSync(headerPath)) {
                const guard = compName.toUpperCase() + '_H';
                fs.writeFileSync(headerPath,
`#ifndef ${guard}
#define ${guard}

// TODO: declare ${compName} API

#endif // ${guard}
`);
            }
        }

        vscode.window.showInformationMessage(
            `✅ Component "${compName}" created in components/${compName}/`
        );

    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to create component: ${e.message}`);
    }
}

// ─── Edit existing component ──────────────────────────────────────────────────
async function cmdEditComponent(item) {
    const root = getActiveRoot();
    if (!root) {
        warnNoProject();
        return;
    }

    const compName = item?._compName || item?.label;
    if (!compName) { vscode.window.showErrorMessage('ESP: Cannot determine component name.'); return; }

    const compDir = path.join(root, 'components', compName);
    if (!fs.existsSync(compDir)) {
        vscode.window.showErrorMessage(`ESP: Component folder not found: ${compDir}`);
        return;
    }

    // ── RTOS: rename + edit CMakeLists.txt ───────────────────────────────────    // ── RTOS: full CMake wizard ───────────────────────────────────────────────

    // Parse existing CMakeLists.txt to pre-fill wizard
    let existingSrcs = `${compName}.c`;
    let existingHeaderVal = 'include';
    let existingRequires = '';

    const cmakePath = path.join(compDir, 'CMakeLists.txt');
    if (fs.existsSync(cmakePath)) {
        const cmake = fs.readFileSync(cmakePath, 'utf8');

        // Extract SRCS
        const srcsMatch = cmake.match(/SRCS\s+((?:"[^"]*"\s*)+)/);
        if (srcsMatch) {
            existingSrcs = srcsMatch[1].trim().replace(/"([^"]*)"\s*/g, '$1, ').replace(/,\s*$/, '');
        }

        // Extract INCLUDE_DIRS
        if (/INCLUDE_DIRS\s+"\."/. test(cmake))       existingHeaderVal = 'dot';
        else if (/INCLUDE_DIRS\s+"include"/.test(cmake)) existingHeaderVal = 'include';
        else if (!cmake.includes('INCLUDE_DIRS'))       existingHeaderVal = 'none';

        // Extract REQUIRES
        const reqMatch = cmake.match(/REQUIRES[^\S\n]+([^)\n]+)/);
        if (reqMatch) {
            existingRequires = reqMatch[1].trim().replace(/\s+/g, ', ');
        }
    }

    // Step 0 — rename (optional)
    const newNameInput = await vscode.window.showInputBox({
        title:       `Edit Component "${compName}" — Step 1/4: Rename`,
        prompt:      'Component folder name',
        value:       compName,
        validateInput: text => {
            if (!text?.match(/^[a-zA-Z0-9_]+$/)) return 'Use letters, numbers and _ only';
            if (text !== compName && fs.existsSync(path.join(root, 'components', text)))
                return `Component "${text}" already exists`;
            return null;
        }
    });
    if (newNameInput === undefined) return;
    const newName = newNameInput.trim() || compName;

    // Step 1 — source files (pre-filled)
    const srcsInput = await vscode.window.showInputBox({
        title:       `Edit Component "${compName}" — Step 2/4: Source Files`,
        prompt:      'Source .c files (comma-separated)',
        value:       existingSrcs,
    });
    if (srcsInput === undefined) return;
    const srcs = srcsInput.split(',').map(s => s.trim()).filter(Boolean);

    // Step 2 — headers (pre-selected)
    const headerItems = [
        { label: '$(folder) Separate include/ folder', description: 'INCLUDE_DIRS "include"', value: 'include' },
        { label: '$(file)   Same folder as .c files',  description: 'INCLUDE_DIRS "."',       value: 'dot'     },
        { label: '$(x)      No header files',           description: 'no INCLUDE_DIRS',        value: 'none'    },
    ];
    headerItems.forEach(i => { if (i.value === existingHeaderVal) i.picked = true; });
    const headersChoice = await vscode.window.showQuickPick(headerItems, {
        title: `Edit Component "${compName}" — Step 3/4: Header Files`,
        placeHolder: 'Where are the .h files?',
    });
    if (!headersChoice) return;

    // Step 3 — REQUIRES (pre-filled)
    const reqInput = await vscode.window.showInputBox({
        title:       `Edit Component "${compName}" — Step 4/4: Dependencies (REQUIRES)`,
        prompt:      'Other components this depends on (comma-separated, leave empty if none)',
        value:       existingRequires,
        placeHolder: 'fatfs, driver',
    });
    if (reqInput === undefined) return;
    const requires = reqInput.split(',').map(s => s.trim()).filter(Boolean);

    // Rebuild CMakeLists.txt
    const srcsLine = srcs.map(s => `"${s}"`).join(' ');
    const incLine  = headersChoice.value === 'include' ? '\n                       INCLUDE_DIRS "include"'
                   : headersChoice.value === 'dot'     ? '\n                       INCLUDE_DIRS "."'
                   : '';
    const reqLine  = requires.length ? `\n                       REQUIRES ${requires.join(' ')}` : '';
    const cmakeContent = `idf_component_register(SRCS ${srcsLine}${incLine}${reqLine}\n)\n`;

    try {
        // Rename folder if needed
        let finalCompDir = compDir;
        let finalCmakePath = cmakePath;
        if (newName !== compName) {
            const newCompDir = path.join(root, 'components', newName);
            fs.renameSync(compDir, newCompDir);
            finalCompDir    = newCompDir;
            finalCmakePath  = path.join(newCompDir, 'CMakeLists.txt');
        }

        // Update CMakeLists.txt
        fs.writeFileSync(finalCmakePath, cmakeContent);

        // Create any new source files that don't exist yet
        for (const src of srcs) {
            const srcPath = path.join(finalCompDir, src);
            if (!fs.existsSync(srcPath)) {
                const baseName = src.replace(/\.c$/, '');
                fs.writeFileSync(srcPath, `#include "${baseName}.h"\n\n// TODO: implement ${baseName}\n`);
            }
        }

        // Create include/ folder if needed
        if (headersChoice.value === 'include') {
            fs.mkdirSync(path.join(finalCompDir, 'include'), { recursive: true });
        }

        const renamed = newName !== compName ? ` (renamed → "${newName}")` : '';
        vscode.window.showInformationMessage(`✅ Component "${compName}" updated${renamed}.`);
    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to update component: ${e.message}`);
    }
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  PROJECT CREATION WIZARD                                           ║
// ╚══════════════════════════════════════════════════════════════════╝
async function cmdEditProject() {
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    const mainCmake = path.join(root, 'main', 'CMakeLists.txt');
    if (!fs.existsSync(mainCmake)) {
        vscode.window.showErrorMessage('ESP: main/CMakeLists.txt not found.');
        return;
    }

    // Parse existing CMakeLists.txt
    const existing = fs.readFileSync(mainCmake, 'utf8');
    const incMatch  = existing.match(/INCLUDE_DIRS\s+"([^"]+)"/);
    const reqMatch  = existing.match(/REQUIRES\s+([^\n\)]+)/);
    const currentInc = incMatch ? (incMatch[1] === 'include' ? 'include' : 'dot') : 'none';
    const currentReq = reqMatch ? reqMatch[1].trim() : '';
    const srcsMatch  = existing.match(/SRCS\s+((?:"[^"]+"\s*)+)/);
    const currentSrcs = srcsMatch ? srcsMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g,'')) ?? [] : [];

    // Step 1 — headers
    const activeInc = currentInc === 'include' ? 'Separate include/ folder'
                    : currentInc === 'dot'     ? 'Same folder as .c files'
                    : 'No header files';
    const headersChoice = await vscode.window.showQuickPick([
        { label: '$(folder) Separate include/ folder', description: 'INCLUDE_DIRS "include"', value: 'include' },
        { label: '$(file)   Same folder as .c files',  description: 'INCLUDE_DIRS "."',       value: 'dot'     },
        { label: '$(x)      No header files',           description: 'no INCLUDE_DIRS',        value: 'none'    },
    ], {
        title: 'Edit Project — Step 1/2: Header Files',
        placeHolder: `Current: ${activeInc}`,
    });
    if (!headersChoice) return;

    // Step 2 — REQUIRES
    const reqInput = await vscode.window.showInputBox({
        title:       'Edit Project — Step 2/2: Dependencies (REQUIRES)',
        prompt:      'Components this project depends on (comma-separated)',
        placeHolder: 'fatfs, driver',
        value:       currentReq,
    });
    if (reqInput === undefined) return;
    const requires = reqInput.split(',').map(s => s.trim()).filter(Boolean);

    // Rebuild CMakeLists.txt
    const srcsLine = currentSrcs.map(s => `"${s}"`).join(' ') || '"main.c"';
    const incLine  = headersChoice.value === 'include' ? '\n                       INCLUDE_DIRS "include"'
                   : headersChoice.value === 'dot'     ? '\n                       INCLUDE_DIRS "."'
                   : '';
    const reqLine  = requires.length ? `\n                       REQUIRES ${requires.join(' ')}` : '';

    try {
        fs.writeFileSync(mainCmake, `idf_component_register(SRCS ${srcsLine}${incLine}${reqLine}\n)\n`);

        // Create include/ if needed
        if (headersChoice.value === 'include') {
            fs.mkdirSync(path.join(root, 'main', 'include'), { recursive: true });
        }

        vscode.window.showInformationMessage('✅ main/CMakeLists.txt updated.');
    } catch (e) {
        vscode.window.showErrorMessage(`ESP: Failed to update project: ${e.message}`);
    }
}

async function cmdCreateProject() {
    // Step 1 — Select parent folder
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        title: 'Create New ESP8266 Project — Step 1/4: Select Parent Folder',
        openLabel: 'Select Parent Folder'
    });
    if (!uris?.length) return;
    const parentDir = uris[0].fsPath;

    // Step 2 — Project name
    const projectName = await vscode.window.showInputBox({
        prompt: 'New RTOS project name',
        placeHolder: 'my_esp_project',
        title: 'Create New ESP8266 Project — Step 2/4: Project Name',
        validateInput: text => {
            if (!text?.match(/^[a-zA-Z0-9_-]+$/)) return 'Invalid name (use letters, numbers, -, _)';
            if (fs.existsSync(path.join(parentDir, text))) return 'Folder already exists';
            return null;
        }
    });
    if (!projectName) return;

    // Step 3 — Include folder location
    const headersChoice = await vscode.window.showQuickPick([
        { label: '$(folder) Separate include/ folder', description: 'INCLUDE_DIRS "include"', value: 'include' },
        { label: '$(file)   Same folder as .c files',  description: 'INCLUDE_DIRS "."',       value: 'dot'     },
        { label: '$(x)      No header files',           description: 'no INCLUDE_DIRS',        value: 'none'    },
    ], {
        title: 'Create New ESP8266 Project — Step 3/4: Header Files',
        placeHolder: 'Where will the .h files be?',
    });
    if (!headersChoice) return;

    // Step 4 — REQUIRES dependencies
    const reqInput = await vscode.window.showInputBox({
        title:       'Create New ESP8266 Project — Step 4/4: Dependencies (REQUIRES)',
        prompt:      'Components this project depends on (comma-separated, leave empty if none)',
        placeHolder: 'fatfs, driver',
    });
    if (reqInput === undefined) return;
    const requires = reqInput.split(',').map(s => s.trim()).filter(Boolean);

    const projectDir = path.join(parentDir, projectName);
    try {
        _createRtosProject(projectDir, projectName, headersChoice.value, requires);

        const action = await vscode.window.showInformationMessage(
            `✅ RTOS project "${projectName}" created!`,
            'Open in Workspace'
        );
        if (action === 'Open in Workspace') {
            const n = vscode.workspace.workspaceFolders?.length || 0;
            vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(projectDir) });
            activeRoot = projectDir;
            if (globalCtx) globalCtx.workspaceState.update('espActiveRoot', activeRoot);
        }
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to create project: ${e.message}`);
    }
}

function _createRtosProject(projectDir, name, headersChoice = 'dot', requires = []) {
    fs.mkdirSync(path.join(projectDir, 'main'), { recursive: true });

    // Create include/ folder if needed
    if (headersChoice === 'include') {
        fs.mkdirSync(path.join(projectDir, 'main', 'include'), { recursive: true });
    }

    const incLine = headersChoice === 'include' ? '\n                       INCLUDE_DIRS "include"'
                  : headersChoice === 'dot'     ? '\n                       INCLUDE_DIRS "."'
                  : '';
    const reqLine = requires.length ? `\n                       REQUIRES ${requires.join(' ')}` : '';

    fs.writeFileSync(path.join(projectDir, 'CMakeLists.txt'),
`cmake_minimum_required(VERSION 3.5)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(${name})
`);
    fs.writeFileSync(path.join(projectDir, 'Makefile'),
`PROJECT_NAME := ${name}
include $(IDF_PATH)/make/project.mk
`);
    fs.writeFileSync(path.join(projectDir, 'main', 'CMakeLists.txt'),
`idf_component_register(SRCS "main.c"${incLine}${reqLine}
)
`);
    fs.writeFileSync(path.join(projectDir, 'main', 'component.mk'),
`# Component makefile
`);

    // Create header stub if needed
    if (headersChoice !== 'none') {
        const headerDir = headersChoice === 'include'
            ? path.join(projectDir, 'main', 'include')
            : path.join(projectDir, 'main');
        const guard = name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_H';
        fs.writeFileSync(path.join(headerDir, `${name}.h`),
`#ifndef ${guard}
#define ${guard}

// TODO: declare ${name} API

#endif // ${guard}
`);
    }

    fs.writeFileSync(path.join(projectDir, 'main', 'main.c'),
`#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main()
{
    printf("Hello from ${name}!\\n");
    while (1) {
        vTaskDelay(1000 / portTICK_PERIOD_MS);
    }
}
`);
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  SETTINGS COMMANDS: Project, IDF, SDK, Port, Flash                 ║
// ╚══════════════════════════════════════════════════════════════════╝
async function cmdSelectProject() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        vscode.commands.executeCommand('workbench.action.files.openFolder');
        return;
    }
    const items = folders.map(f => ({
        label: path.basename(f.uri.fsPath),
        description: f.uri.fsPath,
        detail: f.uri.fsPath === activeRoot ? '$(check) active' : '',
        fsPath: f.uri.fsPath,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: 'ESP-IDF Tools › Select project', placeHolder: 'Select workspace folder'
    });
    if (!picked) return;
    activeRoot = picked.fsPath;
    if (globalCtx) globalCtx.workspaceState.update('espActiveRoot', activeRoot);
    vscode.window.showInformationMessage(`ESP: Project → ${path.basename(activeRoot)}`);
}



// Helper: showQuickPick with active item pre-selected (highlighted in blue)
function quickPickActive(items, activeValue, options) {
    return new Promise(resolve => {
        const qp = vscode.window.createQuickPick();
        qp.items = items;
        qp.title = options.title;
        qp.ignoreFocusOut = options.ignoreFocusOut ?? true;
        const active = items.find(i => i.value === activeValue);
        if (active) qp.activeItems = [active];
        qp.onDidAccept(() => { const sel = qp.selectedItems[0] || null; qp.hide(); resolve(sel); });
        qp.onDidHide(() => resolve(null));
        qp.show();
    });
}

async function cmdConfigureBuild() {
    const preAction     = cfg('preBuildAction')    || 'none';
    const postAction    = cfg('postBuildAction')   || 'none';
    const savedAnalysis = cfg('postBuildAnalysis') || [];

    const preItems = [
        { label: '$(circle-slash)  Do nothing', value: 'none',      description: preAction === 'none'      ? '● active' : 'idf.py build' },
        { label: '$(trash)  Clean',             value: 'clean',     description: preAction === 'clean'     ? '● active' : 'idf.py clean build' },
        { label: '$(trash)  Full Clean',        value: 'fullclean', description: preAction === 'fullclean' ? '● active' : 'idf.py fullclean build' },
    ];
    const pickedPre = await quickPickActive(preItems, preAction, { title: 'Step 1/3: Action BEFORE build' });
    if (!pickedPre) return;

    const analysisItems = [
        { label: 'Size',            value: 'size',            description: 'idf.py size' },
        { label: 'Size Components', value: 'size-components', description: 'idf.py size-components' },
        { label: 'Size Files',      value: 'size-files',      description: 'idf.py size-files' },
    ].map(item => ({ ...item, picked: savedAnalysis.includes(item.value) }));

    const pickedAnalysis = await vscode.window.showQuickPick(analysisItems, {
        title: 'Step 2/3: Analysis after build (space to toggle)',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    if (!pickedAnalysis) return;

    const postItems = [
        { label: '$(circle-slash)  Do nothing',  value: 'none',         description: postAction === 'none'         ? '● active' : 'stop after build' },
        { label: '$(zap)  Flash',                value: 'flash',        description: postAction === 'flash'        ? '● active' : 'idf.py build flash' },
        { label: '$(zap)  Flash App',            value: 'app_flash',    description: postAction === 'app_flash'    ? '● active' : 'idf.py app-flash' },
    ];
    const pickedPost = await quickPickActive(postItems, postAction, { title: 'Step 3/3: Action AFTER build' });
    if (!pickedPost) return;

    await setCfg('preBuildAction',    pickedPre.value);
    await setCfg('postBuildAction',   pickedPost.value);
    await setCfg('postBuildAnalysis', pickedAnalysis.map(i => i.value));

    const analysisList = pickedAnalysis.length ? pickedAnalysis.map(i => i.label).join(', ') : 'none';
    vscode.window.showInformationMessage(
        `ESP: BEFORE → ${pickedPre.value} | AFTER → ${pickedPost.value} | Analysis → ${analysisList}`
    );
}

async function cmdConfigureBuildSimple() {
    const postAction    = cfg('postBuildAction')   || 'none';
    const savedAnalysis = cfg('postBuildAnalysis') || [];

    const analysisItems = [
        { label: 'Size',            value: 'size',            description: 'idf.py size' },
        { label: 'Size Components', value: 'size-components', description: 'idf.py size-components' },
        { label: 'Size Files',      value: 'size-files',      description: 'idf.py size-files' },
    ].map(item => ({ ...item, picked: savedAnalysis.includes(item.value) }));

    const pickedAnalysis = await vscode.window.showQuickPick(analysisItems, {
        title: 'Step 1/2: Analysis after build (space to toggle)',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    if (!pickedAnalysis) return;

    const postItems = [
        { label: '$(circle-slash)  Do nothing',  value: 'none',         description: postAction === 'none'         ? '● active' : 'stop after build' },
        { label: '$(zap)  Flash',                value: 'flash',        description: postAction === 'flash'        ? '● active' : 'idf.py build flash' },
        { label: '$(zap)  Flash App',            value: 'app_flash',    description: postAction === 'app_flash'    ? '● active' : 'idf.py app-flash' },
    ];
    const pickedPost = await quickPickActive(postItems, postAction, { title: 'Step 2/2: Action AFTER build' });
    if (!pickedPost) return;

    await setCfg('postBuildAction',   pickedPost.value);
    await setCfg('postBuildAnalysis', pickedAnalysis.map(i => i.value));

    const analysisList = pickedAnalysis.length ? pickedAnalysis.map(i => i.label).join(', ') : 'none';
    vscode.window.showInformationMessage(
        `ESP: AFTER → ${pickedPost.value} | Analysis → ${analysisList}`
    );
}

async function cmdConfigureFlash() {
    const currentPost  = cfg('postFlashAction')  || 'none';
    const currentErase = cfg('eraseBeforeFlash') ?? false;

    const eraseItems = [
        { label: '$(circle-slash)  Do nothing',          value: false, description: !currentErase    ? '● active' : 'flash as-is' },
        { label: '$(warning)  Erase Flash before flash', value: true,  description: currentErase     ? '● active' : 'idf.py erase_flash flash' },
    ];
    const pickedErase = await quickPickActive(eraseItems, currentErase, { title: 'Step 1/2: Action BEFORE flash' });
    if (!pickedErase) return;

    const postItems = [
        { label: '$(circle-slash)  Do nothing',  value: 'none',    description: currentPost === 'none'    ? '● active' : 'stop after flash' },
        { label: '$(terminal)  Monitor',    value: 'monitor', description: currentPost === 'monitor' ? '● active' : 'idf.py flash monitor' },
    ];
    const pickedPost = await quickPickActive(postItems, currentPost, { title: 'Step 2/2: Action AFTER flash' });
    if (!pickedPost) return;

    await setCfg('eraseBeforeFlash', pickedErase.value);
    await setCfg('postFlashAction',  pickedPost.value);

    const eraseLabel = pickedErase.value ? 'Erase → ' : '';
    vscode.window.showInformationMessage(`ESP: Flash: ${eraseLabel}Flash → ${pickedPost.value}`);
}

async function cmdConfigureFlashApp() {
    const currentPost = cfg('postFlashAction') || 'none';

    const postItems = [
        { label: '$(circle-slash)  Do nothing',  value: 'none',    description: currentPost === 'none'    ? '● active' : 'stop after flash' },
        { label: '$(terminal)  Monitor',    value: 'monitor', description: currentPost === 'monitor' ? '● active' : 'idf.py app-flash monitor' },
    ];
    const pickedPost = await quickPickActive(postItems, currentPost, { title: 'Action AFTER flash' });
    if (!pickedPost) return;

    await setCfg('postFlashAction', pickedPost.value);
    vscode.window.showInformationMessage(`ESP: Flash App → ${pickedPost.value}`);
}

async function cmdSelectFlashBaud() {
    const picked = await vscode.window.showQuickPick(['9600','19200','38400','57600','74880','115200','230400','460800','921600','1500000','2000000'].map(b => ({ label: b })),
        { title: 'ESP-IDF Tools › Flash Baud Rate' }
    );
    if (picked) await setCfg('flashBaud', parseInt(picked.label, 10));
}

async function cmdSelectFlashMode() {
    const picked = await vscode.window.showQuickPick(['dio','dout','qio','qout'].map(m => ({ label: m })),
        { title: 'ESP-IDF Tools › Flash Mode' }
    );
    if (picked) await setCfg('flashMode', picked.label);
}

async function cmdSelectFlashFreq() {
    const picked = await vscode.window.showQuickPick(['40m','80m','20m','26m'].map(f => ({ label: f })),
        { title: 'ESP-IDF Tools › Flash Frequency' }
    );
    if (picked) await setCfg('flashFreq', picked.label);
}

async function cmdSelectFlashSize() {
    const picked = await vscode.window.showQuickPick(['1MB','2MB','4MB','8MB','16MB'].map(s => ({ label: s })),
        { title: 'ESP-IDF Tools › Flash Size' }
    );
    if (picked) await setCfg('flashSize', picked.label);
}

async function cmdToggleCompressedUpload() {
    await setCfg('useCompressedUpload', !(cfg('useCompressedUpload') ?? true));
}

async function cmdSelectBeforeFlashing() {
    const picked = await vscode.window.showQuickPick([
        { label: 'default_reset',   description: 'Reset to bootloader (default)' },
        { label: 'no_reset',        description: 'No reset' },
        { label: 'no_reset_no_sync',description: 'No reset, no sync' },
    ], { title: 'ESP-IDF Tools › Before Flashing' });
    if (picked) await setCfg('beforeFlashing', picked.label);
}

async function cmdSelectAfterFlashing() {
    const picked = await vscode.window.showQuickPick([
        { label: 'hard_reset', description: 'Hard reset after flashing (default)' },
        { label: 'no_reset',   description: 'No reset' },
    ], { title: 'ESP-IDF Tools › After Flashing' });
    if (picked) await setCfg('afterFlashing', picked.label);
}

async function cmdSelectMonitorBaud() {
    const picked = await vscode.window.showQuickPick(['9600','19200','38400','57600','74880','115200','230400','460800','921600','1500000','2000000'].map(b => ({ label: b })),
        { title: 'ESP-IDF Tools › Monitor Baud Rate' }
    );
    if (picked) await setCfg('monitorBaud', parseInt(picked.label, 10));
}

async function cmdSelectPort() {
    const overrideFlash = cfg('overrideFlashConfig');
    const modeHint = overrideFlash
        ? 'Manual mode — port used for flash & monitor'
        : 'Menuconfig mode — port used for flash & monitor (baud/mode from menuconfig)';

    const ports = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ESP: Searching for ports...' },
        () => detectPorts()
    );
    const items =[
        ...ports.map(p => ({ label: p.name, description: p.desc })),
        { label: '$(edit) Enter manually...', description: '' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: `ESP-IDF Tools › Select Port[${modeHint}]`,
        placeHolder: IS_WIN ? 'COM3, COM4...' : '/dev/ttyUSB0, /dev/ttyACM0...',
    });
    if (!picked) return null;

    let port;
    if (picked.label.includes('Enter manually')) {
        port = await vscode.window.showInputBox({
            prompt: 'Enter port manually',
            placeHolder: IS_WIN ? 'COM3' : '/dev/ttyUSB0',
            value: cfg('comPort') || '',
            validateInput: text => {
                if (!text) return 'Port cannot be empty';
                if (!/^[a-zA-Z0-9./\\\\_-]+$/.test(text)) return 'Invalid characters in port name';
                return null;
            }
        });
    } else {
        port = picked.label;
    }
    if (!port) return null;
    await setCfg('comPort', port);
    vscode.window.showInformationMessage(`ESP: Port → ${port}`);
    return port;
}

// ─── PORT AVAILABILITY CHECK ──────────────────────────────────────────────────
// Returns true if port is physically accessible
function isPortAvailable(port) {
    return new Promise(resolve => {
        if (IS_WIN) {
            // `mode COMx` exits 0 if port exists and not busy, non-0 if absent or locked
            cp.exec(`mode ${port}`, { timeout: 3000 }, err => resolve(!err));
        } else {
            // On Linux/Mac — device file must exist
            resolve(fs.existsSync(port));
        }
    });
}

// Check port, if unavailable — warn and offer to reselect.
// portHolder = { port: 'COM3' }  (object so we can update the value)
// Returns true → proceed with flash, false → abort
async function confirmPortOrReselect(portHolder) {
    const available = await isPortAvailable(portHolder.port);
    if (available) return true;

    const choice = await vscode.window.showWarningMessage(
        `ESP: Port ${portHolder.port} is not available — device not connected?`,
        { modal: true },
        'Select another port'
    );

    if (choice !== 'Select another port') return false;

    const newPort = await cmdSelectPort();
    if (!newPort) return false;
    portHolder.port = newPort;
    return true;
}

async function detectPorts() {
    const now = Date.now();
    if (now - portCache.timestamp < 3000) return portCache.data;

    let ports =[];
    if (IS_WIN)        ports = await detectPortsWindows();
    else if (IS_LINUX) ports = await detectPortsLinux();
    else if (IS_MAC)   ports = await detectPortsMac();

    portCache = { data: ports, timestamp: now };
    return ports;
}

function detectPortsWindows() {
    return new Promise(resolve => {
        const cmd = 'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_PnPEntity | Where-Object {$_.Name -match \'COM[0-9]+\'} | Select-Object -ExpandProperty Name"';
        cp.exec(cmd, { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
            if (err || !stdout?.trim()) { resolve([]); return; }
            const ports =[];
            for (const line of stdout.split('\n').map(l => l.trim()).filter(Boolean)) {
                const m = line.match(/COM(\d+)/);
                if (m) ports.push({ name: `COM${m[1]}`, desc: line.replace(`(COM${m[1]})`, '').trim() });
            }
            ports.sort((a, b) => parseInt(a.name.slice(3)) - parseInt(b.name.slice(3)));
            resolve(ports);
        });
    });
}

function detectPortsLinux() {
    return new Promise(resolve => {
        const ports =[];
        const seen  = new Set();

        const byId = '/dev/serial/by-id';
        if (fs.existsSync(byId)) {
            try {
                for (const link of fs.readdirSync(byId)) {
                    try {
                        const real = fs.realpathSync(path.join(byId, link));
                        if (!seen.has(real)) {
                            seen.add(real);
                            const desc = link.replace(/^usb-/, '').replace(/_if\d+$/, '').replace(/_/g, ' ');
                            ports.push({ name: real, desc });
                        }
                    } catch { /* broken symlink */ }
                }
            } catch { /* no permission */ }
        }

        try {
            for (const f of fs.readdirSync('/dev')) {
                if (!/^(ttyUSB\d+|ttyACM\d+|ttyS[0-3])$/.test(f)) continue;
                const full = `/dev/${f}`;
                if (!seen.has(full)) { seen.add(full); ports.push({ name: full, desc: 'Serial' }); }
            }
        } catch { /* no permission */ }

        ports.sort((a, b) => a.name.localeCompare(b.name));
        resolve(ports);
    });
}

function detectPortsMac() {
    return new Promise(resolve => {
        try {
            const devs = fs.readdirSync('/dev').filter(f =>
                /^cu\.(usb|wch|SLAB)/.test(f)
            );
            resolve(devs.map(d => ({ name: `/dev/${d}`, desc: 'Serial' })));
        } catch { resolve([]); }
    });
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  UTILITIES: SPIFFS, Partition CSV, Reset Config                    ║
// ╚══════════════════════════════════════════════════════════════════╝
async function cmdMakeSpiffs() {
    // ── 1. Check Python
    const pythonCmd = await getPythonCmd();
    if (!pythonCmd) return; // getPythonCmd() already showed the error

    // ── 2. Check SDK folder
    const idfPath = getValidIdfPath();
    if (!idfPath) {
        const ans = await vscode.window.showErrorMessage(
            'ESP SPIFFS: ESP8266 RTOS SDK not found. Set up SDK first.',
            'Set up SDK'
        );
        if (ans === 'Set up SDK') vscode.commands.executeCommand('esp.selectIdf');
        return;
    }

    // ── 3. Check active project folder
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }
    if (!fs.existsSync(path.join(root, 'CMakeLists.txt')) && !fs.existsSync(path.join(root, 'sdkconfig'))) {
        vscode.window.showErrorMessage('ESP SPIFFS: No CMakeLists.txt or sdkconfig found. Is this an ESP-IDF project?');
        return;
    }

    // ── 4. Resolve bundled spiffsgen.py
    const spiffsgenScript = getSpiffsgenScript();

    // ── 5. Select source folder
    const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder to pack into SPIFFS image',
        title: 'SPIFFS: Select source folder',
        defaultUri: vscode.Uri.file(root),
    });
    if (!folderUri || !folderUri[0]) return;
    const dataDir = folderUri[0].fsPath;

    // ── 6. Read SPIFFS parameters from sdkconfig
    const sdkVal = (key, def) => getSdkconfigValue(root, key) || def;

    const pageSize   = sdkVal('CONFIG_SPIFFS_PAGE_SIZE',   '256');
    const blockSize  = sdkVal('CONFIG_WL_SECTOR_SIZE',     '4096');
    const objNameLen = sdkVal('CONFIG_SPIFFS_OBJ_NAME_LEN','32');
    const metaLen    = sdkVal('CONFIG_SPIFFS_META_LENGTH',  '4');
    const useMagic   = sdkVal('CONFIG_SPIFFS_USE_MAGIC',          'y') === 'y' ? '--use-magic'     : '--no-magic';
    const useMagicLen= sdkVal('CONFIG_SPIFFS_USE_MAGIC_LENGTH',   'y') === 'y' ? '--use-magic-len' : '--no-magic-len';

    log(`[spiffs] page=${pageSize} block=${blockSize} obj-name-len=${objNameLen} meta-len=${metaLen} ${useMagic} ${useMagicLen}`);

    // ── 7. Output: project folder, filename = selected folder name + .bin
    const outBin = path.join(root, path.basename(dataDir) + '.bin');

    // ── 8. Select image size — auto or manual
    const flashSizeStr = sdkVal('CONFIG_ESPTOOLPY_FLASHSIZE', '2MB');
    const flashSizeMap = { '256KB':262144, '512KB':524288, '1MB':1048576, '2MB':2097152, '4MB':4194304, '8MB':8388608, '16MB':16777216 };
    const flashBytes   = flashSizeMap[flashSizeStr] || 2097152;
    const BLOCK        = parseInt(blockSize) || 4096;

    // Build preset size options aligned to block size
    const presets = [64, 128, 256, 512, 1024, 2048, 4096]
        .map(kb => kb * 1024)
        .filter(b => b <= flashBytes && b % BLOCK === 0)
        .map(b => ({
            label: b >= 1048576 ? `${b/1048576} MB` : `${b/1024} KB`,
            description: `${b} bytes (0x${b.toString(16).toUpperCase()})`,
            bytes: b
        }));

    const sizeItems = [
        {
            label: '$(wand) Auto',
            description: 'Let spiffsgen.py calculate the minimum required size',
            bytes: null
        },
        ...presets,
        {
            label: '$(pencil) Enter manually...',
            description: 'Type exact size in bytes, KB or hex (e.g. 65536 / 64K / 0x10000)',
            bytes: 'manual'
        }
    ];

    const pickedSize = await vscode.window.showQuickPick(sizeItems, {
        title: 'SPIFFS: Select image size',
        placeHolder: 'Auto — recommended if you are not sure'
    });
    if (!pickedSize) return;

    let imageSizeArg = '';  // empty = auto mode
    if (pickedSize.bytes === 'manual') {
        const input = await vscode.window.showInputBox({
            title: 'SPIFFS: Enter image size',
            prompt: 'Bytes, KB or hex — e.g. 65536 or 64K or 0x10000',
            placeHolder: '0x10000',
            validateInput: v => {
                v = v.trim();
                const n = /^0[xX]/.test(v) ? parseInt(v, 16)
                    : /^\d+[Kk]$/.test(v)   ? parseInt(v) * 1024
                    : parseInt(v);
                if (isNaN(n) || n <= 0)   return 'Enter a positive number';
                if (n % BLOCK !== 0)       return `Size must be a multiple of block size (${BLOCK} bytes)`;
                if (n > flashBytes)        return `Exceeds flash size (${flashSizeStr} = ${flashBytes} bytes)`;
                return null;
            }
        });
        if (!input) return;
        const v = input.trim();
        const n = /^0[xX]/.test(v) ? parseInt(v, 16)
            : /^\d+[Kk]$/.test(v)   ? parseInt(v) * 1024
            : parseInt(v);
        imageSizeArg = String(n);
    } else if (pickedSize.bytes !== null) {
        imageSizeArg = String(pickedSize.bytes);
    }

    // ── 9. Run spiffsgen.py — image_size omitted = auto, or explicit bytes
    const t = getTerm('ESP › Make SPIFFS');
    t.show(true);

    const pycmd = pythonCmd.replace(/^& /, '');
    const spiffsArgs = `--page-size ${pageSize} --block-size ${blockSize} --obj-name-len ${objNameLen} --meta-len ${metaLen} ${useMagic} ${useMagicLen} --aligned-obj-ix-tables`;
    // spiffsgen.py signature: [image_size] base_dir output_file [options]
    // positional args must come before options
    const positional = imageSizeArg
        ? `${imageSizeArg} ${q(dataDir)} ${q(outBin)}`
        : `${q(dataDir)} ${q(outBin)}`;
    const parts = IS_WIN
        ? [`Set-Location ${q(root)}`,
           `& ${pycmd} ${q(spiffsgenScript)} ${positional} ${spiffsArgs}`]
        : [`cd ${q(root)}`,
           `${pycmd} ${q(spiffsgenScript)} ${positional} ${spiffsArgs}`];
    t.sendText(buildCmd(parts));
    const sizeLabel = imageSizeArg ? `${(parseInt(imageSizeArg)/1024).toFixed(0)} KB` : 'auto size';
    vscode.window.showInformationMessage(`ESP SPIFFS: Building image (${sizeLabel}) → ${path.basename(outBin)}`);
}

// Check if custom partition CSV is configured but missing on disk
// Returns true = OK to proceed, false = blocked (user notified)
async function checkPartitionCsv(root) {
    if (!root) return true;
    const csvFilename = getPartitionCsvFilename(root);
    const csvPath = path.join(root, csvFilename);

    // Only warn if sdkconfig explicitly points to a custom file
    const isCustom = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM') === 'y';
    if (!isCustom) return true;               // using built-in table — no CSV needed
    if (fs.existsSync(csvPath)) return true;  // file exists — all good

    const choice = await vscode.window.showErrorMessage(
        `ESP: Partition table file "${csvFilename}" not found.`,
        'Open Partition Editor',
        'Cancel'
    );
    if (choice === 'Open Partition Editor') {
        vscode.commands.executeCommand('esp.partitionEditor');
    }
    return false;
}

function getSdkconfigValue(root, key) {
    for (const fname of ['sdkconfig', 'sdkconfig.defaults']) {
        const p = path.join(root, fname);
        if (fs.existsSync(p)) {
            try {
                const m = fs.readFileSync(p, 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'));
                if (m) return m[1].replace(/^"|"$/g, '').trim();
            } catch {}
        }
    }
    return null;
}

function getPartitionCsvFilename(root) {
    const sdkconfig = path.join(root, 'sdkconfig');
    if (fs.existsSync(sdkconfig)) {
        try {
            const content = fs.readFileSync(sdkconfig, 'utf8');
            const m = content.match(/^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="(.+)"$/m);
            if (m && m[1]) return m[1].trim();
        } catch {}
    }
    const sdkconfigDefaults = path.join(root, 'sdkconfig.defaults');
    if (fs.existsSync(sdkconfigDefaults)) {
        try {
            const content = fs.readFileSync(sdkconfigDefaults, 'utf8');
            const m = content.match(/^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="(.+)"$/m);
            if (m && m[1]) return m[1].trim();
        } catch {}
    }
    return 'partitions.csv';
}

async function cmdResetConfig() {
    const root = getActiveRoot();
    if (!await requireReady()) return;
    if (checkBusy()) return;

    const sdkconfig    = path.join(root, 'sdkconfig');
    const sdkconfigOld = path.join(root, 'sdkconfig.old');

    const exists    = fs.existsSync(sdkconfig);
    const existsOld = fs.existsSync(sdkconfigOld);

    if (!exists && !existsOld) {
        vscode.window.showInformationMessage('ESP: No sdkconfig files found — nothing to reset.');
        return;
    }

    const files = [exists && 'sdkconfig', existsOld && 'sdkconfig.old'].filter(Boolean).join(' + ');
    const choice = await vscode.window.showWarningMessage(
        `ESP: Delete ${files}? All menuconfig settings will be reset to defaults on next build.`,
        { modal: true },
        'Delete', 'Cancel'
    );
    if (choice !== 'Delete') return;

    let deleted = [];
    try { if (exists)    { fs.unlinkSync(sdkconfig);    deleted.push('sdkconfig'); }    } catch (e) { vscode.window.showErrorMessage(`ESP: Failed to delete sdkconfig: ${e.message}`); return; }
    try { if (existsOld) { fs.unlinkSync(sdkconfigOld); deleted.push('sdkconfig.old'); } } catch {}

    vscode.window.showInformationMessage(`ESP: Deleted ${deleted.join(' + ')}. Run Build to regenerate with defaults.`);
    log(`Reset Config: deleted ${deleted.join(', ')}`);
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  PARTITION TABLE EDITOR: Webview                                   ║
// ╚══════════════════════════════════════════════════════════════════╝
function cmdPartitionEditor() {
    const root = getActiveRoot();
    if (!root) { warnNoProject(); return; }

    // Singleton — reveal existing panel instead of opening a duplicate
    if (_partitionPanel) {
        _partitionPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const csvFilename = getPartitionCsvFilename(root);
    const csvPath = path.join(root, csvFilename);

    const panel = vscode.window.createWebviewPanel(
        'espPartitionEditor',
        'ESP Partition Editor',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    let existingCsv = '';
    if (fs.existsSync(csvPath)) {
        try { existingCsv = fs.readFileSync(csvPath, 'utf8'); } catch {}
    }

    // Read PT offset and flash size from sdkconfig (menuconfig values)
    const rawPtOffset  = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
    const rawFlashSize = getSdkconfigValue(root, 'CONFIG_ESPTOOLPY_FLASHSIZE') || null;
    // Map menuconfig flash size string to bytes
    const flashSizeMap = { '512KB':'524288','1MB':'1048576','2MB':'2097152','4MB':'4194304',
                           '512K':'524288','1M':'1048576','2M':'2097152','4M':'4194304' };
    const ptOffsetVal  = rawPtOffset;
    const flashSizeVal = (rawFlashSize && flashSizeMap[rawFlashSize]) ? flashSizeMap[rawFlashSize] : '1048576';
    // Restore bin links from CMakeLists.txt if previously saved
    let _restoredLinks = [];
    const _cmakePath = path.join(root, 'CMakeLists.txt');
    if (fs.existsSync(_cmakePath)) {
        try {
            const _cmakeContent = fs.readFileSync(_cmakePath, 'utf8').replace(/\r\n/g, '\n');
            const _blockMatch = _cmakeContent.match(/# ESP8266 Tools: partition bin links -- BEGIN([\s\S]*?)# ESP8266 Tools: partition bin links -- END/);
            if (_blockMatch) {
                // Parse CSV to get partition order (name → index)
                const _csvLines = existingCsv.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
                const _nameToIdx = {};
                _csvLines.forEach((l, i) => { const p = l.split(',')[0]?.trim(); if (p) _nameToIdx[p] = i; });
                // Parse each esptool_py_flash_project_args line
                const _linkRe = /esptool_py_flash_project_args\s*\(\s*(\S+)\s+\S+\s+"([^"]+)"/g;
                let _m;
                while ((_m = _linkRe.exec(_blockMatch[1])) !== null) {
                    const _name = _m[1], _binPath = _m[2];
                    if (_name in _nameToIdx) _restoredLinks[_nameToIdx[_name]] = _binPath;
                }
            }
        } catch {}
    }

    panel.webview.html = getPartitionEditorHtml(existingCsv, csvFilename, ptOffsetVal, flashSizeVal, _restoredLinks);

    // ── Silently fix bin file sizes on open ───────────────────────────────────
    // If a linked bin file changed size outside VS Code since last save,
    // update the partition SIZE right away without asking the user.
    if (_restoredLinks.length > 0) {
        const BLOCK_OPEN = 4096;
        const _csvLinesOpen = existingCsv.replace(/\r\n/g, '\n').split('\n')
            .filter(l => l.trim() && !l.trim().startsWith('#'));
        const _sizeUpdates = [];
        _restoredLinks.forEach((binPath, i) => {
            if (!binPath) return;
            try {
                const fileSize   = fs.statSync(binPath).size;
                const newSize    = Math.ceil(fileSize / BLOCK_OPEN) * BLOCK_OPEN;
                const parts      = (_csvLinesOpen[i] || '').split(',').map(s => s.trim());
                const currentSz  = parseInt(parts[3] || '0', 16) || parseInt(parts[3] || '0');
                if (newSize !== currentSz && newSize > 0) {
                    _sizeUpdates.push({ index: i, fileSize, newSize });
                    log(`[partitions] open: updated size for index ${i}: ${currentSz} → ${newSize}`);
                }
            } catch { /* file missing — leave as-is, user will see it on Refresh */ }
        });
        if (_sizeUpdates.length > 0) {
            // Small delay so webview is ready to receive messages
            setTimeout(() => {
                panel.webview.postMessage({ command: 'applySizeUpdatesOnOpen', updates: _sizeUpdates });
            }, 300);
        }
    }

    let _lastSavedLinks = _restoredLinks.length ? JSON.parse(JSON.stringify(_restoredLinks)) : null;

    // Helper: patch CMakeLists.txt with bin links
    function patchCMakeWithLinks(binLinks, partitionsCsv) {
        const cmakePath = path.join(root, 'CMakeLists.txt');
        if (!fs.existsSync(cmakePath)) return;
        let cmake = fs.readFileSync(cmakePath, 'utf8');
        cmake = cmake.replace(/\n?# ESP8266 Tools: partition bin links -- BEGIN[\s\S]*?# ESP8266 Tools: partition bin links -- END\n?/g, '');
        const links = (binLinks || []).map((binPath, i) => binPath ? { binPath, i } : null).filter(Boolean);
        if (links.length > 0) {
            const csvLines = (partitionsCsv || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
            const entries = links.map(({ binPath, i }) => {
                const parts = (csvLines[i] || '').split(',').map(s => s.trim());
                const name   = parts[0] || ('part' + i);
                const offset = parts[3] || '0x0';
                const cmakeSafePath = binPath.replace(/\\/g, '/');
                return '    esptool_py_flash_project_args(' + name + ' ' + offset + ' "' + cmakeSafePath + '" FLASH_IN_PROJECT)';
            }).filter(Boolean);
            if (entries.length > 0) {
                cmake += '\n# ESP8266 Tools: partition bin links -- BEGIN\nif(CONFIG_PARTITION_TABLE_CUSTOM)\n' + entries.join('\n') + '\nendif()\n# ESP8266 Tools: partition bin links -- END\n';
            }
        }
        fs.writeFileSync(cmakePath, cmake, 'utf8');
    }

    panel.webview.onDidReceiveMessage(msg => {
        // Always recalculate csvFilename/csvPath in case sdkconfig changed after refresh
        const currentCsvFilename = getPartitionCsvFilename(root);
        const currentCsvPath     = path.join(root, currentCsvFilename);

        if (msg.command === 'setDirty') { _panelIsDirty = msg.dirty; return; }

        if (msg.command === 'linkBin') {
            vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                filters: { 'Binary files': ['bin'], 'All files': ['*'] },
                title: 'Link .bin file to partition', openLabel: 'Link',
            }).then(uris => {
                if (!uris || !uris[0]) return;
                const binPath = uris[0].fsPath;
                let fileSize = 0;
                try { fileSize = fs.statSync(binPath).size; } catch { }

                const BLOCK = 4096;
                // Round file size up to block boundary
                const requiredSize = Math.ceil(fileSize / BLOCK) * BLOCK;

                // ── Calculate free space at the target partition's position ──
                const idx        = msg.index;
                const parts      = msg.partitions || [];
                const flashSize  = msg.flashSize  || 1048576;

                const parseHex = s => {
                    if (!s) return NaN;
                    s = String(s).trim().replace(/_/g, '');
                    if (/^0[xX]/.test(s)) return parseInt(s, 16);
                    const m = s.match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
                    if (!m) return NaN;
                    const n = parseFloat(m[1]);
                    return Math.floor(m[2].toUpperCase() === 'K' ? n*1024 : m[2].toUpperCase() === 'M' ? n*1048576 : n);
                };

                const thisOffset = parseHex(parts[idx]?.offset);

                // Find the start of the next partition after idx (or end of flash)
                let nextStart = flashSize;
                parts.forEach((p, j) => {
                    if (j === idx) return;
                    const off = parseHex(p.offset);
                    if (!isNaN(off) && off > thisOffset) nextStart = Math.min(nextStart, off);
                });

                const freeBytes = isNaN(thisOffset) ? flashSize : nextStart - thisOffset;

                if (requiredSize > freeBytes) {
                    vscode.window.showErrorMessage(
                        `ESP: File "${path.basename(binPath)}" requires ${(requiredSize/1024).toFixed(1)} KB ` +
                        `but only ${(freeBytes/1024).toFixed(1)} KB is available for this partition. Operation cancelled.`
                    );
                    return;
                }

                // All good — set SIZE to requiredSize and link the file
                panel.webview.postMessage({ command: 'setBinLink', index: idx, binPath, fileSize, newSize: requiredSize });
            });
        }

        if (msg.command === 'save') {
            // ── Check bin file sizes before writing ───────────────────────────
            const BLOCK_SAVE = 4096;
            const flashBytesStr = getSdkconfigValue(root, 'CONFIG_ESPTOOLPY_FLASHSIZE') || '2MB';
            const flashBytesMap = { '512KB':524288,'1MB':1048576,'2MB':2097152,'4MB':4194304,
                                    '512K':524288,'1M':1048576,'2M':2097152,'4M':4194304 };
            const flashTotal = flashBytesMap[flashBytesStr] || 2097152;
            const csvPartitions = (msg.csv || '').split('\n')
                .filter(l => l.trim() && !l.trim().startsWith('#'))
                .map(l => { const p = l.split(',').map(s => s.trim()); return { name: p[0], offset: parseInt(p[3], 16) || 0 }; });
            const sizeErrors = (msg.binLinks || []).map((binPath, i) => {
                if (!binPath) return null;
                try {
                    const fileSize  = fs.statSync(binPath).size;
                    const required  = Math.ceil(fileSize / BLOCK_SAVE) * BLOCK_SAVE;
                    const part      = csvPartitions[i];
                    if (!part) return null;
                    const nextStart = csvPartitions
                        .filter((p, j) => j !== i && p.offset > part.offset)
                        .reduce((min, p) => Math.min(min, p.offset), flashTotal);
                    const freeArea  = nextStart - part.offset;
                    if (required > freeArea) {
                        return `"${path.basename(binPath)}" (${(required/1024).toFixed(0)} KB) exceeds free area of "${part.name}" (${(freeArea/1024).toFixed(0)} KB)`;
                    }
                } catch { return null; }
                return null;
            }).filter(Boolean);
            if (sizeErrors.length > 0) {
                vscode.window.showErrorMessage(
                    `ESP: Bin file too large — ${sizeErrors.join('; ')}. Resize the partition first.`
                );
                return;
            }
            // ─────────────────────────────────────────────────────────────────
            try {
                fs.writeFileSync(currentCsvPath, msg.csv, 'utf8');
                const linksChanged = JSON.stringify(msg.binLinks) !== JSON.stringify(_lastSavedLinks);
                patchCMakeWithLinks(msg.binLinks, msg.csv);
                _lastSavedLinks = JSON.parse(JSON.stringify(msg.binLinks || []));
                vscode.window.showInformationMessage(`✅ Saved: ${currentCsvFilename}`);
                const isCustomPt = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM') === 'y';
                if (linksChanged && isCustomPt) runIdf(['reconfigure'], 'ESP › Reconfigure', false);
            } catch (e) {
                vscode.window.showErrorMessage(`ESP: Failed to save CSV: ${e.message}`);
            }
        }
        if (msg.command === 'saveWithErrors') {
            vscode.window.showWarningMessage(
                `ESP: Partition table has validation errors. Save anyway?`,
                'Save', 'Cancel'
            ).then(choice => {
                if (choice === 'Save') {
                    try {
                        fs.writeFileSync(currentCsvPath, msg.csv, 'utf8');
                        const linksChanged2 = JSON.stringify(msg.binLinks) !== JSON.stringify(_lastSavedLinks);
                        patchCMakeWithLinks(msg.binLinks, msg.csv);
                        _lastSavedLinks = JSON.parse(JSON.stringify(msg.binLinks || []));
                        vscode.window.showInformationMessage(`✅ Saved: ${currentCsvFilename}`);
                        const isCustomPt2 = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_CUSTOM') === 'y';
                        if (linksChanged2 && isCustomPt2) runIdf(['reconfigure'], 'ESP › Reconfigure', false);
                    } catch (e) {
                        vscode.window.showErrorMessage(`ESP: Failed to save CSV: \${e.message}`);
                    }
                }
            });
        }
        if (msg.command === 'open') {
            if (!fs.existsSync(currentCsvPath)) {
                vscode.window.showWarningMessage(`CSV file not found: ${currentCsvFilename}. Save first.`);
                return;
            }
            vscode.workspace.openTextDocument(currentCsvPath).then(doc =>
                vscode.window.showTextDocument(doc, vscode.ViewColumn.Two)
            );
        }
        if (msg.command === 'refresh') { pushSdkconfigUpdate(); }

        if (msg.command === 'binSizeWarnings') {
            vscode.window.showInformationMessage(
                `ESP Partitions: ${msg.warnings.join(' | ')}`
            );
            return;
        }
    });

    // Free panel resources when user closes the tab
    function pushSdkconfigUpdate() {
        const newPtOffset  = getSdkconfigValue(root, 'CONFIG_PARTITION_TABLE_OFFSET') || '0x8000';
        const newFlashRaw  = getSdkconfigValue(root, 'CONFIG_ESPTOOLPY_FLASHSIZE') || null;
        const flashSizeMap = { '512KB':'524288','1MB':'1048576','2MB':'2097152','4MB':'4194304',
                               '512K':'524288','1M':'1048576','2M':'2097152','4M':'4194304' };
        const newFlashSize = (newFlashRaw && flashSizeMap[newFlashRaw]) ? flashSizeMap[newFlashRaw] : '1048576';
        const newCsvFilename = getPartitionCsvFilename(root);

        // Re-check sizes of all linked bin files — user may have changed them outside VS Code
        // Returns array of { index, fileSize, newSize (rounded to block), warning? }
        const BLOCK = 4096;
        const binSizeUpdates = (_lastSavedLinks || []).map((binPath, i) => {
            if (!binPath) return null;
            try {
                const fileSize = fs.statSync(binPath).size;
                const newSize  = Math.ceil(fileSize / BLOCK) * BLOCK;
                return { index: i, fileSize, newSize };
            } catch {
                // File no longer exists
                return { index: i, fileSize: 0, newSize: 0, missing: true };
            }
        }).filter(Boolean);

        panel.webview.postMessage({
            command: 'sdkconfigUpdate',
            ptOffset: newPtOffset,
            flashSize: newFlashSize,
            csvFilename: newCsvFilename,
            binSizeUpdates
        });
    }
    _partitionPanel = panel;
    _pushSdkconfigUpdate = pushSdkconfigUpdate; // expose for auto-refresh after menuconfig
    let _panelIsDirty = false;

    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.visible) {
            pushSdkconfigUpdate();
            if (_globalBusy) {
                panel.webview.postMessage({ command: 'setBusy', busy: true, task: _globalBusyName });
            }
        }
    });
    panel.onDidDispose(() => {
        if (_panelIsDirty) {
            vscode.window.showWarningMessage(
                'ESP Partition Editor was closed with unsaved changes.'
            );
        }
        _partitionPanel = null;
        _pushSdkconfigUpdate = null;
    }, null, []);
}

function getPartitionEditorHtml(existingCsv, csvFilename, ptOffsetVal, flashSizeVal, restoredLinks = []) {
    const existingData       = JSON.stringify(parseCsvToPartitions(existingCsv));
    const restoredLinksData  = JSON.stringify(restoredLinks || []);
    const safePtOffset  = String(ptOffsetVal  || '0x8000').replace(/[^0-9xa-fA-F]/g,'');
    const safeFlashSize = String(flashSizeVal || '1048576').replace(/[^0-9]/g,'');
    const safeFilename = (csvFilename || 'partitions.csv').replace(/[<>"']/g, '');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>ESP Partition Editor</title>
<style>
  :root {
    --bg:      var(--vscode-editor-background);
    --bg2:     var(--vscode-sideBar-background,         var(--vscode-editor-background));
    --bg3:     var(--vscode-input-background,            #2d2d30);
    --border:  var(--vscode-panel-border,               var(--vscode-editorGroup-border, #3e3e42));
    --accent:  var(--vscode-button-background,          #007acc);
    --accent2: var(--vscode-button-hoverBackground,     #0098ff);
    --text:    var(--vscode-editor-foreground);
    --text2:   var(--vscode-editorInfo-foreground,      var(--vscode-editor-foreground));
    --error:   var(--vscode-editorError-foreground,     #f44747);
    --warn:    var(--vscode-editorWarning-foreground,   #cca700);
    --ok:      var(--vscode-terminal-ansiGreen,         #4ec9b0);
    --input-fg:     var(--vscode-input-foreground,      var(--vscode-editor-foreground));
    --input-bg:     var(--vscode-input-background);
    --input-border: var(--vscode-input-border,          var(--vscode-panel-border));
    --btn-fg:       var(--vscode-button-foreground,     #fff);
    --btn-bg:       var(--vscode-button-background,     #007acc);
    --btn-hover:    var(--vscode-button-hoverBackground,#0098ff);
    --btn2-bg:      var(--vscode-button-secondaryBackground,   var(--vscode-editor-background));
    --btn2-fg:      var(--vscode-button-secondaryForeground,   var(--vscode-editor-foreground));
    --btn2-hover:   var(--vscode-button-secondaryHoverBackground, var(--vscode-input-background));
    --table-header: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
    --row-hover:    var(--vscode-list-hoverBackground);
    --select-bg:    var(--vscode-dropdown-background,   var(--vscode-input-background));
    --select-fg:    var(--vscode-dropdown-foreground,   var(--vscode-editor-foreground));
    --select-border:var(--vscode-dropdown-border,       var(--vscode-input-border));
    --free-seg:     var(--vscode-editorGutter-background, rgba(128,128,128,0.15));
    --subtitle-fg:  var(--vscode-descriptionForeground, #888);
    --badge-bg:     var(--vscode-badge-background,      #4d4d4d);
    --badge-fg:     var(--vscode-badge-foreground,      #fff);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); font-size: var(--vscode-font-size, 13px); padding: 16px; position: relative; }
  h2 { color: var(--text2); margin-bottom: 4px; font-size: 16px; font-weight: 600; }
  .subtitle { color: var(--subtitle-fg); margin-bottom: 16px; font-size: 12px; }
  code { background: var(--badge-bg); color: var(--badge-fg); padding: 1px 5px; border-radius: 3px; font-size: 11px; }

  .flash-map-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 16px; }
  .flash-map-wrap h3 { color: var(--subtitle-fg); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  #flashMap { display: flex; height: 36px; border-radius: 4px; overflow: hidden; width: 100%; border: 1px solid var(--border); }
  #flashMap .seg { display: flex; align-items: center; justify-content: center; font-size: 10px;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; transition: flex 0.3s;
    cursor: default; border-right: 1px solid rgba(0,0,0,0.15); }
  #flashMap .seg:last-child { border-right: none; }
  #flashMap .seg.free {
    background-image: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(128,128,128,0.15) 4px, rgba(128,128,128,0.15) 8px);
    background-color: rgba(128,128,128,0.07); color: var(--subtitle-fg);
  }
  .legend { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--subtitle-fg); }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }

  .toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
  button { background: var(--btn2-bg); color: var(--btn2-fg); border: 1px solid var(--border); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--btn2-hover); border-color: var(--border); }
  button.primary { background: var(--btn-bg); border-color: var(--btn-bg); color: var(--btn-fg); }
  button.primary:hover { background: var(--btn-hover); border-color: var(--btn-hover); }
  button.danger:hover { background: var(--error); border-color: var(--error); color: #fff; }
  .flash-size-sel { background: var(--select-bg); color: var(--select-fg); border: 1px solid var(--select-border); padding: 5px 8px; border-radius: 4px; font-size: 12px; }

  .table-wrap { overflow-x: auto; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--table-header); color: var(--subtitle-fg); font-weight: 500; padding: 6px 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid var(--border); white-space: nowrap; }
  tr.part-row { border-bottom: 1px solid var(--border); }
  tr.part-row:hover { background: var(--row-hover); }
  tr.part-row.has-error td { background: rgba(244,71,71,0.06); }
  td { padding: 4px 4px; vertical-align: middle; }
  td input, td select { background: transparent; color: var(--input-fg); border: 1px solid transparent; padding: 4px 6px; border-radius: 3px; font-size: 12px; width: 100%; font-family: var(--vscode-editor-font-family, 'Consolas', monospace); }
  td input:focus, td select:focus { outline: none; border-color: var(--accent); background: var(--input-bg); }
  td select { background: var(--select-bg); color: var(--select-fg); cursor: pointer; }
  td input.invalid { border-color: var(--error) !important; }
  .drag-handle { color: var(--subtitle-fg); cursor: grab; padding: 0 6px; font-size: 16px; user-select: none; opacity: 0.5; }
  .drag-handle:hover { opacity: 1; }
  .drag-handle:active { cursor: grabbing; }
  .col-drag  { width: 28px; text-align: center; }
  .col-name  { width: 140px; }
  .col-type  { width: 80px; min-width: 80px; max-width: 80px; }
  .col-sub   { width: 80px; min-width: 80px; max-width: 80px; }
  .col-type select, .col-sub select, .col-sub input { width: 100%; max-width: 100%; box-sizing: border-box; }
  .col-off   { width: 50px; }
  .col-size  { width: 50px; }
  .col-del   { width: 36px; padding: 0; position: relative; }
  .col-link  { width: 140px; padding: 0 4px; }
  td.col-link { padding-left: 54px; }
  .link-btn  { font-size: 11px; padding: 2px 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; display: inline-block; vertical-align: middle; }
  .link-btn.linked { background: #2d7a2d; color: #fff; border-color: #2d7a2d; }
  .link-btn.linked:hover { background: #3a9a3a; }
  .link-clear { background: none; border: none; color: var(--subtitle-fg); font-size: 14px; padding: 2px 4px; cursor: pointer; opacity: 0.5; vertical-align: middle; }
  .link-clear:hover { color: var(--error); opacity: 1; }
  .page-header  { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px; }
  .page-header > div { flex:1; }
  .refresh-btn  { flex-shrink:0; align-self:center; font-size:12px; padding:4px 14px; opacity:0.8; }
  .refresh-btn:hover { opacity:1; }
  .info-badge { display:inline-block; font-size:13px; cursor:default; }
  .menuconfig-info   { display:inline-flex; flex-direction:column; align-items:flex-start; gap:2px; cursor:default; }
  .menuconfig-label  { color:var(--subtitle-fg); font-size:11px; }
  .menuconfig-value  { font-family:var(--vscode-editor-font-family,monospace); font-size:13px; background:var(--badge-bg); color:var(--badge-fg); padding:1px 6px; border-radius:3px; }
  .badge-off  { opacity:0.25; }
  .del-btn { position: absolute; right: 15px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--subtitle-fg); font-size: 16px; padding: 2px 4px; cursor: pointer; opacity: 0.5; }
  .del-btn:hover { color: var(--error); background: none; opacity: 1; }
  .size-hint { font-size: 10px; color: var(--subtitle-fg); display: block; opacity: 0.7; }
  .hex-wrap         { display: flex; align-items: center; gap: 2px; }
  .hex-wrap input   { flex: 1; min-width: 0; }
  .dd-btn           { flex-shrink:0; background: var(--btn-bg); border: 1px solid var(--border);
                      color: var(--fg); border-radius: 3px; padding: 2px 5px; cursor: pointer;
                      font-size: 10px; line-height: 1; opacity: 0.7; }
  .dd-btn:hover     { opacity: 1; }
  /* Portal dropdown — fixed, renders above everything */
  #ddPortal         { position: fixed; z-index: 99999; display: none;
                      background: var(--vscode-dropdown-background, var(--editor-bg));
                      border: 1px solid var(--border); border-radius: 4px;
                      box-shadow: 0 4px 16px rgba(0,0,0,0.45); padding: 4px 0;
                      min-width: 240px; max-height: 280px; overflow-y: auto; }
  #ddPortal.open    { display: block; }
  .dd-item          { padding: 5px 12px; cursor: pointer; font-family: monospace; font-size: 12px;
                      white-space: nowrap; }
  .dd-item:hover    { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
  .dd-item .dd-val  { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); min-width: 80px; display: inline-block; }
  .dd-item .dd-desc { color: var(--subtitle-fg); font-size: 11px; margin-left: 8px; }

  #errorBox { background: rgba(244,71,71,0.1); border: 1px solid var(--error); border-radius: 4px; padding: 8px 12px; margin-bottom: 12px; display: none; }
  #errorBox ul { padding-left: 16px; }
  #errorBox li { color: var(--error); font-size: 12px; margin: 2px 0; }

  .status-bar { display: flex; gap: 16px; font-size: 11px; color: var(--subtitle-fg); flex-wrap: wrap; }
  .status-bar span b { color: var(--text); }
  .used-pct { color: var(--ok); }
  .row-dragging { opacity: 0.4; }
  .row-dragover td { border-top: 2px solid var(--accent); }
</style>
</head>
<body>
<div id="ddPortal"></div>
<div class="page-header">
  <div>
    <h2>⚡ ESP Partition Table Editor</h2>
    <p class="subtitle">Visual editor for ESP8266 flash partitions → saves to <code id="csvFilenameLabel" title="Filename from Projectconfig → Partition Table → Custom partition CSV file (CONFIG_PARTITION_TABLE_CUSTOM_FILENAME)">${safeFilename}</code></p>
  </div>
  <button class="refresh-btn" onclick="vscode.postMessage({command:'refresh'})" title="Reload PT offset, Flash size and partition filename from Projectconfig">↺ Refresh</button>
</div>

<div class="flash-map-wrap">
  <h3>Flash map</h3>
  <div id="flashMap"></div>
  <div class="legend" id="legend"></div>
</div>

<div id="errorBox"><ul id="errorList"></ul></div>

<div class="toolbar">
  <button onclick="addRow()">＋ Add Partition</button>
  <button onclick="resetDefault()">↺ Default Partition</button>
  <button onclick="autoOffsets();render();" title="Recalculate all offsets sequentially from PT end, respecting 1MB boundary">⟳ Auto Offsets</button>
  <div style="flex:1"></div>
  <span class="menuconfig-info" title="Partition Table Offset\nSource: menuconfig → Partition Table → Offset (CONFIG_PARTITION_TABLE_OFFSET)">
    <span class="menuconfig-label">PT offset:</span>
    <code id="ptOffset" class="menuconfig-value">${safePtOffset}</code>
  </span>
  <span class="menuconfig-info" title="Flash Size\nSource: menuconfig → Serial Flasher Config → Flash Size (CONFIG_ESPTOOLPY_FLASHSIZE)">
    <span class="menuconfig-label">Flash size:</span>
    <code id="flashSizeDisplay" class="menuconfig-value">${safeFlashSize === '524288' ? '512 KB' : safeFlashSize === '1048576' ? '1 MB' : safeFlashSize === '2097152' ? '2 MB' : safeFlashSize === '4194304' ? '4 MB' : safeFlashSize + ' B'}</code>
    <input type="hidden" id="flashSizeSel" value="${safeFlashSize}"/>
  </span>
  <button class="primary" id="saveCsvBtn" onclick="save()">💾 Save</button>

</div>

<div class="table-wrap">
<table id="partTable">
<thead>
  <tr>
    <th class="col-drag"></th>
    <th class="col-name">Name</th>
    <th class="col-type">Type</th>
    <th class="col-sub">SubType</th>
    <th class="col-off">Offset</th>
    <th class="col-size">Size</th>
    <th class="col-link">Link to bin</th>
    <th class="col-del"></th>
  </tr>
</thead>
<tbody id="partBody"></tbody>
</table>
</div>

<div class="status-bar" id="statusBar"></div>

<script>
const vscode = acquireVsCodeApi();

const COLORS =['#4ec9b0','#569cd6','#c586c0','#dcdcaa','#ce9178','#9cdcfe','#4fc1ff','#b5cea8','#f44747','#cca700'];
const APP_SUBTYPES  =['factory','ota_0','ota_1'];
const DATA_SUBTYPES =['nvs','ota','phy','fat','spiffs'];

let partitions = ${existingData};
let dragSrc = null;
let binLinks = ${restoredLinksData};  // restored from CMakeLists.txt
let binFileSizes = new Array(binLinks.length).fill(0);

if (!partitions.length) resetDefault();
render();

function resetDefault() {
  setDirty();
  // ESP8266 hardware limit: app partition MUST NOT cross 1MB boundary.
  // factory starts at 0x10000, so max size = 0x100000 - 0x10000 = 0xF0000 (960KB).
  // Remaining flash (if any) is left free for user to add data partitions.
  partitions = [
    { name:'nvs',      type:'data', subtype:'nvs',     offset:'0x9000',  size:'0x6000',  encrypted:false },
    { name:'phy_init', type:'data', subtype:'phy',     offset:'0xf000',  size:'0x1000',  encrypted:false },
    { name:'factory',  type:'app',  subtype:'factory', offset:'0x10000', size:'0xF0000', encrypted:false },
  ];
  render();
}

function parseSize(s) {
  if (!s) return NaN;
  s = s.trim().replace(/_/g,'');
  if (/^0[xX]/.test(s)) return parseInt(s, 16);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KkMm]?)$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const v = m[2].toUpperCase() === 'K' ? n*1024 : m[2].toUpperCase() === 'M' ? n*1048576 : n;
  return Math.floor(v);
}

function fmtHex(n) {
  // No artificial padding — keep natural hex (0x9000 not 0x09000)
  return '0x' + n.toString(16).toUpperCase();
}

function getPtOffset() {
  const el = document.getElementById('ptOffset'); const raw = (el ? (el.value || el.textContent) : '0x8000').trim();
  const v = parseSize(raw);
  return isNaN(v) ? 0x8000 : v;
}
function getPtEnd() { return getPtOffset() + 0x1000; }

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtSize(n) {
  if (n >= 1048576 && n%1048576===0) return (n/1048576)+'M';
  if (n >= 1024    && n%1024===0)    return (n/1024)+'K';
  return fmtHex(n);
}

// ФИКС ОШИБКИ ESP8266_RTOS_SDK: Разделы 'app' ОБЯЗАНЫ быть выровнены по 64KB (0x10000).
function autoOffsets() {
  let cursor = getPtEnd();
  partitions.forEach(p => {
    const sz = parseSize(p.size);
    // Выравнивание: 64 КБ для app, 4 КБ для data
    let align = (p.type === 'app') ? 0x10000 : 0x1000;
    
    if (cursor % align !== 0) cursor = Math.ceil(cursor / align) * align;

    if (p.type === 'app' && !isNaN(sz)) {
      if (sz <= 0x100000) {
        const mb1start = Math.floor(cursor / 0x100000) * 0x100000;
        const mb1end   = mb1start + 0x100000;
        if (cursor + sz > mb1end) {
            cursor = mb1end; 
        }
      }
    }
    
    p.offset = fmtHex(cursor);
    if (!isNaN(sz)) cursor += sz;
  });
}

function validate() {
  const errors =[];
  const flashSize = parseInt(document.getElementById('flashSizeSel').value || '1048576');
  const ptEnd = getPtEnd();
  const ptOffset = getPtOffset();
  let regions =[];

  if (isNaN(ptOffset)) errors.push(\`Partition table offset is invalid\`);
  if (ptOffset + 0x1000 > flashSize) errors.push(\`Partition table offset \${fmtHex(ptOffset)} exceeds flash size\`);

  partitions.forEach((p, i) => {
    const off = parseSize(p.offset);
    const sz  = parseSize(p.size);
    if (!p.name.trim())            errors.push(\`Row \${i+1}: name is empty\`);
    if (p.name.length > 16)        errors.push(\`Row \${i+1} "\${p.name}": name too long (max 16)\`);
    if (/[^a-zA-Z0-9_]/.test(p.name)) errors.push(\`Row \${i+1} "\${p.name}": name may only contain a-z, 0-9, _\`);
    if (isNaN(off))                errors.push(\`Row \${i+1} "\${p.name}": invalid offset "\${p.offset}"\`);
    if (isNaN(sz) || sz <= 0)      errors.push(\`Row \${i+1} "\${p.name}": invalid size "\${p.size}"\`);
    if (p.type !== 'app' && p.type !== 'data') {
      const t = parseSize(p.type);
      if (!isNaN(t) && t < 0x40)   errors.push(\`Row \${i+1} "\${p.name}": custom type \${fmtHex(t)} is in reserved range 0x00-0x3F (SDK use only). Use 0x40-0xFE.\`);
      if (!isNaN(t) && t > 0xFE)   errors.push(\`Row \${i+1} "\${p.name}": custom type \${fmtHex(t)} exceeds max allowed value 0xFE.\`);
      // Validate custom subtype
      const st = parseSize(p.subtype);
      if (isNaN(st))                errors.push(\`Row \${i+1} "\${p.name}": invalid subtype "\${p.subtype}" — must be hex (0x00-0xFE) or decimal (0-254).\`);
      else if (st > 0xFE)           errors.push(\`Row \${i+1} "\${p.name}": subtype \${fmtHex(st)} exceeds max allowed value 0xFE (subtype is uint8_t).\`);
    }
    
    if (!isNaN(off) && !isNaN(sz)) {
      // ФИКС: Проверка выравнивания 64КБ для APP-разделов
      if (p.type === 'app' && off % 0x10000 !== 0) {
        errors.push(\`Row \${i+1} "\${p.name}": app partition offset \${fmtHex(off)} MUST be aligned to 64KB (0x10000)\`);
      } else if (off % 0x1000 !== 0) {
        errors.push(\`Row \${i+1} "\${p.name}": offset \${fmtHex(off)} not aligned to 4KB (0x1000)\`);
      }
      
      if (sz % 0x1000 !== 0)       errors.push(\`Row \${i+1} "\${p.name}": size \${fmtHex(sz)} not aligned to 4KB (0x1000)\`);
      if (off + sz > flashSize)    errors.push(\`Row \${i+1} "\${p.name}": exceeds flash size (\${fmtHex(off+sz)} > \${fmtHex(flashSize)})\`);
      if (off < ptEnd)             errors.push(\`Row \${i+1} "\${p.name}": offset \${fmtHex(off)} overlaps partition table (\${fmtHex(ptOffset)}–\${fmtHex(ptEnd)})\`);
      
      if (p.type === 'app') {
        const mb1start = Math.floor(off / 0x100000) * 0x100000;
        const mb1end   = mb1start + 0x100000;
        if (off + sz > mb1end) errors.push(\`Row \${i+1} "\${p.name}": ⚠️ app partition crosses 1MB boundary! ESP8266 will crash. End: \${fmtHex(off+sz)}, 1MB boundary: \${fmtHex(mb1end)}\`);
      }
      regions.push({ name: p.name, start: off, end: off + sz, i });
    }
  });

  for (let a = 0; a < regions.length; a++) {
    for (let b = a+1; b < regions.length; b++) {
      if (regions[a].start < regions[b].end && regions[b].start < regions[a].end)
        errors.push(\`Overlap: "\${regions[a].name}" and "\${regions[b].name}"\`);
    }
  }

  const names = partitions.map(p => p.name.trim()).filter(Boolean);
  names.forEach((n, i) => { if (names.indexOf(n) !== i) errors.push(\`Duplicate name: "\${n}"\`); });

  const sorted = [...partitions]
    .map(p => ({ ...p, off: parseSize(p.offset) }))
    .filter(p => !isNaN(p.off))
    .sort((a,b) => a.off - b.off);
  const phyIdx  = sorted.findIndex(p => p.subtype === 'phy');
  const ota0Idx = sorted.findIndex(p => p.type === 'app' && p.subtype !== 'factory' && p.subtype !== 'test');
  if (phyIdx !== -1 && ota0Idx !== -1 && phyIdx > ota0Idx) {
    errors.push(\`⚠️ SDK rule: "phy_init" must be placed BEFORE any OTA app partition (ota_0/ota_1/...) in flash address order\`);
  }

  partitions.forEach((p, i) => {
    if (p.type === 'app' && (!p.offset || p.offset.trim() === '')) {
      errors.push(\`Row \${i+1} "\${p.name}": app partition offset must not be empty — SDK auto-align may cause 1MB boundary overlap!\`);
    }
  });

  return errors;
}

function render() {
  syncLinks();
  renderTable();
  renderMap();
  renderStatus();
  renderErrors();
}

function updateOnlyStatusAndMap() {
    renderMap();
    renderStatus();
    renderErrors();
    partitions.forEach((p, i) => {
        const sz = parseSize(p.size);
        const sh = document.getElementById('sh'+i);
        if (sh && !isNaN(sz)) {
            let hint = sz >= 1048576 ? (sz/1048576).toFixed(1)+'MB' : sz >= 1024 ? (sz/1024).toFixed(1)+'KB' : sz+'B';
            if (p.subtype === 'nvs'  && sz < 0x3000) hint += ' ⚠ min 12KB';
            if (p.subtype === 'ota'  && sz !== 0x2000) hint += ' ⚠ must be 8KB';
            sh.textContent = hint;
        } else if (sh) {
            sh.textContent = '';
        }
    });
}

function renderTable() {
  const tbody = document.getElementById('partBody');
  tbody.innerHTML = '';

  partitions.forEach((p, i) => {
    const subtypes = p.type === 'app' ? APP_SUBTYPES : p.type === 'data' ? DATA_SUBTYPES : [];
    const color = COLORS[i % COLORS.length];
    const tr = document.createElement('tr');
    tr.className = 'part-row';
    tr.draggable = true;
    tr.dataset.idx = i;

    tr.innerHTML = \`
      <td class="col-drag"><span class="drag-handle" title="Drag to reorder">⠿</span></td>
      <td class="col-name">
        <input value="\${esc(p.name)}" oninput="update(\${i},'name',this.value)" style="border-left:3px solid \${color}" />
      </td>
      <td class="col-type">
        <select onchange="update(\${i},'type',this.value)">
          <option \${p.type==='app' ?'selected':''}>app</option>
          <option \${p.type==='data'?'selected':''}>data</option>
          <option \${p.type!=='app'&&p.type!=='data'?'selected':''} value="\${p.type!=='app'&&p.type!=='data'?p.type:'0x40'}">custom…</option>
        </select>
      </td>
      <td class="col-sub">
        \${(p.type==='app'||p.type==='data')
          ? \`<select onchange="update(\${i},'subtype',this.value)">
              \${subtypes.map(s=>\`<option \${p.subtype===s?'selected':''}>\${s}</option>\`).join('')}
            </select>\`
          : \`<input value="\${p.subtype}" oninput="update(\${i},'subtype',this.value)" placeholder="0x00" title="Hex subtype for custom type"/>\`
        }
      </td>
      <td class="col-off">
        <div class="hex-wrap">
          <input id="offIn\${i}" value="\${p.offset}" oninput="update(\${i},'offset',this.value)" placeholder="0x9000" />
          <button class="dd-btn" onclick="toggleDd(this,'off',\${i})" tabindex="-1" title="Show offset suggestions">▾</button>
        </div>
      </td>
      <td class="col-size">
        <div class="hex-wrap">
          <input id="szIn\${i}" value="\${p.size}" oninput="update(\${i},'size',this.value)" placeholder="0x6000"
            \${binLinks[i] ? 'readonly title="Size is controlled by the linked .bin file" style="opacity:0.5;cursor:not-allowed"' : ''} />
          \${binLinks[i] ? '' : \`<button class="dd-btn" onclick="toggleDd(this,'sz',\${i})" tabindex="-1" title="Show size suggestions">▾</button>\`}
        </div>
        <span class="size-hint" id="sh\${i}"></span>
      </td>
      <td class="col-link">
        \${(['fat','spiffs'].includes(p.subtype))
          ? (binLinks[i]
              ? \`<span title="\${binLinks[i]}"><button class="link-clear" onclick="clearLink(\${i})" title="Remove link" style="margin-right:6px">✕</button><button class="link-btn linked" onclick="linkBin(\${i})" title="\${binLinks[i]}">\${binLinks[i].replace(/\\\\/g,'/').split('/').pop()}</button></span>\`
              : \`<button class="link-btn" onclick="linkBin(\${i})" title="Link a .bin file to this partition">+ Link bin</button>\`)
          : ''
        }
      </td>
      <td class="col-del">
        <button class="del-btn" onclick="delRow(\${i})" title="Delete">✕</button>
      </td>
    \`;

    // Drag only from handle — prevent accidental drag from inputs/selects
    tr.draggable = false;
    const handle = tr.querySelector('.drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => { tr.draggable = true; });
      handle.addEventListener('mouseup',   () => { tr.draggable = false; });
    }
    tr.addEventListener('dragstart', e => { dragSrc = i; tr.classList.add('row-dragging'); e.dataTransfer.effectAllowed = 'move'; });
    tr.addEventListener('dragend',   e => { tr.draggable = false; tr.classList.remove('row-dragging'); document.querySelectorAll('.row-dragover').forEach(r=>r.classList.remove('row-dragover')); });
    tr.addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; tr.classList.add('row-dragover'); });
    tr.addEventListener('dragleave', e => { if (!tr.contains(e.relatedTarget)) tr.classList.remove('row-dragover'); });
    tr.addEventListener('drop',      e => { e.preventDefault(); tr.classList.remove('row-dragover'); if (dragSrc !== null && dragSrc !== i) { const moved = partitions.splice(dragSrc,1)[0]; partitions.splice(i,0,moved); const movedLink = binLinks.splice(dragSrc,1)[0]; binLinks.splice(i,0,movedLink); const movedSize = binFileSizes.splice(dragSrc,1)[0]; binFileSizes.splice(i,0,movedSize); dragSrc=null; render(); }});

    tbody.appendChild(tr);

    const sz = parseSize(p.size);
    const sh = document.getElementById('sh'+i);
    if (sh && !isNaN(sz)) {
      let hint = sz >= 1048576 ? (sz/1048576).toFixed(1)+'MB' : sz >= 1024 ? (sz/1024).toFixed(1)+'KB' : sz+'B';
      if (p.subtype === 'nvs'  && sz < 0x3000) hint += ' ⚠ min 12KB';
      if (p.subtype === 'ota'  && sz !== 0x2000) hint += ' ⚠ must be 8KB';
      sh.textContent = hint;
    }
  });
}

function renderMap() {
  const flashSize = parseInt(document.getElementById('flashSizeSel').value || '1048576');
  const ptOffset  = getPtOffset();
  const ptEnd     = getPtEnd();
  const map = document.getElementById('flashMap');
  const legend = document.getElementById('legend');
  map.innerHTML = ''; legend.innerHTML = '';

  let sorted = partitions
    .map((p,i) => ({ ...p, off: parseSize(p.offset), sz: parseSize(p.size), i }))
    .filter(p => !isNaN(p.off) && !isNaN(p.sz) && p.sz > 0)
    .sort((a,b) => a.off - b.off);

  if (!sorted.length && ptOffset >= flashSize) {
    const div = document.createElement('div');
    div.className = 'seg free'; div.style.flex = '1';
    div.textContent = 'no partitions'; map.appendChild(div); return;
  }

  const mapStart = ptOffset;
  const mapSize  = flashSize - mapStart;

  const allSegs =[];
  allSegs.push({ pt: true, start: ptOffset, size: 0x1000 });

  let cursor = ptEnd;
  sorted.forEach(p => {
    if (p.off > cursor) allSegs.push({ free: true, start: cursor, size: p.off - cursor });
    allSegs.push({ free: false, ...p });
    cursor = p.off + p.sz;
  });
  if (cursor < flashSize) allSegs.push({ free: true, start: cursor, size: flashSize - cursor });

  const ptLi = document.createElement('div');
  ptLi.className = 'legend-item';
  ptLi.innerHTML = \`<div class="legend-dot" style="background:#888;opacity:0.7"></div><span style="opacity:0.7">partition table <span style="color:var(--subtitle-fg)">\${fmtHex(ptOffset)}</span></span>\`;
  legend.appendChild(ptLi);

  allSegs.forEach(s => {
    const div = document.createElement('div');
    const pct = (s.size / flashSize * 100).toFixed(1);
    div.style.flex = Math.max(s.size / mapSize, 0.001);

    if (s.pt) {
      div.className = 'seg';
      div.style.background = 'repeating-linear-gradient(45deg,#555,#555 3px,#444 3px,#444 6px)';
      div.style.opacity = '0.8';
      div.title = \`Partition Table\\nOffset: \${fmtHex(s.start)}\\nSize: 4KB\`;
    } else if (s.free) {
      div.className = 'seg free';
      div.title = \`Free: \${fmtSize(s.size)} (\${pct}% of flash)\`;
      if (parseFloat(pct) > 5) div.textContent = 'free';
    } else {
      div.className = 'seg';
      const color = COLORS[s.i % COLORS.length];
      div.style.background = color;
      div.style.color = '#000';
      div.title = \`\${s.name}\\nOffset: \${fmtHex(s.off)}\\nSize: \${fmtSize(s.sz)} (\${pct}%)\`;
      if (parseFloat(pct) > 3) div.textContent = s.name;

      // Безопасный XSS-френдли код (исправлено)
      const li = document.createElement('div');
      li.className = 'legend-item';
      const dot = document.createElement('div');
      dot.className = 'legend-dot';
      dot.style.background = color;
      li.appendChild(dot);
      const nameText = document.createTextNode(' ' + s.name + ' ');
      li.appendChild(nameText);
      const span = document.createElement('span');
      span.style.color = 'var(--subtitle-fg)';
      span.textContent = fmtSize(s.sz);
      li.appendChild(span);
      legend.appendChild(li);
    }
    map.appendChild(div);
  });
}

function renderStatus() {
  const flashSize = parseInt(document.getElementById('flashSizeSel').value || '1048576');
  const ptOffset  = getPtOffset();
  let maxEnd = getPtEnd();
  partitions.forEach(p => {
    const off = parseSize(p.offset), sz = parseSize(p.size);
    if (!isNaN(off) && !isNaN(sz)) maxEnd = Math.max(maxEnd, off + sz);
  });
  const used = maxEnd - ptOffset;
  const free = flashSize - maxEnd;
  const pct  = (used / flashSize * 100).toFixed(1);
  document.getElementById('statusBar').innerHTML =
    \`<span>Flash: <b>\${fmtSize(flashSize)}</b></span>
     <span>Used: <b>\${fmtSize(used)}</b> (\${pct}%)</span>
     <span class="used-pct">Free: <b>\${free >= 0 ? fmtSize(free) : '⚠️ OVERFLOW'}</b></span>
     <span>Partitions: <b>\${partitions.length}</b></span>\`;
}

function renderErrors() {
  const errors = validate();
  const box = document.getElementById('errorBox');
  const list = document.getElementById('errorList');
  list.innerHTML = errors.map(e=>\`<li>\${e}</li>\`).join('');
  box.style.display = errors.length ? 'block' : 'none';
}

function setDirty() {
  vscode.postMessage({ command: 'setDirty', dirty: true });
}

function update(i, field, value) {
  partitions[i][field] = value;
  setDirty();

  if (field === 'size' && binLinks[i] && binFileSizes[i]) {
    // Size changed manually — just re-render, bin link stays
  }

  if (field === 'type') {
    if (value === 'app')  partitions[i].subtype = 'factory';
    else if (value === 'data') partitions[i].subtype = 'nvs';
    else partitions[i].subtype = '0x00';
    // Clear link — new subtype is not fat/spiffs
    binLinks[i] = null; binFileSizes[i] = 0;
    renderTable();
  }

  if (field === 'subtype' && !['fat','spiffs'].includes(value)) {
    // Clear link when switching away from fat/spiffs
    if (binLinks[i]) { binLinks[i] = null; binFileSizes[i] = 0; }
  }

  updateOnlyStatusAndMap();
}

function addRow() {
  setDirty();
  let maxEnd = 0;
  partitions.forEach(p => {
    const off = parseSize(p.offset), sz = parseSize(p.size);
    if (!isNaN(off) && !isNaN(sz)) maxEnd = Math.max(maxEnd, off+sz);
  });
  if (maxEnd % 4096 !== 0) maxEnd = Math.ceil(maxEnd/4096)*4096;
  if (maxEnd === 0) maxEnd = getPtEnd();
  // Generate unique name
  const existingNames = new Set(partitions.map(p => p.name));
  let newName = 'new_part';
  let counter = 1;
  while (existingNames.has(newName)) { newName = 'new_part_' + counter++; }
  partitions.push({ name: newName, type:'data', subtype:'nvs', offset: fmtHex(maxEnd), size:'0x10000', encrypted:false });
  render();
}

function delRow(i) {
  setDirty();
  partitions.splice(i, 1);
  binLinks.splice(i, 1);
  binFileSizes.splice(i, 1);
  render();
}

function toCsv() {
  const lines =[
    '# ESP Partition Table',
    '# Generated by ESP-IDF Tools VSCode Extension',
    '# Name,   Type, SubType, Offset,  Size, Flags',
  ];
  partitions.forEach(p => {
    const flags = p.encrypted ? 'encrypted' : '';
    lines.push(\`\${p.name},\${p.type},\${p.subtype},\${p.offset},\${p.size},\${flags}\`);
  });
  return lines.join('\\n') + '\\n';
}

function linkBin(i) {
  const flashSizeEl = document.getElementById('flashSizeSel');
  const flashSizeVal = flashSizeEl ? parseInt(flashSizeEl.value || '1048576') : 1048576;
  vscode.postMessage({ command: 'linkBin', index: i, partitions: partitions, flashSize: flashSizeVal });
}
function clearLink(i) {
  binLinks[i] = null;
  binFileSizes[i] = 0;
  setDirty();
  render();
}

// Keep binLinks same length as partitions
function syncLinks() {
  while (binLinks.length < partitions.length) { binLinks.push(null); binFileSizes.push(0); }
  binLinks.length = partitions.length;
  binFileSizes.length = partitions.length;
}

function save() {
  const errors = validate();
  if (errors.length) {
    vscode.postMessage({ command: 'saveWithErrors', csv: toCsv(), errors: errors, binLinks: binLinks });
    return;
  }
  vscode.postMessage({ command: 'setDirty', dirty: false });
  vscode.postMessage({ command: 'save', csv: toCsv(), binLinks: binLinks });
}


window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.command === 'setBusy') {
    const btn = document.getElementById('saveCsvBtn');
    if (btn) {
      btn.disabled = msg.busy;
      btn.title    = msg.busy ? ('🔒 Locked — "' + msg.task + '" is running') : '';
      btn.style.opacity = msg.busy ? '0.4' : '';
      btn.style.cursor  = msg.busy ? 'not-allowed' : '';
    }
    return;
  }
  if (msg.command === 'applySizeUpdatesOnOpen') {
    msg.updates.forEach(u => {
      if (partitions[u.index]) {
        partitions[u.index].size = '0x' + u.newSize.toString(16).toUpperCase();
        binFileSizes[u.index] = u.fileSize;
      }
    });
    setDirty();
    render();
    return;
  }

  if (msg.command === 'setBinLink') {
    binLinks[msg.index] = msg.binPath;
    binFileSizes[msg.index] = msg.fileSize || 0;
    // Auto-adjust partition SIZE to match the bin file (rounded up to 4096)
    if (msg.newSize && msg.newSize > 0) {
      partitions[msg.index].size = '0x' + msg.newSize.toString(16).toUpperCase();
    }
    setDirty();
    render();
    return;
  }
  if (msg.command !== 'sdkconfigUpdate') return;
  const ptEl = document.getElementById('ptOffset');
  if (ptEl) ptEl.textContent = msg.ptOffset;
  const fsEl  = document.getElementById('flashSizeSel');
  const fsDis = document.getElementById('flashSizeDisplay');
  if (fsEl) { fsEl.value = msg.flashSize; }
  const fsLabels = {'524288':'512\u202fKB','1048576':'1\u202fMB','2097152':'2\u202fMB','4194304':'4\u202fMB'};
  if (fsDis) fsDis.textContent = fsLabels[msg.flashSize] || msg.flashSize + ' B';
  const csvEl = document.getElementById('csvFilenameLabel');
  if (csvEl && msg.csvFilename) csvEl.textContent = msg.csvFilename;

  // Apply bin file size updates — re-check files changed outside VS Code
  if (msg.binSizeUpdates && msg.binSizeUpdates.length > 0) {
    const warnings = [];
    msg.binSizeUpdates.forEach(u => {
      if (u.missing) {
        warnings.push(\`Linked file for partition #\${u.index + 1} no longer exists — link removed.\`);
        binLinks[u.index] = null;
        binFileSizes[u.index] = 0;
        return;
      }
      const prevSize = parseSize(partitions[u.index]?.size || '0');
      if (u.newSize !== prevSize) {
        binFileSizes[u.index] = u.fileSize;
        partitions[u.index].size = '0x' + u.newSize.toString(16).toUpperCase();
        warnings.push(\`Partition "\${partitions[u.index]?.name}": size updated to \${(u.newSize/1024).toFixed(0)} KB to match linked bin file.\`);
      }
    });
    if (warnings.length > 0) {
      vscode.postMessage({ command: 'binSizeWarnings', warnings });
      setDirty();
    }
  }

  render();
});

// ─── Custom hex dropdown ──────────────────────────────────────────────────────
const DD_OFFSET = [
  ['0x9000',   'after partition table'],
  ['0xd000',   'otadata start'],
  ['0xf000',   'phy_init start'],
  ['0x10000',  'app start (64KB aligned)'],
  ['0x80000',  '512KB boundary'],
  ['0x100000', '1MB boundary'],
  ['0x110000', 'after 1MB OTA layout'],
  ['0x200000', '2MB boundary'],
  ['0x300000', '3MB boundary'],
];
const DD_SIZE_DATA = [
  ['0x1000',   '4 KB  — phy_init'],
  ['0x2000',   '8 KB  — otadata'],
  ['0x4000',   '16 KB — nvs min'],
  ['0x6000',   '24 KB — nvs default'],
  ['0x8000',   '32 KB'],
  ['0x10000',  '64 KB'],
  ['0x40000',  '256 KB'],
  ['0x100000', '1 MB'],
];
const DD_SIZE_APP = [
  ['0x40000',  '256 KB'],
  ['0x60000',  '384 KB'],
  ['0x70000',  '448 KB — OTA slot 1MB flash'],
  ['0x80000',  '512 KB'],
  ['0xF0000',  '960 KB — factory 1MB flash'],
  ['0x100000', '1 MB'],
  ['0x180000', '1.5 MB'],
  ['0x200000', '2 MB'],
  ['0x300000', '3 MB'],
];

// ─── Portal dropdown state ───────────────────────────────────────────────────
let _ddOpenBtn  = null;  // button that opened the portal
let _ddInputId  = null;  // input id to fill on pick
let _ddIdx      = null;  // partition row index
let _ddKind     = null;  // 'off' | 'sz'

function toggleDd(btn, kind, idx) {
  const portal = document.getElementById('ddPortal');
  if (!portal) return;

  // Close if same button clicked again
  if (_ddOpenBtn === btn) { closeAllDd(); return; }
  closeAllDd();

  // Determine which input to fill
  const inputId = kind === 'off' ? 'offIn'+idx : 'szIn'+idx;
  _ddOpenBtn = btn;
  _ddInputId = inputId;
  _ddIdx     = idx;
  _ddKind    = kind;

  // Build options list
  const opts = kind === 'off'
    ? DD_OFFSET
    : (partitions[idx] && partitions[idx].type === 'app') ? DD_SIZE_APP : DD_SIZE_DATA;

  portal.innerHTML = opts.map(([val, desc]) =>
    \`<div class="dd-item" onmousedown="pickDd(event,'\${val}')">
       <span class="dd-val">\${val}</span><span class="dd-desc">\${desc}</span>
     </div>\`
  ).join('');

  // Position portal below the button using fixed coords
  const rect  = btn.getBoundingClientRect();
  const vpW   = window.innerWidth;
  const vpH   = window.innerHeight;
  const ddW   = Math.max(rect.width + 160, 240);

  portal.style.minWidth = ddW + 'px';

  // Horizontal: open right-aligned if not enough space on the right
  if (rect.left + ddW > vpW - 8) {
    portal.style.left  = '';
    portal.style.right = (vpW - rect.right) + 'px';
  } else {
    portal.style.right = '';
    portal.style.left  = rect.left + 'px';
  }

  // Vertical: open above if not enough space below
  if (rect.bottom + 280 > vpH) {
    portal.style.top    = '';
    portal.style.bottom = (vpH - rect.top + 2) + 'px';
  } else {
    portal.style.bottom = '';
    portal.style.top    = (rect.bottom + 2) + 'px';
  }

  portal.classList.add('open');
}

function pickDd(e, val) {
  e.preventDefault();
  if (_ddInputId) {
    const inp = document.getElementById(_ddInputId);
    if (inp) { inp.value = val; }
  }
  const field = _ddKind === 'off' ? 'offset' : 'size';
  update(_ddIdx, field, val);
  closeAllDd();
}

function closeAllDd() {
  const portal = document.getElementById('ddPortal');
  if (portal) portal.classList.remove('open');
  _ddOpenBtn = null;
  _ddInputId = null;
  _ddIdx     = null;
  _ddKind    = null;
}

document.addEventListener('click', e => {
  if (_ddOpenBtn && !e.target.closest('.hex-wrap') && e.target !== document.getElementById('ddPortal') && !e.target.closest('#ddPortal')) {
    closeAllDd();
  }
});
</script>

</body>
</html>`;
}


// ╔══════════════════════════════════════════════════════════════════╗
// ║  PARTITION TABLE EDITOR: CSV Parser                                ║
// ╚══════════════════════════════════════════════════════════════════╝
function parseCsvToPartitions(csv) {
    if (!csv) return[];
    const partitions =[];
    const lines = csv.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(',').map(s => s.trim());
        if (parts.length < 5) continue;
        const flags = (parts[5] || '').toLowerCase();
        partitions.push({
            name:      parts[0] || '',
            type:      parts[1] || 'data',
            subtype:   parts[2] || 'nvs',
            offset:    parts[3] || '0x0',
            size:      parts[4] || '0x1000',
            encrypted: flags.includes('encrypted'),
        });
    }
    return partitions;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  EXPORTS                                                           ║
// ╚══════════════════════════════════════════════════════════════════╝
module.exports = { activate, deactivate };