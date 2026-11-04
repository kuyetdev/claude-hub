import type { HubConfig } from './config.ts';

export type InstallPlatform = 'ubuntu' | 'macos';

export function createInstallScript(platform: InstallPlatform, config: HubConfig): string {
  const hubUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;
  const prerequisites = platform === 'ubuntu'
    ? `if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "Đang cài curl và git..."
  sudo apt-get update
  sudo apt-get install -y curl git ca-certificates
fi`
    : `if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "Thiếu curl hoặc git. Hãy cài Xcode Command Line Tools bằng: xcode-select --install" >&2
  exit 1
fi`;
  return `#!/usr/bin/env bash
set -Eeuo pipefail

HUB_URL=${JSON.stringify(hubUrl)}
REPO_URL="https://github.com/kuyetdev/claude-hub.git"
BRANCH="feat/hub-usage"
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
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Đang cập nhật Claude Hub Agent..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi

cat > "$BIN_DIR/claude-hub-agent" <<'WRAPPER'
#!/usr/bin/env bash
set -Eeuo pipefail
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
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
echo "Hook Stop đã được cài. Backup settings nằm tại ~/.claude/settings.json.claude-hub.bak (nếu file cũ tồn tại)."
`;
}
