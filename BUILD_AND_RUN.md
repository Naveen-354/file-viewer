# Build and run OneOpen

This guide covers dependency installation, development, validation, production builds, and installation. The main instructions use Windows PowerShell; equivalent Windows Command Prompt and Linux Bash commands are included below. Run commands from the repository root:

```text
D:\github\file-viewer
```

## 1. Install system prerequisites

OneOpen requires Windows 10 or 11, Microsoft WebView2, Node.js, pnpm, Rust, and the Microsoft C++ build tools.

Open PowerShell and install the prerequisites:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
rustup default stable
npm install --global pnpm@10.15.0
```

Current Windows versions normally include WebView2. If it is missing, install the Microsoft Edge WebView2 Runtime before starting OneOpen.

Close and reopen PowerShell, then verify the tools:

```powershell
node --version
pnpm --version
rustc --version
cargo --version
```

The Rust compiler must be at least version 1.77.2.

## 2. Install project dependencies

Move to the repository and install the exact dependency versions from `pnpm-lock.yaml`:

```powershell
Set-Location D:\github\file-viewer
pnpm install --frozen-lockfile
```

Cargo downloads and compiles Rust dependencies automatically during the first development or production build. A separate Cargo install command is not required.

If the machine's Corepack pnpm shim is broken, use the npm-global executable:

```powershell
& "$env:APPDATA\npm\pnpm.cmd" install --frozen-lockfile
```

For commands invoked internally by Tauri, place that pnpm directory first in `PATH` for the current PowerShell session:

```powershell
$env:PATH = "$env:APPDATA\npm;$env:PATH"
```

## 3. Run in development mode

```powershell
pnpm tauri dev
```

The command starts Vite on port `5173`, compiles the Rust backend, and opens the desktop application. The first run takes longer because Cargo must compile native dependencies.

Open one or more files at startup:

```powershell
pnpm tauri dev -- "C:\path with spaces\sample.pdf" "C:\files\notes.md"
```

Stop development mode with `Ctrl+C` in the PowerShell window. A console window is expected in development mode because it displays logs; production builds use the Windows GUI subsystem and do not open an extra command window.

## 4. Validate changes

Run the frontend checks:

```powershell
pnpm lint
pnpm test
pnpm build
```

Run the Rust checks:

```powershell
Push-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
Pop-Location
```

## 5. Build the production application

```powershell
pnpm tauri build
```

This builds the frontend, creates the optimized Windows executable, and generates both configured installers. Thin LTO and native document/image dependencies can make a clean production build take 15–30 minutes.

Generated artifacts:

```text
src-tauri\target\release\oneopen.exe
src-tauri\target\release\bundle\msi\OneOpen_0.1.0_x64_en-US.msi
src-tauri\target\release\bundle\nsis\OneOpen_0.1.0_x64-setup.exe
```

Run the portable production executable directly:

```powershell
.\src-tauri\target\release\oneopen.exe
```

Run it with a file:

```powershell
& .\src-tauri\target\release\oneopen.exe "C:\files\sample.pdf"
```

## 6. Install OneOpen

The NSIS installer is the simplest current-user installation:

```powershell
Start-Process -FilePath .\src-tauri\target\release\bundle\nsis\OneOpen_0.1.0_x64-setup.exe -Wait
```

Alternatively, install the MSI:

```powershell
Start-Process msiexec.exe -ArgumentList '/i', '.\src-tauri\target\release\bundle\msi\OneOpen_0.1.0_x64_en-US.msi' -Wait
```

After installation, start OneOpen from the Start menu. To associate a supported format, right-click a file in Explorer, choose **Open with**, select **OneOpen**, and optionally make it the default application.

## Windows Command Prompt (`cmd.exe`)

The prerequisite `winget`, `rustup`, and `npm` commands from section 1 work unchanged in Command Prompt. Open a new Command Prompt after installation, then run:

```batch
cd /d D:\github\file-viewer
node --version
pnpm --version
rustc --version
cargo --version
pnpm install --frozen-lockfile
```

If the Corepack pnpm shim is broken:

```batch
set "PATH=%APPDATA%\npm;%PATH%"
"%APPDATA%\npm\pnpm.cmd" install --frozen-lockfile
```

Run the development application:

```batch
pnpm tauri dev
```

Run it with files at startup:

```batch
pnpm tauri dev -- "C:\path with spaces\sample.pdf" "C:\files\notes.md"
```

Validate the frontend and Rust code:

```batch
pnpm lint
pnpm test
pnpm build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
cd ..
```

Build and run the production application:

```batch
pnpm tauri build
src-tauri\target\release\oneopen.exe
```

Install with NSIS or MSI:

```batch
src-tauri\target\release\bundle\nsis\OneOpen_0.1.0_x64-setup.exe
msiexec /i "src-tauri\target\release\bundle\msi\OneOpen_0.1.0_x64_en-US.msi"
```

## Linux terminal (`bash`)

Linux support exists in the codebase but has not been exercised to the same level as Windows. Linux uses WebKitGTK instead of WebView2 and cannot produce the configured Windows MSI/NSIS installers. The package lists below follow the official [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

### Install Linux system dependencies

Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

Fedora:

```bash
sudo dnf check-update || true
sudo dnf install -y webkit2gtk4.1-devel \
  openssl-devel \
  curl \
  wget \
  file \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  libxdo-devel
