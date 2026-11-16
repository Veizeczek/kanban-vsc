#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_DIR=""

cleanup() {
  if [ -n "${SHIM_DIR}" ] && [ -d "${SHIM_DIR}" ]; then
    rm -rf "${SHIM_DIR}"
  fi
}
trap cleanup EXIT

echo ""
echo "==================================================="
echo " kanban-vsc installer (Linux / WSL)"
echo " Source: ${EXT_DIR}"
echo "==================================================="
echo ""

is_linux_bin() {
  local bin_path
  bin_path="$(command -v "$1" 2>/dev/null || true)"
  [ -n "${bin_path}" ] && [[ "${bin_path}" != /mnt/* ]]
}

# Load common user-space Node version managers when invoked from non-login shells
if ! is_linux_bin node; then
  export NVM_DIR="${HOME}/.nvm"
  if [ -s "${NVM_DIR}/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "${NVM_DIR}/nvm.sh"
  fi
  for candidate_bin in \
    "${HOME}/.volta/bin" \
    "${HOME}/.local/share/fnm/aliases/default/bin" \
    "${HOME}/.fnm/aliases/default/bin" \
    "/usr/local/bin"
  do
    if [ -x "${candidate_bin}/node" ]; then
      export PATH="${candidate_bin}:${PATH}"
      break
    fi
  done
fi

LINUX_NODE=""
if is_linux_bin node; then
  LINUX_NODE="$(command -v node)"
else
  # Fallback on WSL: reuse the Linux Node binary bundled with VS Code Remote Server
  for server_node in \
    "${HOME}"/.vscode-server/bin/*/node \
    "${HOME}"/.vscode-server/cli/servers/*/server/node \
    "${HOME}"/.vscode-server-insiders/bin/*/node \
    "${HOME}"/.antigravity-server/bin/*/node \
    "${HOME}"/.cursor-server/bin/*/node
  do
    if [ -x "${server_node}" ]; then
      LINUX_NODE="${server_node}"
      break
    fi
  done
fi

if [ -z "${LINUX_NODE}" ]; then
  echo "ERROR: Native Linux 'node' binary not found. Please install Node.js in Linux/WSL." >&2
  exit 1
fi

if ! is_linux_bin npm; then
  NPM_CLI_JS=""
  for candidate_npm in \
    "/usr/lib/node_modules/npm/bin/npm-cli.js" \
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js" \
    "/mnt/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" \
    "/mnt/c/Program Files (x86)/nodejs/node_modules/npm/bin/npm-cli.js"
  do
    if [ -f "${candidate_npm}" ]; then
      NPM_CLI_JS="${candidate_npm}"
      break
    fi
  done

  if [ -z "${NPM_CLI_JS}" ]; then
    echo "ERROR: 'npm' not found. Please install npm in Linux/WSL." >&2
    exit 1
  fi

  SHIM_DIR="$(mktemp -d)"
  ln -s "${LINUX_NODE}" "${SHIM_DIR}/node"
  cat > "${SHIM_DIR}/npm" <<EOF
#!/usr/bin/env bash
exec "${LINUX_NODE}" "${NPM_CLI_JS}" "\$@"
EOF
  chmod +x "${SHIM_DIR}/npm"
  export PATH="${SHIM_DIR}:${PATH}"
elif ! is_linux_bin node; then
  SHIM_DIR="$(mktemp -d)"
  ln -s "${LINUX_NODE}" "${SHIM_DIR}/node"
  export PATH="${SHIM_DIR}:${PATH}"
fi

echo "Using node: $(node -v) ($(command -v node))"
echo "Using npm:  $(npm -v)"
echo ""

cd "${EXT_DIR}"

if [ ! -d "node_modules" ] || [ ! -f "node_modules/typescript/bin/tsc" ]; then
  echo "[1/3] Installing npm dependencies..."
  npm install
else
  echo "[1/3] Dependencies found."
fi

chmod -R u+x node_modules/.bin node_modules/typescript/bin 2>/dev/null || true

echo "[2/3] Building TypeScript..."
npm run compile
echo "OK"

EXT_META="$(node -e '
  const pkg = require("./package.json");
  const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
  const ver = pkg.version || "0.0.1";
  process.stdout.write(`${id}|${ver}`);
')"
EXT_ID="${EXT_META%|*}"
EXT_VERSION="${EXT_META#*|}"
TARGET_FOLDER="${EXT_ID}-${EXT_VERSION}"

echo "[3/3] Linking extension (${TARGET_FOLDER})..."

IS_WSL=0
if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
  IS_WSL=1
fi

TARGET_ROOTS=()

if [ "${IS_WSL}" -eq 1 ]; then
  TARGET_ROOTS+=("${HOME}/.vscode-server/extensions")
fi

if [ -d "${HOME}/.vscode" ] || [ "${IS_WSL}" -eq 0 ]; then
  TARGET_ROOTS+=("${HOME}/.vscode/extensions")
fi

for extra_server in ".vscode-server-insiders" ".antigravity-server" ".cursor-server" ".windsurf-server"; do
  if [ -d "${HOME}/${extra_server}" ]; then
    TARGET_ROOTS+=("${HOME}/${extra_server}/extensions")
  fi
done

register_in_manifest() {
  local ext_root="$1"
  local link_path="$2"
  local folder_name="$3"
  local manifest="${ext_root}/extensions.json"

  if [ ! -f "${manifest}" ]; then
    return 0
  fi

  node -e '
    const fs = require("fs");
    const [manifestPath, linkPath, extId, extVersion, folderName] = process.argv.slice(1);

    let entries = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      process.exit(0);
    }

    entries = entries.filter(e => {
      const id = String(e?.identifier?.id ?? "").toLowerCase();
      return id !== extId && e?.relativeLocation !== folderName && e?.relativeLocation !== "kanban-vsc";
    });

    entries.push({
      identifier: { id: extId },
      version: extVersion,
      location: {
        $mid: 1,
        fsPath: linkPath,
        external: `file://${linkPath}`,
        path: linkPath,
        scheme: "file"
      },
      relativeLocation: folderName,
      metadata: {
        installedTimestamp: Date.now(),
        pinned: false,
        source: "vsix"
      }
    });

    fs.writeFileSync(manifestPath, JSON.stringify(entries), "utf8");
  ' "${manifest}" "${link_path}" "${EXT_ID}" "${EXT_VERSION}" "${folder_name}"
}

for root in "${TARGET_ROOTS[@]}"; do
  mkdir -p "${root}"
  rm -rf "${root}/kanban-vsc" "${root}/${EXT_ID}-"*
  link_path="${root}/${TARGET_FOLDER}"
  ln -s "${EXT_DIR}" "${link_path}"
  register_in_manifest "${root}" "${link_path}" "${TARGET_FOLDER}"
  echo "  -> Linked: ${link_path}"
done

echo ""
echo "==================================================="
echo " Done. Reload / restart VS Code to activate."
echo "==================================================="
echo ""
