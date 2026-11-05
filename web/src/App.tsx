import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { HubState, UsageHistoryPoint, UserState } from '../../shared/types.ts';
import { getHistory, getState, removeMachine, saveQuotas, setAppendOnlyUsage } from './api.ts';

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

function AccountPicker({ accounts, selected, onChange }: {
  accounts: HubState['accounts']; selected: string | null; onChange: (account: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, accounts.findIndex((account) => account.accountUuid === selected));
  const active = accounts[activeIndex] ?? accounts[selectedIndex];

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    document.getElementById(`account-option-${active?.accountUuid}`)?.scrollIntoView({ block: 'nearest' });
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open, active?.accountUuid]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false); triggerRef.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + accounts.length) % accounts.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); setActiveIndex(event.key === 'Home' ? 0 : accounts.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (active) { onChange(active.accountUuid); setOpen(false); triggerRef.current?.focus(); }
    }
  }

  return <div className="account-picker" ref={rootRef}>
    <span id="account-picker-label">Tài khoản Claude</span>
    <button
      ref={triggerRef}
      className="account-picker-trigger"
      type="button"
      aria-labelledby="account-picker-label account-picker-value"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls="account-picker-list"
      onClick={() => { setActiveIndex(selectedIndex); setOpen((current) => !current); }}
    >
      <span id="account-picker-value" className="account-picker-value">{accounts[selectedIndex]?.label ?? 'Chọn tài khoản'}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </button>
    {open && <div
      className="account-picker-menu"
      id="account-picker-list"
      ref={listRef}
      role="listbox"
      aria-labelledby="account-picker-label"
      aria-activedescendant={active ? `account-option-${active.accountUuid}` : undefined}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {accounts.map((account, index) => <div
        className={`account-picker-option ${account.accountUuid === selected ? 'selected' : ''} ${index === activeIndex ? 'active' : ''}`}
        id={`account-option-${account.accountUuid}`}
        key={account.accountUuid}
        role="option"
        aria-selected={account.accountUuid === selected}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => { onChange(account.accountUuid); setOpen(false); triggerRef.current?.focus(); }}
      >
        <span className="account-option-check" aria-hidden="true">{account.accountUuid === selected ? '✓' : ''}</span>
        <span className="account-option-label" title={account.label}>{account.label}</span>
      </div>)}
    </div>}
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
  const [history, setHistory] = useState<UsageHistoryPoint[]>([]);
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
      const timeline = next.selectedAccountUuid ? await getHistory(next.selectedAccountUuid) : { points: [] };
      setHistory(timeline.points);
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
  const chartOptions = useMemo<Highcharts.Options>(() => {
    const total = state?.users.reduce((sum, user) => sum + user.weightedTokens, 0) ?? 0;
    const start = state?.weekKey ? Date.parse(state.weekKey) - 7 * 86400_000 : undefined;
    const colors = ['#62d8c0', '#f0bf68', '#8fa7ff', '#e98f9a', '#b393e8', '#91c9df'];
    const series: Highcharts.SeriesLineOptions[] = (state?.users ?? []).map((user, index) => ({
      type: 'line', name: user.username, color: colors[index % colors.length], lineWidth: 2.5,
      marker: { enabled: false },
      data: [
        ...(start === undefined ? [] : [[start, 0] as [number, number]]),
        ...history.map((point) => {
          const weighted = point.weightedTokensByUser[user.username] ?? 0;
          const value = total > 0 && user.quotaPercent > 0
            ? weighted / total * state!.accountPercent / user.quotaPercent * 100 : 0;
          return [point.timestamp, value] as [number, number];
        }),
      ],
    }));
    return {
      chart: { type: 'line', height: 300, backgroundColor: 'transparent', spacing: [12, 8, 8, 8], style: { fontFamily: 'inherit' } },
      title: { text: undefined }, credits: { enabled: false }, exporting: { enabled: false },
      xAxis: { type: 'datetime', lineColor: '#2b3a3e', tickColor: '#2b3a3e', labels: { style: { color: '#a8b8bb' } } },
      yAxis: { min: 0, title: { text: undefined }, gridLineColor: '#263438', labels: { format: '{value}%', style: { color: '#a8b8bb' } } },
      legend: { itemStyle: { color: '#eaf1f2', fontWeight: '600' }, itemHoverStyle: { color: '#62d8c0' } },
      tooltip: { shared: true, xDateFormat: '%d/%m %H:%M', valueDecimals: 1, valueSuffix: '% quota' },
      plotOptions: { series: { animation: false, states: { inactive: { opacity: 0.35 } } } },
      series,
    };
  }, [history, state]);
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

  async function changeAppendOnly(enabled: boolean) {
    setBusy(true); setError(''); setNotice('');
    try { await setAppendOnlyUsage(enabled); setNotice(enabled ? 'Đã bật chế độ chỉ cộng usage.' : 'Đã tắt chế độ chỉ cộng usage.'); await refresh(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Không lưu được cài đặt.'); }
    finally { setBusy(false); }
  }

  function distributeEvenly() {
    if (!state?.users.length) return;
    const unitsPerUser = Math.floor(1000 / state.users.length);
    const remainder = 1000 - unitsPerUser * state.users.length;
    setDraft(Object.fromEntries(state.users.map((user, index) => [
      user.username,
      ((unitsPerUser + (index < remainder ? 1 : 0)) / 10).toFixed(1),
    ])));
  }

  async function handleRemove(machineId: string, host: string) {
    if (!window.confirm(`Gỡ máy “${host}”? Token máy sẽ bị thu hồi.`)) return;
    setBusy(true); setError(''); setNotice('');
    try { await removeMachine(machineId); setNotice(`Đã gỡ máy ${host}.`); await refresh(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Không gỡ được máy.'); }
    finally { setBusy(false); }
  }

  function selectAccount(value: string) {
    setSelectedAccount(value);
    window.localStorage.setItem('claude-hub-account', value);
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark"><img src="/claude-hub-logo.png" alt="Claude Hub" /></span>
        <div><h1>Claude Hub</h1><p>Hạn mức dùng chung, rõ theo từng người</p></div>
      </div>
      {state && state.accounts.length > 0 && <AccountPicker accounts={state.accounts} selected={state.selectedAccountUuid} onChange={selectAccount} />}
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

        <section className="section history-section" aria-labelledby="history-title">
          <div className="section-head"><div><p className="eyebrow">Tiến trình trong kỳ</p><h2 id="history-title">Mức dùng theo người</h2></div></div>
          <div className="history-chart">
            {history.length > 0 ? <HighchartsReact highcharts={Highcharts} options={chartOptions} />
              : <p className="history-empty">Lịch sử biểu đồ sẽ được ghi nhận từ các report sau khi tính năng này được cài đặt.</p>}
          </div>
          <p className="history-note">Ước tính tỷ lệ quota theo token trọng số; đường biểu đồ chỉ có dữ liệu từ khi Hub bắt đầu lưu lịch sử.</p>
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
            <div className="admin-actions"><button className="secondary-button" type="button" onClick={distributeEvenly} disabled={busy || state.users.length === 0}>Chia đều</button><button className="primary-button" type="submit" disabled={busy || state.users.length === 0 || Math.abs(draftTotal - 100) > .01}>{busy ? 'Đang lưu…' : 'Lưu phân bổ'}</button></div>
          </form>
        </section>

        <details className="admin-panel data-policy">
          <summary><span><span className="eyebrow">Cài đặt dữ liệu nâng cao</span><strong>Chế độ lưu usage</strong></span></summary>
          <label className="append-only-setting"><input type="checkbox" checked={state.usageAppendOnly} disabled={busy} onChange={(event) => void changeAppendOnly(event.target.checked)} /><span><strong>Chỉ cộng usage, không giảm số đã lưu</strong><small>Khi bật, report mới chỉ làm tổng token tăng trong cùng kỳ reset. Nếu agent gửi số thấp hơn, Hub giữ số cao đã có. Kỳ mới sẽ bắt đầu lại.</small></span></label>
        </details>

      </>}
      {!state && loading && <div className="loading-card" role="status">Đang tải dữ liệu từ hub…</div>}
    </main>
    <footer><span>Telegram: {state?.telegramConfigured ? 'đã cấu hình' : 'chưa cấu hình'}</span><span>Hub chỉ cảnh báo, không chặn sử dụng.</span></footer>
  </div>;
}
