import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Monitor } from 'lucide-react';
import type { DesktopPreferences } from '../types';
import { isNative, isNativeMac } from '../lib/platform';

const preview: DesktopPreferences = { closeAction: 'quit', launchAtLogin: false, trayAvailable: false, autostartAvailable: false };
const messageFor = (error: unknown) => error instanceof Error ? error.message : String(error);

async function readDesktopPreferences(): Promise<DesktopPreferences> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<DesktopPreferences>('get_desktop_preferences');
}

/** Native settings are authoritative: no startup writes or optimistic OS state. */
export function DesktopPreferencesPanel() {
  const [value, setValue] = useState<DesktopPreferences | null>(isNative ? null : preview);
  const [loading, setLoading] = useState(isNative);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const requestRef = useRef(0);
  const savingRef = useRef(false);
  const read = useCallback(async () => {
    if (!isNative || savingRef.current) return;
    const request = ++requestRef.current;
    setLoading(true); setError(''); setStatus('');
    try {
      const actual = await readDesktopPreferences();
      if (request === requestRef.current) setValue(actual);
    } catch (cause) {
      if (request === requestRef.current) { setValue(null); setError(`无法读取桌面设置：${messageFor(cause)}`); }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void read();
    return () => { ++requestRef.current; };
  }, [read]);

  const change = async (patch: Partial<Pick<DesktopPreferences, 'closeAction' | 'launchAtLogin'>>) => {
    if (!isNative || !value || loading || savingRef.current) return;
    const requested = {
      closeAction: value.closeAction,
      launchAtLogin: value.launchAtLogin,
      ...patch,
      // Closing behavior changes must not overwrite an external OS startup
      // change using the older value displayed by this settings panel.
      updateLaunchAtLogin: 'launchAtLogin' in patch,
    };
    const request = ++requestRef.current;
    savingRef.current = true; setSaving(true); setError(''); setStatus('');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const actual = await invoke<DesktopPreferences>('set_desktop_preferences', requested);
      if (request !== requestRef.current) return;
      setValue(actual);
      if (actual.closeAction !== requested.closeAction || (requested.updateLaunchAtLogin && actual.launchAtLogin !== requested.launchAtLogin)) {
        setError('系统返回的设置与请求不同，请重新检查后再试。');
      } else setStatus('设置已更新');
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(`设置未能更新：${messageFor(cause)}`);
      // A failed operation can still have a partial OS effect. Re-read instead
      // of presenting either the requested value or a guessed rollback.
      try {
        const actual = await readDesktopPreferences();
        if (request === requestRef.current) setValue(actual);
      } catch {
        if (request === requestRef.current) setValue(null);
      }
    } finally {
      savingRef.current = false;
      if (request === requestRef.current) setSaving(false);
    }
  };
  const disabled = !isNative || loading || saving || !value;

  return <section className="settings-section desktop-preferences" aria-label="桌面行为" aria-busy={loading || saving}>
    <div className="section-title"><h2>桌面行为</h2><Monitor size={18} /></div>
    {!isNative && <p className="section-description">请在桌面应用中设置。浏览器预览不会更改系统启动项或关闭行为。</p>}
    <div className="setting-row">
      <div><strong>关闭主窗口时</strong><p>默认退出应用；也可保留后台截图快捷键。</p></div>
      <select
        className="settings-select"
        aria-label="关闭主窗口时"
        value={value?.closeAction ?? 'quit'}
        disabled={disabled}
        onChange={event => { void change({ closeAction: event.target.value as 'quit' | 'tray' }); }}
      >
        <option value="quit">退出应用</option>
        <option value="tray" disabled={!value?.trayAvailable}>{isNativeMac ? '隐藏到菜单栏' : '隐藏到托盘'}</option>
      </select>
    </div>
    {isNative && value && !value.trayAvailable && <p className="desktop-setting-note">系统托盘暂不可用，关闭窗口时将退出应用。</p>}
    <div className="setting-row">
      <div><strong>开机启动</strong><p>登录系统后自动运行 FastLingo，默认关闭。</p></div>
      <button
        className={`toggle ${value?.launchAtLogin ? 'on' : ''}`}
        role="switch"
        aria-label="开机启动"
        aria-checked={value?.launchAtLogin ?? false}
        disabled={disabled || !value?.autostartAvailable}
        onClick={() => { void change({ launchAtLogin: !value?.launchAtLogin }); }}
      ><span /></button>
    </div>
    {isNative && value && !value.autostartAvailable && <p className="desktop-setting-note">{value.autostartError || '当前系统暂不支持修改开机启动。'}</p>}
    {(loading || saving) && <p className="desktop-setting-status" role="status"><LoaderCircle size={14} className="spin" />{loading ? '正在读取系统设置…' : '正在应用设置…'}</p>}
    {status && <p className="desktop-setting-status" role="status">{status}</p>}
    {error && <div className="desktop-setting-error" role="alert"><span>{error}</span><button className="text-button" disabled={loading || saving} onClick={() => { void read(); }}>重新读取</button></div>}
  </section>;
}
