import { useEffect, useState } from 'react';
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import type { Preferences, Provider } from '../types';
import { isMobile, isNative } from '../lib/platform';
import { DEFAULT_TRANSLATION_PROMPT, MAX_PROMPT_LENGTH, validatePromptTemplate } from '../lib/prompts';
import { isKeylessProvider } from '../lib/translation';
import type { MacScreenPermissionState } from './MacScreenPermission';
import { AdvancedSettings } from './AdvancedSettings';

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
  const [advanced, setAdvanced] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(preferences.translationPrompt);
  const [promptStatus, setPromptStatus] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    setPromptDraft(preferences.translationPrompt);
  }, [preferences.translationPrompt]);

  const promptError = validatePromptTemplate(promptDraft.trim());
  const promptChanged = promptDraft.trim() !== preferences.translationPrompt;
  const savePrompt = () => {
    const value = promptDraft.trim();
    if (validatePromptTemplate(value)) return;
    try {
      onPreferences({ translationPrompt: value });
      setPromptDraft(value);
      setSaveError('');
      setPromptStatus('已保存');
      setEditingPrompt(false);
    } catch {
      setSaveError('提示词未能保存，请重试。');
    }
  };
  const restorePrompt = () => {
    try {
      onPreferences({ translationPrompt: DEFAULT_TRANSLATION_PROMPT });
      setPromptDraft(DEFAULT_TRANSLATION_PROMPT);
      setSaveError('');
      setPromptStatus('已恢复默认');
    } catch {
      setSaveError('提示词未能保存，请重试。');
    }
  };

  if (advanced) {
    return <AdvancedSettings
      preferences={preferences}
      macPermission={macPermission}
      onPreferences={onPreferences}
      onCapture={onCapture}
      onWarmOcr={onWarmOcr}
      onQuit={onQuit}
      onBack={() => setAdvanced(false)}
    />;
  }

  return (
    <>
      <div className="page-heading"><h1>设置</h1></div>

      <section className="settings-section" aria-label="翻译服务">
        <div className="section-title">
          <h2>翻译服务</h2>
          <button className="button secondary small" onClick={onAddProvider}>
            <Plus size={14} />添加服务
          </button>
        </div>
        <div className="settings-providers">
          {!providers.length && <div className="settings-provider-empty">添加一个服务，开始翻译。</div>}
          {providers.map((provider) => (
            <button key={provider.id} className="settings-provider" onClick={() => onEditProvider(provider)}>
              <span className={`provider-avatar provider-${provider.kind}`}>{provider.name.slice(0, 1)}</span>
              <span><strong>{provider.name}</strong><small>{provider.model}</small></span>
              <span className={`key-status ${provider.kind !== 'codex' && (provider.hasKey || isKeylessProvider(provider)) ? 'key-saved' : ''}`}>
                {provider.kind === 'codex' ? (isNative && !isMobile ? 'ChatGPT 订阅' : '仅桌面可用') : provider.hasKey || isKeylessProvider(provider) ? '已配置' : '待配置'}
              </span>
              <MoreHorizontal size={18} />
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-label="翻译偏好">
        <div className="setting-row">
          <div><strong>自动翻译</strong><p>粘贴或导入后自动开始</p></div>
          <button
            className={`toggle ${preferences.autoTranslate ? 'on' : ''}`}
            role="switch"
            aria-checked={preferences.autoTranslate}
            aria-label="粘贴与导入后自动翻译"
            onClick={() => onPreferences({ autoTranslate: !preferences.autoTranslate })}
          ><span /></button>
        </div>
        <div className="setting-row">
          <div><strong>翻译提示词</strong><p>{preferences.translationPrompt === DEFAULT_TRANSLATION_PROMPT ? '默认' : '已自定义'}</p></div>
          <button
            className="button secondary small settings-text-button"
            aria-label="编辑翻译提示词"
            aria-expanded={editingPrompt}
            aria-controls="translation-prompt-editor"
            onClick={() => { setEditingPrompt(!editingPrompt); setPromptStatus(''); setSaveError(''); }}
          >{editingPrompt ? '收起' : '编辑'}</button>
        </div>
        {editingPrompt && <div className="prompt-editor" id="translation-prompt-editor">
          <p className="section-description">保留 {'{{targetLang}}'}；可用 {'{{sourceLang}}'} 代表源语言。保存后生效。</p>
          <textarea
            aria-label="翻译提示词"
            aria-invalid={Boolean(promptError || saveError)}
            aria-describedby={promptError || saveError ? 'translation-prompt-error' : 'translation-prompt-count'}
            value={promptDraft}
            spellCheck={false}
            rows={10}
            onChange={(event) => { setPromptDraft(event.target.value); setPromptStatus(''); setSaveError(''); }}
          />
          <div className="prompt-editor-actions">
            <button className="button primary small" disabled={!promptChanged || Boolean(promptError)} onClick={savePrompt}>保存提示词</button>
            <button className="button secondary small" disabled={promptDraft === DEFAULT_TRANSLATION_PROMPT && preferences.translationPrompt === DEFAULT_TRANSLATION_PROMPT} onClick={restorePrompt}>恢复默认</button>
            <button className="text-button" onClick={() => { setPromptDraft(preferences.translationPrompt); setEditingPrompt(false); setPromptStatus(''); setSaveError(''); }}>取消</button>
            <span id="translation-prompt-count" className="prompt-editor-count">{promptDraft.length} / {MAX_PROMPT_LENGTH}</span>
          </div>
          {(promptError || saveError) && <p id="translation-prompt-error" className="prompt-editor-error" role="alert">{promptError || saveError}</p>}
        </div>}
        {promptStatus && <p className="prompt-editor-status" role="status">{promptStatus}</p>}
      </section>

      <button className="settings-navigation" aria-label="高级设置" onClick={() => setAdvanced(true)}>
        <span>高级设置</span><ChevronRight size={18} />
      </button>
    </>
  );
}
