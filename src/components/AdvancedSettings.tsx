import { useEffect, useRef } from 'react';
import { ArrowLeft, ImagePlus, Zap } from 'lucide-react';
import type { Preferences } from '../types';
import { OCR_LANGUAGES } from '../lib/catalog';
import { isMobile, isNative, isNativeMac, shortcutLabels } from '../lib/platform';
import { DesktopPreferencesPanel } from './DesktopPreferencesPanel';
import { MacScreenPermissionPanel, type MacScreenPermissionState } from './MacScreenPermission';

interface Props {
  preferences: Preferences;
  macPermission: MacScreenPermissionState;
  onPreferences: (patch: Partial<Preferences>) => void;
  onCapture: () => void;
  onWarmOcr: () => void;
  onQuit: () => void;
  onBack: () => void;
}

export function AdvancedSettings({ preferences, macPermission, onPreferences, onCapture, onWarmOcr, onQuit, onBack }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  return <>
    <div className="page-heading advanced-settings-heading">
      <button className="icon-button settings-back" aria-label="返回设置" onClick={onBack}><ArrowLeft size={20} /></button>
      <h1 ref={heading} tabIndex={-1}>高级设置</h1>
    </div>

    <section className="settings-section" aria-label="文字识别">
      <div className="section-title"><h2>文字识别</h2></div>
      <div className="setting-row">
        <div><strong>OCR 识别语言</strong></div>
        <select
          className="settings-select"
          aria-label="OCR 识别语言"
          value={preferences.ocrLang}
          onChange={(event) => onPreferences({ ocrLang: event.target.value })}
        >
          {OCR_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
        </select>
      </div>
      <div className="setting-row">
        <div><strong>预热识别引擎</strong><p>减少首次识别的等待</p></div>
        <button className="button secondary small" onClick={onWarmOcr}><Zap size={14} />预热</button>
      </div>
    </section>

    {!isMobile && <DesktopPreferencesPanel />}
    {isNativeMac && <MacScreenPermissionPanel state={macPermission} onCapture={onCapture} />}

    <section className="settings-section" id="quickstart" aria-label={isMobile ? '截图与粘贴' : '快捷键'}>
      <div className="section-title"><h2>{isMobile ? '截图与粘贴' : '快捷键'}</h2></div>
      {isMobile ? <>
        <p className="section-description">导入系统截图，或回到翻译页粘贴文字。</p>
        <button className="button secondary small" onClick={onCapture}><ImagePlus size={16} />选取截图</button>
      </> : <>
        <div className="shortcut-row"><span>截图翻译</span><kbd>{shortcutLabels.capture}</kbd></div>
        <div className="shortcut-row"><span>剪贴板翻译</span><kbd>{shortcutLabels.clipboard}</kbd></div>
        <div className="shortcut-row"><span>翻译输入内容</span><kbd>{shortcutLabels.translate}</kbd></div>
        <div className="shortcut-row"><span>取消截图或翻译</span><kbd>Esc</kbd></div>
        {isNative && <div className="shortcut-row">
          <span>退出应用{isNativeMac && <small className="mac-quit-hint">⌘Q / ⌥⌘Q</small>}</span>
          <button className="button secondary small" onClick={onQuit}>退出 FastLingo</button>
        </div>}
        {!isNative && <p className="platform-note">全局快捷键需使用桌面应用。</p>}
      </>}
    </section>
  </>;
}
