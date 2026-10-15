import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, ScanLine, ShieldCheck } from 'lucide-react';
import { getScreenPermission, isNativeMac, openScreenPermissionSettings, requestScreenPermission } from '../lib/platform';
import type { ScreenPermission } from '../lib/platform';

export function useMacScreenPermission() {
  const [permission, setPermission] = useState<ScreenPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  const operation = useRef(0);
  const check = useCallback(async () => {
    const version = ++operation.current;
    try {
      const result = await getScreenPermission();
      if (mounted.current && version === operation.current) { setPermission(result); setMessage(''); }
      return result;
    } catch {
      if (mounted.current && version === operation.current) setMessage('无法读取录屏权限，请重新检查或打开系统设置。');
      throw new Error('无法读取录屏权限，请重新检查或打开系统设置。');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!isNativeMac) return () => { mounted.current = false; };
    // Checking never displays an OS permission prompt. Only the explicit button requests access.
    void check().catch(() => undefined);
    const focus = () => { void check().catch(() => undefined); };
    window.addEventListener('focus', focus);
    return () => { mounted.current = false; ++operation.current; window.removeEventListener('focus', focus); };
  }, [check]);
  const request = useCallback(async () => {
    const version = ++operation.current;
    setBusy(true); setMessage('');
    try {
      const result = await requestScreenPermission();
      if (mounted.current && version === operation.current) {
        setPermission(result);
        setMessage(result.granted ? '录屏权限已开启，可以开始截图翻译。' : '请在系统设置中允许 FastLingo录屏，再点击重新检查。若权限尚未生效，请退出后重新打开 FastLingo。');
      }
    } catch { if (mounted.current) setMessage('无法请求录屏权限，请打开系统设置后手动开启。'); }
    finally { if (mounted.current) setBusy(false); }
  }, []);
  const openSettings = useCallback(async () => {
    try { await openScreenPermissionSettings(); if (mounted.current) setMessage('系统设置已打开，开启权限后请回来重新检查。'); }
    catch { if (mounted.current) setMessage('无法打开系统设置，请手动前往隐私与安全性中的屏幕录制设置。'); }
  }, []);
  return { permission, busy, message, check, request, openSettings };
}

export type MacScreenPermissionState = ReturnType<typeof useMacScreenPermission>;
export function MacScreenPermissionPanel({ state, onCapture }: { state: MacScreenPermissionState; onCapture: () => void }) {
  const { permission, busy, message, check, request, openSettings } = state;
  const granted = permission?.granted === true;
  const status = !permission ? '正在检查' : granted ? '已授权' : permission.supported ? '尚未授权' : '无法检查';
  return <section className="settings-section mac-permission-section" aria-label="macOS 屏幕录制权限">
    <div className="section-title"><h2><ShieldCheck size={17}/>屏幕录制权限</h2><span className={`permission-badge ${granted ? 'granted' : ''}`}>{granted && <Check size={12}/>}<span>{status}</span></span></div>
    <p className="section-description">FastLingo 需要 macOS 的屏幕录制权限才能框选文字。截图与 OCR 在本机完成，识别出的文字发送到你选择的翻译 API。</p>
    <p className="permission-instructions">在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 FastLingo。旧版 macOS 中此项可能叫“屏幕录制”。更改后若仍无法截图，请退出并重新打开 FastLingo。</p>
    <div className="permission-actions">
      {!granted && <button className="button primary small" onClick={() => {void request();}} disabled={busy}>{busy ? <LoaderCircle size={14} className="spin"/> : <ShieldCheck size={14}/>}授予录屏权限</button>}
      <button className="button secondary small" onClick={() => {void openSettings();}} disabled={busy}><ExternalLink size={14}/>打开系统设置</button>
      <button className="button secondary small" onClick={() => {void check().catch(() => undefined);}} disabled={busy}>重新检查</button>
      {granted && <button className="button primary small" onClick={onCapture}><ScanLine size={14}/>开始截图</button>}
    </div>
    {message && <p className="permission-message" aria-live="polite">{message}</p>}
  </section>;
}
