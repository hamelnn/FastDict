import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Check, X, Scan } from 'lucide-react';
import type { Screenshot } from '../types';

type Rect = { x: number; y: number; width: number; height: number };
type CaptureFrame = Screenshot & { sessionId: number };
type CropperProps = {
  screenshot: Screenshot;
  onConfirm: (rect: Rect) => void;
  onCancel: () => void;
  native?: boolean;
  disabled?: boolean;
  onImageReady?: () => void;
  onImageError?: (message: string) => void;
};

export function ImageCropper({ screenshot, onConfirm, onCancel, native = false, disabled = false, onImageReady, onImageError }: CropperProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const pointerRef = useRef<number | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);

  useEffect(() => {
    let disposed = false, ready = false, frame = 0, timer = 0;
    const complete = () => {
      if (disposed || ready) return;
      ready = true; cancelAnimationFrame(frame); window.clearTimeout(timer);
      onImageReady?.();
    };
    const image = imageRef.current;
    if (image) void image.decode().then(() => {
      if (disposed) return;
      // Hidden WebViews may suspend animation frames; decoded pixels are sufficient
      // after React commits, with a timer fallback to avoid a hidden-window deadlock.
      timer = window.setTimeout(complete, 40);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(complete); });
    }).catch(() => { if (!disposed) onImageError?.('无法显示这张截图，请按 Esc 后重新截图。'); });
    return () => { disposed = true; cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [screenshot.dataUrl, onImageReady, onImageError]);

  const point = (event: React.PointerEvent) => {
    const bounds = imageRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)) };
  };
  const confirmSelection = (rect: Rect | null) => {
    if (disabled || !rect || rect.width < 5 || rect.height < 5) return;
    const bounds = imageRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const sx = screenshot.width / bounds.width, sy = screenshot.height / bounds.height;
    const x = Math.max(0, Math.min(screenshot.width - 1, Math.round(rect.x * sx)));
    const y = Math.max(0, Math.min(screenshot.height - 1, Math.round(rect.y * sy)));
    const right = Math.min(screenshot.width, Math.round((rect.x + rect.width) * sx));
    const bottom = Math.min(screenshot.height, Math.round((rect.y + rect.height) * sy));
    onConfirm({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) });
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault(); event.stopPropagation();
      if (disabled) return;
      if (event.key === 'Escape') onCancel();
      else confirmSelection(selection);
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  });
  const endDrag = () => { startRef.current = null; pointerRef.current = null; };
  return <div className={'crop-overlay ' + (native ? 'native-crop' : '')} role="dialog" aria-label="选择截图区域" aria-busy={disabled}>
    <div className="crop-instructions"><Scan size={18} /><span>{disabled ? '正在准备翻译…' : native ? '框选文字，松开即翻译' : '拖动选择需要翻译的区域'}</span>{!native && <kbd>Enter 确认</kbd>}<kbd>Esc 取消</kbd></div>
    <div className="crop-surface" onPointerDown={event => {
      if (disabled || event.button !== 0 || pointerRef.current !== null || !imageRef.current?.naturalWidth) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = event.pointerId; startRef.current = point(event); setSelection(null);
    }} onPointerMove={event => {
      if (!startRef.current || event.pointerId !== pointerRef.current) return;
      const p = point(event), s = startRef.current;
      setSelection({ x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
    }} onPointerUp={event => {
      if (!startRef.current || event.pointerId !== pointerRef.current) return;
      const p = point(event), s = startRef.current;
      const rect = { x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) };
      endDrag(); setSelection(rect);
      if (native) confirmSelection(rect);
    }} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <img ref={imageRef} src={screenshot.dataUrl} alt="待选择的屏幕截图" draggable={false} />
      {selection ? <div className="crop-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}><span>{Math.round(selection.width * screenshot.width / (imageRef.current?.clientWidth || screenshot.width))} × {Math.round(selection.height * screenshot.height / (imageRef.current?.clientHeight || screenshot.height))}</span></div> : <div className="crop-shade" />}
    </div>
    {!native && <div className="crop-actions"><button className="button secondary" onClick={onCancel} disabled={disabled}><X size={16} />取消</button><button className="button primary" onClick={() => confirmSelection(selection)} disabled={disabled || !selection || selection.width < 5 || selection.height < 5}><Check size={16} />翻译选区</button></div>}
  </div>;
}

export default function CaptureOverlay() {
  const [screenshot, setScreenshot] = useState<CaptureFrame | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const sessionRef = useRef<number | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const start = async (sessionId: number) => {
      if (disposed || !Number.isSafeInteger(sessionId) || sessionId <= 0 || sessionRef.current === sessionId) return;
      sessionRef.current = sessionId; submittingRef.current = false;
      setScreenshot(null); setError(''); setSubmitting(false);
      try {
        const frame = await invoke<Screenshot>('get_capture', { sessionId });
        if (!disposed && sessionRef.current === sessionId) setScreenshot({ ...frame, sessionId });
      } catch (reason) {
        if (disposed || sessionRef.current !== sessionId) return;
        setError(String(reason));
        void invoke('capture_ready', { sessionId }).catch(() => undefined);
      }
    };
    void (async () => {
      cleanups.push(await listen<{ sessionId: number }>('fastdict://capture-start', event => { void start(event.payload.sessionId); }));
      if (disposed) { cleanups.forEach(cleanup => cleanup()); return; }
      cleanups.push(await listen<{ sessionId: number }>('fastdict://capture-reset', event => {
        if (event.payload.sessionId !== sessionRef.current) return;
        sessionRef.current = null; submittingRef.current = false;
        setScreenshot(null); setError(''); setSubmitting(false);
      }));
      if (disposed) { cleanups.forEach(cleanup => cleanup()); return; }
      await invoke('capture_overlay_ready');
    })().catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; sessionRef.current = null; cleanups.forEach(cleanup => cleanup()); };
  }, []);

  const cancel = useCallback(() => {
    const sessionId = sessionRef.current;
    if (sessionId === null || submittingRef.current) return;
    submittingRef.current = true;
    void invoke('cancel_capture', { sessionId }).catch(reason => {
      if (sessionRef.current !== sessionId) return;
      setError(String(reason)); submittingRef.current = false;
    });
  }, []);
  useEffect(() => {
    if (!error) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [error, cancel]);
  const ready = useCallback(() => {
    if (!screenshot || sessionRef.current !== screenshot.sessionId) return;
    void invoke('capture_ready', { sessionId: screenshot.sessionId }).catch(reason => {
      if (sessionRef.current === screenshot.sessionId) setError(String(reason));
    });
  }, [screenshot]);
  const imageError = useCallback((message: string) => {
    if (!screenshot || sessionRef.current !== screenshot.sessionId) return;
    setError(message); ready();
  }, [screenshot, ready]);
  if (error) return <div className="capture-error" role="alert">{error}<button className="button secondary" onClick={cancel}>取消截图</button></div>;
  if (!screenshot) return <div className="capture-standby" aria-hidden="true" />;
  return <ImageCropper key={screenshot.sessionId} native screenshot={screenshot} disabled={submitting} onImageReady={ready} onImageError={imageError} onCancel={cancel} onConfirm={rect => {
    if (submittingRef.current || sessionRef.current !== screenshot.sessionId) return;
    submittingRef.current = true; setSubmitting(true);
    void invoke('finish_capture', { sessionId: screenshot.sessionId, ...rect }).catch(reason => {
      if (sessionRef.current !== screenshot.sessionId) return;
      setError(String(reason)); setSubmitting(false); submittingRef.current = false;
    });
  }} />;
}
