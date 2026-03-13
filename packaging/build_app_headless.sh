#!/usr/bin/env bash
set -euo pipefail

# ========================================
# Project Kestrel macOS App Builder (Headless)
# Builds unified ProjectKestrel onedir bundle (PyInstaller only)
# No .pkg installer - for faster CI builds
# ========================================

echo
printf "%s\n" "========================================"
printf "%s\n" "Project Kestrel macOS App Builder"
printf "%s\n" "========================================"
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."

cd "${PROJECT_ROOT}"

# Version strings (can be injected by caller; fall back to timestamp)
RELEASE_TS="${RELEASE_TS:-$(date "+%Y.%m.%d.%H.%M")}"
APP_VERSION="${APP_VERSION:-alpha-${RELEASE_TS}}"

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
printf "%s\n" "Copying sample_sets (with hidden files)..."
printf "%s\n" "========================================"
echo

# Copy to .app bundle Resources directory (includes hidden files with cp -R)
APP_BUNDLE="analyzer/dist/Project Kestrel.app"
if [[ -d "${APP_BUNDLE}" ]]; then
  RESOURCES_DIR="${APP_BUNDLE}/Contents/Resources"
  mkdir -p "${RESOURCES_DIR}"
  # Remove any existing copy to avoid nested or stale files, then copy recursively
  if [[ -d "${RESOURCES_DIR}/sample_sets" ]]; then
    echo "[INFO] Removing existing ${RESOURCES_DIR}/sample_sets to ensure clean copy"
    rm -rf "${RESOURCES_DIR}/sample_sets"
  fi
  cp -R "analyzer/sample_sets" "${RESOURCES_DIR}/"
  echo "[OK] Copied sample_sets to ${RESOURCES_DIR}/sample_sets/"

  # Also copy to _internal subdirectory as fallback path
  INTERNAL_DIR="${RESOURCES_DIR}/_internal"
  mkdir -p "${INTERNAL_DIR}"
  if [[ -d "${INTERNAL_DIR}/sample_sets" ]]; then
    echo "[INFO] Removing existing ${INTERNAL_DIR}/sample_sets to ensure clean copy"
    rm -rf "${INTERNAL_DIR}/sample_sets"
  fi
  cp -R "analyzer/sample_sets" "${INTERNAL_DIR}/"
  echo "[OK] Copied sample_sets to ${INTERNAL_DIR}/sample_sets/"
else
  echo "[WARNING] .app bundle not found at ${APP_BUNDLE}"
fi

# Also copy to onedir bundle if it exists (for completeness)
if [[ -d "${DIST_DIR}" ]]; then
  if [[ -d "${DIST_DIR}/sample_sets" ]]; then
    echo "[INFO] Removing existing ${DIST_DIR}/sample_sets to ensure clean copy"
    rm -rf "${DIST_DIR}/sample_sets"
  fi
  cp -R "analyzer/sample_sets" "${DIST_DIR}/"
  echo "[OK] Copied sample_sets to ${DIST_DIR}/sample_sets/"
fi

echo
printf "%s\n" "========================================"
printf "%s\n" "Build complete!"
printf "%s\n" "========================================"
echo
printf "App bundle: %s/\n" "${DIST_DIR}"