sudo dnf group install -y "c-development"
```

Arch Linux or Manjaro:

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 \
  base-devel \
  curl \
  wget \
  file \
  openssl \
  appmenu-gtk-module \
  libappindicator-gtk3 \
  librsvg \
  xdotool
```

Install Node.js 22 LTS using your distribution's supported Node.js installer or version manager. Then install Rust and pnpm:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
npm install --global pnpm@10.15.0
```

Verify and install project dependencies:

```bash
node --version
pnpm --version
rustc --version
cargo --version
cd /path/to/file-viewer
pnpm install --frozen-lockfile
```

Run in development mode:

```bash
pnpm tauri dev
```

Run with files at startup:

```bash
pnpm tauri dev -- "/path/with spaces/sample.pdf" "/path/to/notes.md"
```

Validate the project:

```bash
pnpm lint
pnpm test
pnpm build
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
cd ..
```

Build only the Linux executable:

```bash
pnpm tauri build -- --no-bundle
./src-tauri/target/release/oneopen
```

To request native Linux packages instead of the Windows-only configured bundle targets:

```bash
pnpm tauri build -- --bundles deb,appimage
find src-tauri/target/release/bundle -maxdepth 3 -type f
```

For broad compatibility, build Linux packages on the oldest Linux base system you intend to support. Tauri lists Ubuntu 22.04 and Debian 12 as practical baselines in its [Linux distribution guidance](https://v2.tauri.app/distribute/debian/).

## Troubleshooting

### `Cannot find module ... corepack ... pnpm.js`

Use the npm-global pnpm executable and update the current session's `PATH`:

```powershell
$env:PATH = "$env:APPDATA\npm;$env:PATH"
& "$env:APPDATA\npm\pnpm.cmd" tauri build
```

### `link.exe` or Windows SDK errors

Open Visual Studio Installer, modify **Build Tools 2022**, and ensure **Desktop development with C++**, an MSVC toolset, and a Windows 10/11 SDK are installed. Restart PowerShell afterward.

### Port `5173` is already in use

Stop the previous `pnpm tauri dev` or Vite process, then run the development command again. The development port is fixed on purpose (`strictPort`), so a clash fails loudly rather than silently moving the server away from the URL Tauri loads.

### `listen EACCES: permission denied ::1:<port>`

Windows reserves ranges of TCP ports, and a reserved port cannot be bound even by an administrator. List them with:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

If the development port falls inside a listed range, pick one outside it and change **both** `server.port` in `vite.config.ts` and `build.devUrl` in `src-tauri/tauri.conf.json`. They have to agree: Tauri loads the URL Vite serves.

The project moved from `1420` to `5173` for exactly this reason — `1420` fell inside a `1375-1474` exclusion on the development machine.

### The first build appears stuck

Cargo may remain quiet for several minutes while linking the optimized executable. Check that the build process is still running before cancelling it.
