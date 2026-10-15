import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, LoaderCircle, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Provider, ProviderKind } from '../types';
import { PROVIDER_PRESETS } from '../lib/catalog';
import { isMobile, isNative, isNativeMac, operatingSystem } from '../lib/platform';
import { validateEndpoint } from '../lib/translation';

export function ProviderPresets({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (provider: Provider) => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal preset-modal"
        role="dialog"
        aria-modal="true"
        aria-label="添加翻译服务"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>添加翻译服务</h2>
            <p>选择一个服务，或接入自己的 API。</p>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="preset-list">
          {PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.name}
              onClick={() => onChoose({ ...preset, id: crypto.randomUUID(), hasKey: false })}
            >
              <span className={`provider-avatar provider-${preset.kind}`}>{preset.name.slice(0, 1)}</span>
              <span>
                <strong>{preset.name}</strong>
                <small>
                  {preset.kind === 'openai'
                    ? 'OpenAI 兼容接口'
                    : preset.kind === 'anthropic'
                      ? 'Messages API'
                      : 'Generate Content API'}
                </small>
              </span>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

interface EditorProps {
  provider: Provider;
  existing: boolean;
  onClose: () => void;
  onSave: (provider: Provider, key: string, removeKey: boolean) => Promise<void>;
  onRemove: (provider: Provider) => Promise<void>;
}

export function ProviderEditor({ provider, existing, onClose, onSave, onRemove }: EditorProps) {
  const [draft, setDraft] = useState(provider);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      validateEndpoint(draft.baseUrl);
      if (!draft.name.trim() || !draft.model.trim()) throw new Error('请填写服务名称和模型。');
      await onSave(
        {
          ...draft,
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
          model: draft.model.trim(),
        },
        key,
        removeKey,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setSaving(true);
    try {
      await onRemove(provider);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, saving]);

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="modal provider-modal"
        role="dialog"
        aria-modal="true"
        aria-label="API 服务配置"
        onSubmit={(event) => {
          void submit(event);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{existing ? '编辑翻译服务' : '添加翻译服务'}</h2>
            <p>填写地址、模型和密钥即可开始。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭配置"
            onClick={onClose}
            disabled={saving}
          >
            <X size={20} />
          </button>
        </div>
        <label className="form-label">
          服务名称
          <input
            autoFocus={!isMobile}
            autoCapitalize="none"
            autoCorrect="off"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            maxLength={40}
            required
          />
        </label>
        <label className="form-label">
          接口类型
          <select
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as ProviderKind })}
          >
            <option value="openai">OpenAI 兼容接口</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label className="form-label">
          API 地址
          <input
            type="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
            required
          />
          <small>填写服务基础地址，应用会自动补全接口路径。</small>
        </label>
        <label className="form-label">
          模型名称
          <input
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            placeholder="填写服务支持的模型名称"
            required
          />
        </label>
        <label className="form-label">
          API Key{' '}
          <span className="optional-label">
            {provider.hasKey ? '已配置，留空保留原密钥' : '本地模型可留空'}
          </span>
          <div className="key-input">
            <input
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setRemoveKey(false);
              }}
              placeholder={provider.hasKey ? '输入新密钥以替换' : '粘贴你的 API Key'}
            />
            <button type="button" className="text-button" onClick={() => setShowKey(!showKey)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </label>
        {provider.hasKey && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={removeKey}
              onChange={(event) => setRemoveKey(event.target.checked)}
            />
            删除已保存的密钥
          </label>
        )}
        <div className="form-security">
          <ShieldCheck size={15} />
          <span>
            {isNative && operatingSystem === 'ios'
              ? 'iOS 钥匙串存储'
              : isNative && operatingSystem === 'android'
                ? 'Android 系统密钥库加密存储'
                : isNativeMac
              ? 'macOS 钥匙串存储'
              : isNative
                ? '系统保险库存储 · Android 仅本次会话'
                : '仅当前浏览器会话保存，刷新后需重新输入'}
          </span>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-footer">
          {existing && (
            <button
              className="text-button danger"
              type="button"
              onClick={() => {
                void remove();
              }}
              disabled={saving}
            >
              <Trash2 size={14} />
              {confirmDelete ? '确认移除' : '移除服务'}
            </button>
          )}
          <div>
            <button className="button secondary" type="button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存配置
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
