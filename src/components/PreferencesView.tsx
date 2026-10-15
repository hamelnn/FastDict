import { Monitor, MoreHorizontal, Plus, ShieldCheck, Zap } from 'lucide-react';
import type { Preferences, Provider } from '../types';
import { OCR_LANGUAGES } from '../lib/catalog';
import { isMobile, isNative, isNativeMac, shortcutLabels } from '../lib/platform';
import { MacScreenPermissionPanel, type MacScreenPermissionState } from './MacScreenPermission';

interface Props {
  preferences: Preferences;
  providers: Provider[];
  macPermission: MacScreenPermissionState;
  onPreferences: (patch: Partial<Preferences>) => void;
  onAddProvider: () => void;
  onEditProvider: (provider: Provider) => void;
  onCapture: () => void;
  onWarmOcr: () => void;
  onQuit: () => void;
}

export function PreferencesView({
  preferences,
  providers,
  macPermission,
  onPreferences,
  onAddProvider,
  onEditProvider,
  onCapture,
  onWarmOcr,
  onQuit,
}: Props) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>偏好设置</h1>
          <p>管理翻译服务、识别语言和快捷键。</p>
        </div>
      </div>
      {isNativeMac && <MacScreenPermissionPanel state={macPermission} onCapture={onCapture} />}
      <section className="settings-section">
        <div className="section-title">
          <h2>翻译服务</h2>
          <button className="button secondary small" onClick={onAddProvider}>
            <Plus size={14} />
            添加服务
          </button>
        </div>
        <p className="section-description">支持 OpenAI 兼容接口、Anthropic 和 Gemini。</p>
        <div className="settings-providers">
          {providers.map((provider) => (
            <button key={provider.id} className="settings-provider" onClick={() => onEditProvider(provider)}>
              <span className={`provider-avatar provider-${provider.kind}`}>{provider.name.slice(0, 1)}</span>
              <span>
                <strong>{provider.name}</strong>
                <small>{provider.model}</small>
              </span>
              <span className={`key-status ${provider.hasKey ? 'key-saved' : ''}`}>
                {provider.hasKey ? '已配置密钥' : '待配置'}
              </span>
              <MoreHorizontal size={18} />
            </button>
          ))}
        </div>
        <div className="settings-note">
          <ShieldCheck size={15} />
          <span>
            {isNativeMac
              ? 'API Key 保存于 macOS 系统钥匙串。'
              : isNative
                ? 'Windows / macOS / iOS 使用系统保险库；Android 密钥仅保留在本次会话。'
                : '浏览器预览中的密钥仅保留在当前会话。安装原生应用可使用系统保险库。'}
          </span>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-title">
          <h2>捕获与识别</h2>
        </div>
        <div className="setting-row">
          <div>
            <strong>粘贴与导入后自动翻译</strong>
            <p>桌面框选始终立即翻译</p>
          </div>
          <button
            className={`toggle ${preferences.autoTranslate ? 'on' : ''}`}
            role="switch"
            aria-checked={preferences.autoTranslate}
            aria-label="粘贴与导入后自动翻译"
            onClick={() => onPreferences({ autoTranslate: !preferences.autoTranslate })}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>OCR 识别语言</strong>
            <p>与图片语言一致，识别更快、更准确</p>
          </div>
          <select
            className="settings-select"
            aria-label="OCR 识别语言"
            value={preferences.ocrLang}
            onChange={(event) => onPreferences({ ocrLang: event.target.value })}
          >
            {OCR_LANGUAGES.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>预热识别引擎</strong>
            <p>提前加载选定语言，缩短首次截图的等待</p>
          </div>
          <button className="button secondary small" onClick={onWarmOcr}>
            <Zap size={14} />
            预热
          </button>
        </div>
      </section>
      <section className="settings-section" id="quickstart">
        <div className="section-title">
          <h2>快捷开始</h2>
          <Monitor size={18} />
        </div>
        <div className="shortcut-row">
          <span>桌面全局截图翻译</span>
          <kbd>{shortcutLabels.capture}</kbd>
        </div>
        <div className="shortcut-row">
          <span>桌面全局剪贴板翻译</span>
          <kbd>{shortcutLabels.clipboard}</kbd>
        </div>
        <div className="shortcut-row">
          <span>翻译输入内容</span>
          <kbd>{shortcutLabels.translate}</kbd>
        </div>
        <div className="shortcut-row">
          <span>取消截图或当前翻译</span>
          <kbd>Esc</kbd>
        </div>
        {isNative && !isMobile && (
          <div className="shortcut-row">
            <span>退出桌面应用{isNativeMac && <small className="mac-quit-hint">⌘Q / ⌥⌘Q</small>}</span>
            <button className="button secondary small" onClick={onQuit}>
              退出轻译
            </button>
          </div>
        )}
        <p className="platform-note">
          {isNativeMac
            ? '首次截图需开启屏幕录制权限。隐藏窗口后可从菜单栏重新打开轻译；⌘Q 退出应用，⌥⌘Q 可立即退出。'
            : '桌面应用支持全局快捷键，框选后松开鼠标即翻译。网页预览需选择分享内容；iOS / Android 请粘贴文字或导入系统截图。移动端系统分享扩展尚未接入。'}
        </p>
      </section>
    </>
  );
}
