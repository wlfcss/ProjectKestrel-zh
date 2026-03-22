#!/usr/bin/env bash
set -euo pipefail

# ========================================
# LingjianLite macOS Builder (Headless)
# Builds unified LingjianLite onedir bundle + .pkg installer
# Called by CI (GitHub Actions) or run locally
# ========================================

echo
printf "%s\n" "========================================"
printf "%s\n" "LingjianLite macOS Builder (Headless)"
printf "%s\n" "========================================"
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."

cd "${PROJECT_ROOT}"

# Read VERSION.txt from repo root and copy to analyzer folder
if [[ -f "VERSION.txt" ]]; then
  echo "[OK] Reading VERSION.txt from repo root"
  cp "VERSION.txt" "analyzer/VERSION.txt"
  echo "[OK] VERSION.txt copied to analyzer/"
else
  echo "[WARNING] VERSION.txt not found in repo root, generating one..."
  RELEASE_TS="${RELEASE_TS:-$(date "+%Y.%m.%d.%H.%M")}"
  RELEASE_NAME="${RELEASE_NAME:-LingjianLite a${RELEASE_TS}}"
  APP_VERSION="${APP_VERSION:-alpha-${RELEASE_TS}}"
  {
    echo "${APP_VERSION}"
  } > "analyzer/VERSION.txt"
  echo "[OK] Generated VERSION.txt in analyzer/"
fi

# ----------------------------------------
# Activate Python virtual environment
# ----------------------------------------
if [[ -f ".venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
  echo "[OK] Activated .venv"
else
  echo "[WARNING] .venv not found - using system/activated Python"
fi

echo
printf "%s\n" "========================================"
printf "%s\n" "Running PyInstaller (onedir) ..."
printf "%s\n" "========================================"
echo

pushd analyzer || exit 1
python -m PyInstaller LingjianLite-macos.spec
popd

DIST_DIR="analyzer/dist/LingjianLite"
if [[ ! -f "${DIST_DIR}/LingjianLite" ]]; then
  echo "[ERROR] LingjianLite binary not found after build."
  exit 1
fi
echo "[OK] PyInstaller onedir build complete: ${DIST_DIR}/"

echo
printf "%s\n" "========================================"
printf "%s\n" "Copying sample_sets (with hidden files)..."
printf "%s\n" "========================================"
echo

# Copy to .app bundle Resources directory (includes hidden files with cp -R)
APP_BUNDLE="analyzer/dist/翎鉴 Lite.app"
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
printf "App Bundle: %s/\n" "${DIST_DIR}"
