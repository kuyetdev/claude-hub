import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HubState, UserState } from '../../shared/types.ts';
import { getState, removeMachine, saveQuotas } from './api.ts';

const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

function formatPercent(value: number): string { return `${number.format(value)}%`; }
function formatTime(value: number | string | null): string { return value ? dateTime.format(new Date(value)) : 'Chưa có dữ liệu'; }
function shortCount(value: number): string {
  const units: Array<[number, string]> = [[1_000_000_000, 'b'], [1_000_000, 'm'], [1_000, 'k']];
  for (const [size, suffix] of units) if (value >= size) return `${number.format(value / size)}${suffix}`;
  return number.format(value);
}
function formatAge(value: number | null): string {
  if (!value) return 'chưa rõ';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s trước`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  return `${Math.floor(seconds / 3600)} giờ trước`;
}
function statusClass(ratio: number): string { return ratio >= 100 ? 'danger' : ratio >= 80 ? 'warn' : 'ok'; }

function Progress({ value, label, ratio = value }: { value: number; label: string; ratio?: number }) {
  return <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio)}>
    <span className={statusClass(ratio)} style={{ transform: `scaleX(${Math.min(Math.max(ratio, 0), 100) / 100})` }} />
  </div>;
}

function UserCard({ user, onRemove, busy }: { user: UserState; onRemove: (id: string, host: string) => void; busy: boolean }) {
  return <article className="user-card">
    <div className="user-head">
      <div><h3>{user.username}</h3><p className="mono usage-value">{formatPercent(user.usedPercent)} <span>/ {formatPercent(user.quotaPercent)}</span></p></div>
      <span className={`status ${statusClass(user.quotaRatioPercent)}`}>{user.quotaRatioPercent >= 100 ? 'Vượt quota' : user.quotaRatioPercent >= 80 ? 'Gần quota' : 'Bình thường'}</span>
    </div>
    <Progress value={user.usedPercent} ratio={user.quotaRatioPercent} label={`${user.username} đã dùng ${formatPercent(user.quotaRatioPercent)} quota`} />
    <p className="approx">Quy đổi xấp xỉ: <span className="mono">{number.format(user.weightedTokens)}</span> token trọng số</p>
    {user.modelUsages.length > 0 && <details className="model-breakdown">
      <summary><span className="model-summary-closed">Xem thêm · Chi tiết theo model</span><span className="model-summary-open">Thu gọn · Chi tiết theo model</span></summary>
      <p className="model-hint">Tỷ lệ là phần mức dùng trọng số trong tổng của user. Giá USD là ước tính theo giá API Anthropic.</p>
      {user.modelUsages.map((usage) => <div className="model-row" key={usage.model}>
        <div className="model-row-head"><strong>{usage.model}</strong><span>{formatPercent(usage.sharePercent)}</span></div>
        <div className="model-meter" role="progressbar" aria-label={`${usage.model}: ${formatPercent(usage.sharePercent)} token trọng số`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.sharePercent)}><span style={{ transform: `scaleX(${Math.min(usage.sharePercent, 100) / 100})` }} /></div>
        <small>{shortCount(usage.input)} input · {shortCount(usage.output)} output · {shortCount(usage.cacheRead)} cache read · {shortCount(usage.cacheCreation)} cache write</small>
        <small>{usage.requests ?? '—'} requests · {formatPercent(usage.cacheHitPercent)} input từ cache · {usage.misses ?? '—'} misses · {usage.costUsd === null ? 'chi phí chưa rõ' : money.format(usage.costUsd)}</small>
        <small>Prompt cache: {usage.cacheStatus === 'warm' ? 'warm' : usage.cacheStatus === 'cold' ? 'cold' : 'chưa rõ'}{usage.cacheTtlMinutes ? ` · TTL ${usage.cacheTtlMinutes} phút` : ''} · hoạt động {formatAge(usage.lastActivityMs)}</small>
        {usage.metricsFromMs !== null && <small>Chi tiết request/cache từ {formatTime(usage.metricsFromMs)}</small>}
        <small>{shortCount(usage.tokenCount)} token tổng · {shortCount(usage.weightedTokens)} token trọng số</small>
      </div>)}
    </details>}
    <div className="machines">
      <h4>Máy đã đăng ký <span>{user.machines.length}</span></h4>
      {user.machines.length === 0 ? <p className="empty">Chưa có máy.</p> : user.machines.map((machine) => <div className="machine" key={machine.machineId}>
        <span className={`dot ${machine.offline ? 'offline' : ''}`} aria-hidden="true" />
        <div className="machine-copy"><strong>{machine.hostname}</strong><small>{machine.lastSeenMs ? `Báo lần cuối ${formatTime(machine.lastSeenMs)}` : 'Chưa gửi báo cáo'} · agent {machine.agentVersion || 'chưa rõ'}</small><small>Tính token từ {formatTime(machine.trackingSinceMs)}</small><small className="machine-usage">Ước tính đóng góp: {formatPercent(machine.usedPercent)} tài khoản · {formatPercent(machine.observedSharePercent)} token quan sát</small></div>
        <span className={`machine-status ${machine.offline ? 'offline' : ''}`}>{machine.offline ? 'Offline' : 'Online'}</span>
        <button className="icon-button" type="button" disabled={busy} onClick={() => onRemove(machine.machineId, machine.hostname)} aria-label={`Gỡ máy ${machine.hostname}`} title="Gỡ máy">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6m-9 4h12m-10 0 .7 13h6.6L16 7M10 10v7m4-7v7" /></svg>
        </button>
      </div>)}
    </div>
  </article>;
}

export function App() {
  const [state, setState] = useState<HubState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [showInstaller, setShowInstaller] = useState(false);
  const [installPlatform, setInstallPlatform] = useState<'ubuntu' | 'macos'>('ubuntu');
  const [copied, setCopied] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(() => window.localStorage.getItem('claude-hub-account') || '');

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await getState(selectedAccount || null);
      setState(next); setError('');
      if (!selectedAccount && next.selectedAccountUuid) {
        setSelectedAccount(next.selectedAccountUuid);
        window.localStorage.setItem('claude-hub-account', next.selectedAccountUuid);
      } else if (selectedAccount && next.selectedAccountUuid !== selectedAccount && next.selectedAccountUuid) {
        setSelectedAccount(next.selectedAccountUuid);
        window.localStorage.setItem('claude-hub-account', next.selectedAccountUuid);
      }
      setDraft(Object.fromEntries(next.users.map((user) => [user.username, String(user.quotaPercent)])));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không tải được dữ liệu.'); }
    finally { if (!silent) setLoading(false); }
  }, [selectedAccount]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 60_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const draftTotal = useMemo(() => Object.values(draft).reduce((sum, value) => sum + (Number(value) || 0), 0), [draft]);
  const installCommand = `bash <(curl -fsSL ${window.location.origin}/install/${installPlatform}.sh)`;

  async function copyInstallCommand() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(installCommand);
      else throw new Error('Clipboard API không khả dụng');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = installCommand;
      textarea.style.position = 'fixed'; textarea.style.opacity = '0';
      document.body.append(textarea); textarea.select(); document.execCommand('copy'); textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  }

  async function submitQuotas(event: React.FormEvent) {
    event.preventDefault(); setNotice(''); setError('');
    const quotas = Object.fromEntries(Object.entries(draft).map(([name, value]) => [name, Number(value)]));
    setBusy(true);
    try { await saveQuotas(quotas, selectedAccount); setNotice('Đã lưu phân bổ quota.'); await refresh(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Không lưu được quota.'); }
    finally { setBusy(false); }
  }

  async function handleRemove(machineId: string, host: string) {
    if (!window.confirm(`Gỡ máy “${host}”? Token máy sẽ bị thu hồi.`)) return;
    setBusy(true); setError(''); setNotice('');
    try { await removeMachine(machineId); setNotice(`Đã gỡ máy ${host}.`); await refresh(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Không gỡ được máy.'); }
    finally { setBusy(false); }
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7.5 12 3l7 4.5v9L12 21l-7-4.5v-9Z" /><path d="m8.5 10 3.5 2 3.5-2M12 12v4" /></svg></span>
        <div><h1>Claude Hub</h1><p>Hạn mức dùng chung, rõ theo từng người</p></div>
      </div>
      {state && state.accounts.length > 0 && <label className="account-picker"><span>Tài khoản Claude</span><select aria-label="Chọn tài khoản Claude" value={state.selectedAccountUuid ?? ''} onChange={(event) => { const value = event.target.value; setSelectedAccount(value); window.localStorage.setItem('claude-hub-account', value); }}>
        {state.accounts.map((account) => <option key={account.accountUuid} value={account.accountUuid}>{account.label}</option>)}
      </select></label>}
      <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading || busy}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6.2 6.2L4 11m16 2-2.2 4.8A7 7 0 0 1 5.5 15" /></svg>
        {loading ? 'Đang tải…' : 'Làm mới'}
      </button>
    </header>
    <main id="main" tabIndex={-1}>
      {error && <div className="banner danger-banner" role="alert"><strong>Có lỗi</strong><span>{error}</span></div>}
      {notice && <div className="banner success-banner" role="status"><strong>Hoàn tất</strong><span>{notice}</span></div>}
      {state && !state.quotaValid && <div className="banner warn-banner" role="alert"><strong>Tổng quota chưa bằng 100%</strong><span>Người mới đang có quota 0%. Hãy phân bổ lại ở phần quản trị.</span></div>}
      {state && <>
        <section className="overview" aria-labelledby="overview-title">
          <div className="overview-main">
            <p className="eyebrow" id="overview-title">Hạn mức tuần của tài khoản</p>
            <div className="account-value mono">{formatPercent(state.accountPercent)}</div>
            <Progress value={state.accountPercent} label={`Tài khoản đã dùng ${formatPercent(state.accountPercent)}`} />
            <div className="overview-meta">
              <span><strong>Reset theo Claude</strong>{formatTime(state.accountResetAt ?? state.resetAt)}</span>
              <span><strong>Cập nhật lúc</strong>{formatTime(state.fetchedAtMs)} {state.stale && <b className="stale">Dữ liệu cũ</b>}</span>
            </div>
          </div>
          <aside className="method-note"><h2>Cách tính</h2><p>Mức dùng theo người được phân bổ theo token trọng số giữa các máy. Đây là xấp xỉ, không phải công thức của Anthropic.</p><dl><div><dt>Input</dt><dd>×{state.weights.input}</dd></div><div><dt>Output</dt><dd>×{state.weights.output}</dd></div><div><dt>Cache tạo</dt><dd>×{state.weights.cacheCreation}</dd></div><div><dt>Cache đọc</dt><dd>×{state.weights.cacheRead}</dd></div></dl></aside>
        </section>

        <section className="section" aria-labelledby="people-title">
          <div className="section-head"><div><p className="eyebrow">Phân bổ sử dụng</p><h2 id="people-title">Theo người</h2></div><span className="count">{state.users.length} người</span></div>
          {state.users.length ? <div className="user-grid">{state.users.map((user) => <UserCard key={user.username} user={user} onRemove={handleRemove} busy={busy} />)}</div> : <div className="empty-card"><h3>Chưa có máy đăng ký</h3><p>Cài agent trên máy Claude CLI đầu tiên để lấy usage hiện tại.</p><button className="primary-button empty-action" type="button" onClick={() => setShowInstaller(true)}>Cài máy đầu tiên</button></div>}
        </section>

        <section className="install-panel" aria-labelledby="install-title">
          <div className="install-summary">
            <div><p className="eyebrow">Thiết lập agent</p><h2 id="install-title">Cài máy mới</h2><p>Chạy một lệnh trên máy đang dùng Claude CLI. Script chỉ hỏi username; account và mốc theo dõi được nhận diện tự động.</p></div>
            <button className="secondary-button" type="button" aria-expanded={showInstaller} aria-controls="install-details" onClick={() => setShowInstaller((value) => !value)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></svg>
              {showInstaller ? 'Đóng hướng dẫn' : 'Lấy script cài đặt'}
            </button>
          </div>
          {showInstaller && <div className="install-details" id="install-details">
            <div className="platform-tabs" role="group" aria-label="Chọn hệ điều hành">
              <button type="button" aria-pressed={installPlatform === 'ubuntu'} onClick={() => { setInstallPlatform('ubuntu'); setCopied(false); }}>Ubuntu</button>
              <button type="button" aria-pressed={installPlatform === 'macos'} onClick={() => { setInstallPlatform('macos'); setCopied(false); }}>macOS</button>
            </div>
            <p className="install-note">Mở Terminal trên máy cần cài và dán lệnh dưới đây.</p>
            <div className="command-row"><code>{installCommand}</code><button className="primary-button copy-button" type="button" onClick={() => void copyInstallCommand()}>{copied ? 'Đã sao chép' : 'Sao chép lệnh'}</button></div>
            <div className="install-meta"><span>Tự cài Node.js 24 nếu cần</span><span>Gửi sau mỗi lượt chat</span><a href={`/install/${installPlatform}.sh`} target="_blank" rel="noreferrer">Xem nội dung script</a></div>
            <span className="sr-only" aria-live="polite">{copied ? 'Đã sao chép lệnh cài đặt.' : ''}</span>
          </div>}
        </section>

        <section className="admin-panel" aria-labelledby="quota-title">
          <div className="section-head"><div><p className="eyebrow">Quản trị</p><h2 id="quota-title">Phân bổ quota</h2></div><span className={`total ${Math.abs(draftTotal - 100) <= .01 ? 'valid' : 'invalid'}`}>Tổng {number.format(draftTotal)}%</span></div>
          <p className="helper">Phân bổ quota cho toàn bộ người dùng. Tổng phải bằng 100%.</p>
          <form onSubmit={submitQuotas}>
            <div className="quota-fields">{state.users.map((user) => <label key={user.username}><span>{user.username}</span><span className="input-suffix"><input type="number" min="0" max="100" step="0.1" inputMode="decimal" value={draft[user.username] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [user.username]: event.target.value }))} required />%</span></label>)}</div>
            <div className="admin-actions"><button className="primary-button" type="submit" disabled={busy || state.users.length === 0 || Math.abs(draftTotal - 100) > .01}>{busy ? 'Đang lưu…' : 'Lưu phân bổ'}</button></div>
          </form>
        </section>

      </>}
      {!state && loading && <div className="loading-card" role="status">Đang tải dữ liệu từ hub…</div>}
    </main>
    <footer><span>Telegram: {state?.telegramConfigured ? 'đã cấu hình' : 'chưa cấu hình'}</span><span>Hub chỉ cảnh báo, không chặn sử dụng.</span></footer>
  </div>;
}
