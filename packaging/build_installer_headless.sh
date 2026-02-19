#!/usr/bin/env bash
set -euo pipefail

# ========================================
# Project Kestrel macOS Builder (Headless)
# Builds unified ProjectKestrel onedir bundle + .pkg installer
# Called by CI (GitHub Actions) or run locally
# ========================================

echo
printf "%s\n" "========================================"
printf "%s\n" "Project Kestrel macOS Builder (Headless)"
printf "%s\n" "========================================"
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."

cd "${PROJECT_ROOT}"

# Version strings (can be injected by caller; fall back to timestamp)
RELEASE_TS="${RELEASE_TS:-$(date "+%Y.%m.%d.%H.%M")}"
RELEASE_NAME="${RELEASE_NAME:-Project Kestrel a${RELEASE_TS}}"
APP_VERSION="${APP_VERSION:-alpha-${RELEASE_TS}}"

printf "Using release name: %s\n" "${RELEASE_NAME}"
printf "Using app version:  %s\n" "${APP_VERSION}"
echo

# Write version info into the analyzer folder
{
  echo "Build: ${RELEASE_TS}"
  echo "Version: ${APP_VERSION}"
} > "analyzer/VERSION.txt"
echo "[OK] VERSION.txt written to analyzer/"

# ----------------------------------------
# Activate Python virtual environment
# ----------------------------------------
if [[ -f ".venv2/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source ".venv2/bin/activate"
  echo "[OK] Activated .venv2"
else
  echo "[WARNING] .venv2 not found - using system/activated Python"
fi

echo
printf "%s\n" "========================================"
printf "%s\n" "Running PyInstaller (onedir) ..."
printf "%s\n" "========================================"
echo

pushd analyzer || exit 1
python -m PyInstaller ProjectKestrel-macos.spec
popd

DIST_DIR="analyzer/dist/ProjectKestrel"
if [[ ! -f "${DIST_DIR}/ProjectKestrel" ]]; then
  echo "[ERROR] ProjectKestrel binary not found after build."
  exit 1
fi
echo "[OK] PyInstaller onedir build complete: ${DIST_DIR}/"

echo
printf "%s\n" "========================================"
printf "%s\n" "Building macOS installer (.pkg) ..."
printf "%s\n" "========================================"
echo

RELEASE_DIR="${PROJECT_ROOT}/release/${APP_VERSION}"
mkdir -p "${RELEASE_DIR}"

PKG_ROOT="${RELEASE_DIR}/pkgroot"
APP_INSTALL_DIR="${PKG_ROOT}/Applications/Project Kestrel"
PKG_OUTPUT="${RELEASE_DIR}/ProjectKestrel-${APP_VERSION}.pkg"
PKG_SCRIPTS="${RELEASE_DIR}/pkg-scripts"

rm -rf "${PKG_ROOT}" "${PKG_SCRIPTS}"
mkdir -p "${APP_INSTALL_DIR}"
mkdir -p "${PKG_SCRIPTS}"

# Copy the entire onedir bundle into the install location
cp -R "${DIST_DIR}/." "${APP_INSTALL_DIR}/ProjectKestrel/"

# Minimal postinstall script - makes the binary executable
cat > "${PKG_SCRIPTS}/postinstall" <<'EOS'
#!/bin/bash
set -euo pipefail
chmod +x "/Applications/Project Kestrel/ProjectKestrel/ProjectKestrel" 2>/dev/null || true
EOS
chmod +x "${PKG_SCRIPTS}/postinstall"

pkgbuild \
  --root "${PKG_ROOT}" \
  --scripts "${PKG_SCRIPTS}" \
  --identifier "org.ProjectKestrel" \
  --version "${APP_VERSION}" \
  --install-location "/" \
  "${PKG_OUTPUT}"

echo
printf "%s\n" "========================================"
printf "%s\n" "Build complete!"
printf "%s\n" "========================================"
echo
printf "Bundle:    %s/\n" "${DIST_DIR}"
printf "Installer: %s\n" "${PKG_OUTPUT}"
