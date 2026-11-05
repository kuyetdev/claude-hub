import type { HubConfig } from './config.ts';

export type InstallPlatform = 'ubuntu' | 'macos';

export function createInstallScript(platform: InstallPlatform, config: HubConfig, requestOrigin?: string): string {
  const hubUrl = requestOrigin ?? config.publicUrl ?? `http://${config.host}:${config.port}`;
  const prerequisites = platform === 'ubuntu'
  ? `if ! command -v curl >/dev/null 2>&1; then
  echo "Đang cài curl..."
  sudo apt-get update
  sudo apt-get install -y curl ca-certificates
fi`
    : `if ! command -v curl >/dev/null 2>&1; then
  echo "Thiếu curl. Hãy cài Xcode Command Line Tools bằng: xcode-select --install" >&2
  exit 1
fi`;
  return `#!/usr/bin/env bash
set -Eeuo pipefail

HUB_URL=${JSON.stringify(hubUrl)}
INSTALL_DIR="\${CLAUDE_HUB_AGENT_DIR:-$HOME/.local/share/claude-hub-agent}"
BIN_DIR="$HOME/.local/bin"
NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
export NVM_DIR

${prerequisites}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 24 ]; then
  echo "Đang cài Node.js 24 bằng NVM..."
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    PROFILE=/dev/null curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | PROFILE=/dev/null bash
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm use 24
fi

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
echo "Đang tải Claude Hub Agent từ hub..."
bundle_tmp="$(mktemp -d)"
trap 'rm -rf "$bundle_tmp"' EXIT
curl -fsSL "$HUB_URL/agent/bundle.tar.gz" -o "$bundle_tmp/agent-bundle.tar.gz"
curl -fsSL "$HUB_URL/agent/version" -o "$bundle_tmp/version"
mkdir -p "$bundle_tmp/unpacked"
tar -xzf "$bundle_tmp/agent-bundle.tar.gz" -C "$bundle_tmp/unpacked"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/hub"
cp -R "$bundle_tmp/unpacked/agent" "$INSTALL_DIR/agent"
cp -R "$bundle_tmp/unpacked/shared" "$INSTALL_DIR/shared"
cp "$bundle_tmp/unpacked/hub/validate.ts" "$INSTALL_DIR/hub/validate.ts"
cp "$bundle_tmp/version" "$INSTALL_DIR/.bundle-version"
rm -rf "$bundle_tmp"
trap - EXIT

cat > "$BIN_DIR/claude-hub-agent" <<'WRAPPER'
#!/usr/bin/env bash
set -Eeuo pipefail
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi
INSTALL_DIR="\${CLAUDE_HUB_AGENT_DIR:-$HOME/.local/share/claude-hub-agent}"
CONFIG="$HOME/.claude-storage-agent.json"
if [ -f "$CONFIG" ] && command -v curl >/dev/null 2>&1; then
  HUB_URL="$(node -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hub || "") } catch {}' "$CONFIG")"
  if [ -n "$HUB_URL" ]; then
    latest="$(curl -fsSL --max-time 3 "$HUB_URL/agent/version" 2>/dev/null || true)"
    current="$(cat "$INSTALL_DIR/.bundle-version" 2>/dev/null || true)"
    if [ -n "$latest" ] && [ "$latest" != "$current" ] && mkdir "$INSTALL_DIR/.update-lock" 2>/dev/null; then
      update_tmp="$(mktemp -d)"
      if curl -fsSL --max-time 15 "$HUB_URL/agent/bundle.tar.gz" -o "$update_tmp/bundle.tar.gz" && \
        mkdir "$update_tmp/unpacked" && tar -xzf "$update_tmp/bundle.tar.gz" -C "$update_tmp/unpacked"; then
        rm -rf "$INSTALL_DIR/agent" "$INSTALL_DIR/shared" "$INSTALL_DIR/hub"
        mkdir -p "$INSTALL_DIR/hub"
        cp -R "$update_tmp/unpacked/agent" "$INSTALL_DIR/agent"
        cp -R "$update_tmp/unpacked/shared" "$INSTALL_DIR/shared"
        cp "$update_tmp/unpacked/hub/validate.ts" "$INSTALL_DIR/hub/validate.ts"
        printf '%s' "$latest" > "$INSTALL_DIR/.bundle-version"
      fi
      rm -rf "$update_tmp" "$INSTALL_DIR/.update-lock"
    fi
  fi
fi
exec node "\${CLAUDE_HUB_AGENT_DIR:-$HOME/.local/share/claude-hub-agent}/agent/cli.ts" "$@"
WRAPPER
chmod 700 "$BIN_DIR/claude-hub-agent"

echo
echo "Đăng ký máy với Claude Hub."
"$BIN_DIR/claude-hub-agent" register --hub "$HUB_URL"

echo
echo "Đang cài hook gửi usage sau mỗi lượt chat..."
"$BIN_DIR/claude-hub-agent" install-hook --command "$BIN_DIR/claude-hub-agent report"

echo
echo "Đang gửi usage hiện tại lần đầu..."
if ! "$BIN_DIR/claude-hub-agent" report; then
  echo "Chưa có cache usage mới. Hook sẽ tự gửi sau lượt chat Claude tiếp theo."
fi

echo
echo "Cài đặt hoàn tất. Lệnh gửi báo cáo:"
echo "  $BIN_DIR/claude-hub-agent report"
echo "Agent tự cập nhật từ Claude Hub mỗi khi chạy."
echo "Hook Stop đã được cài. Backup settings nằm tại ~/.claude/settings.json.claude-hub.bak (nếu file cũ tồn tại)."
`;
}
