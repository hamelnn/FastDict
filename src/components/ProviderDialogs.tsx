import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, LoaderCircle, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Provider, ProviderKind } from '../types';
import { PROVIDER_PRESETS } from '../lib/catalog';
import { isMobile, isNative, isNativeMac, operatingSystem } from '../lib/platform';
import { validateEndpoint } from '../lib/translation';
import type { CodexStatus } from '../lib/codex';
import { acknowledgeChatGPTPlan, hasAcknowledgedChatGPTPlan } from '../lib/storage';
import { createId } from '../lib/id';
import { useDialogFocus } from '../hooks/useDialogFocus';

const desktopCodex = isNative && !isMobile;
const desktopOnly = 'ChatGPT 订阅翻译仅支持桌面应用，请在 Windows 或 macOS 版使用。';

function codexStatusMessage(status: CodexStatus): string {
  if (!status.available) return status.message || '当前版本暂不支持 ChatGPT 订阅登录。';
  if (!status.connected) return status.message || '尚未连接 ChatGPT，请先登录并授权。';
  if (!status.planEnabled) return status.message || '已登录 ChatGPT，但尚未授权 FastLingo 使用订阅。请选择重新授权。';
  if (!status.modelAvailable) return status.message || '已授权使用 ChatGPT 订阅，但可用模型目录中未找到所选模型。请确认模型名称后刷新。';
  return `已连接${status.accountLabel ? ` ${status.accountLabel}` : ' ChatGPT'}，已授权使用订阅，所选模型可用。`;
}

export function ProviderPresets({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (provider: Provider) => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>();
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
        ref={dialogRef}
        tabIndex={-1}
        className="modal preset-modal"
        role="dialog"
        aria-modal="true"
        aria-label="添加翻译服务"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>添加翻译服务</h2>
            <p>{desktopCodex ? '接入自己的 API，或登录 ChatGPT 使用订阅。' : '选择一个服务，或接入自己的 API。'}</p>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="preset-list">
          {PROVIDER_PRESETS.filter(preset => preset.kind !== 'codex' || desktopCodex).map((preset) => (
            <button
              key={preset.name}
              onClick={() => onChoose({ ...preset, id: createId(), hasKey: false })}
            >
              <span className={`provider-avatar provider-${preset.kind}`}>{preset.name.slice(0, 1)}</span>
              <span>
                <strong>{preset.name}</strong>
                <small>
                  {preset.kind === 'codex'
                    ? 'Sign in with ChatGPT'
                    : preset.kind === 'openai'
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
  onCodexStatus?: (provider: Provider, status: CodexStatus | null) => void;
}

export function ProviderEditor({ provider, existing, onClose, onSave, onRemove, onCodexStatus }: EditorProps) {
  const dialogRef = useDialogFocus<HTMLFormElement>(isMobile ? undefined : 'input');
  const [draft, setDraft] = useState(provider);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [cancellingSignIn, setCancellingSignIn] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [showPlanNotice, setShowPlanNotice] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [availableModels, setAvailableModels] = useState<NonNullable<CodexStatus['models']>>([]);
  const [availableProfiles, setAvailableProfiles] = useState<NonNullable<CodexStatus['profiles']>>([]);
  const checkRef = useRef(0);
  const signInRef = useRef(false);
  const signInPending = useRef<Promise<CodexStatus> | null>(null);
  const mountedRef = useRef(true);
  const previousSignInStatus = useRef<CodexStatus | null>(null);
  const codex = draft.kind === 'codex';
  const unsupportedCodex = codex && !desktopCodex;
  const applyStatus = (status: CodexStatus) => {
    setCodexStatus(status);
    setAvailableModels(status.models || []);
    setAvailableProfiles(status.profiles || []);
    onCodexStatus?.(draft, status);
  };
  const cancelSignIn = async () => {
    const request = ++checkRef.current;
    setChecking(false);
    if (signInRef.current) {
      signInRef.current = false;
      setCancellingSignIn(true);
      try {
        const { cancelChatGPTSignIn } = await import('../lib/codex');
        const status = await cancelChatGPTSignIn();
        // Let the account-change guard finish before enabling another sign-in.
        await signInPending.current?.catch(() => undefined);
        if (mountedRef.current && request === checkRef.current) applyStatus(status);
      } catch (cause) {
        if (mountedRef.current && request === checkRef.current) {
          setCodexStatus(null);
          onCodexStatus?.(draft, null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (mountedRef.current && request === checkRef.current) {
          setSigningIn(false);
          setCancellingSignIn(false);
        }
      }
    } else {
      setSigningIn(false);
    }
  };
  const closeEditor = async () => {
    await cancelSignIn();
    if (mountedRef.current) onClose();
  };
  useEffect(() => { mountedRef.current = true; return () => {
    mountedRef.current = false;
    ++checkRef.current;
    if (signInRef.current) {
      signInRef.current = false;
      void import('../lib/codex').then(({ cancelChatGPTSignIn }) => cancelChatGPTSignIn()).catch(() => undefined);
    }
  }; }, []);
  const checkCodex = async () => {
    const request = ++checkRef.current;
    setChecking(true);
    setError('');
    setCodexStatus(null);
    onCodexStatus?.(draft, null);
    try {
      if (!draft.model.trim()) throw new Error('请填写模型名称。');
      const { getCodexStatus } = await import('../lib/codex');
      const status = await getCodexStatus(draft.model.trim());
      if (request !== checkRef.current) return;
      setCodexStatus(status);
      setAvailableModels(status.models || []);
      setAvailableProfiles(status.profiles || []);
      onCodexStatus?.(draft, status);
    } catch (cause) {
      if (request === checkRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === checkRef.current) setChecking(false);
    }
  };
  const signIn = async (newAccount = false) => {
    let committed = false;
    const request = ++checkRef.current;
    setSigningIn(true);
    signInRef.current = true;
    previousSignInStatus.current = codexStatus;
    setError('');
    setCodexStatus(null);
    setAvailableModels([]);
    onCodexStatus?.(draft, null);
    try {
      if (!draft.model.trim()) throw new Error('请填写模型名称。');
      const { signInChatGPT, getCodexStatus } = await import('../lib/codex');
      if (request !== checkRef.current) return;
      const pending = signInChatGPT(draft.model.trim(), newAccount);
      signInPending.current = pending;
      const status = await pending;
      if (request !== checkRef.current) return;
      committed = true;
      signInRef.current = false;
      setSigningIn(false);
      applyStatus(status);
      if (status.connected && status.planEnabled && !hasAcknowledgedChatGPTPlan()) setShowPlanNotice(true);
      // Signing in is already complete. Catalog latency must never leave a
      // committed connection behind a misleading "cancel sign-in" action.
      if (status.connected && status.planEnabled) {
        setChecking(true);
        const catalog = await getCodexStatus(draft.model.trim());
        if (request === checkRef.current) applyStatus(catalog);
      }
    } catch (cause) {
      if (request === checkRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (!committed) {
          setCodexStatus(previousSignInStatus.current);
          setAvailableModels(previousSignInStatus.current?.models || []);
          setAvailableProfiles(previousSignInStatus.current?.profiles || []);
          onCodexStatus?.(draft, previousSignInStatus.current);
        }
      }
    } finally {
      if (request === checkRef.current) {
        signInRef.current = false;
        setSigningIn(false);
        setChecking(false);
      }
    }
  };
  const forgetProfile = async () => {
    const profile = availableProfiles.find(item => item.active);
    if (!profile) return;
    if (!confirmForget) { setConfirmForget(true); return; }
    const request = ++checkRef.current;
    setChecking(true); setError('');
    onCodexStatus?.(draft, null);
    try {
      const { forgetChatGPTProfile } = await import('../lib/codex');
      const status = await forgetChatGPTProfile(profile.id, draft.model.trim());
      if (request === checkRef.current) { applyStatus(status); setConfirmForget(false); }
    } catch (cause) {
      if (request === checkRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === checkRef.current) setChecking(false);
    }
  };
  const selectProfile = async (profileId: string) => {
    setConfirmForget(false);
    const request = ++checkRef.current;
    const previous = codexStatus;
    setChecking(true);
    setError('');
    onCodexStatus?.(draft, null);
    try {
      const { selectChatGPTProfile } = await import('../lib/codex');
      if (request !== checkRef.current) return;
      const status = await selectChatGPTProfile(profileId, draft.model.trim());
      if (request !== checkRef.current) return;
      setCodexStatus(status);
      setAvailableModels(status.models || []);
      setAvailableProfiles(status.profiles || []);
      onCodexStatus?.(draft, status);
    } catch (cause) {
      if (request === checkRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        onCodexStatus?.(draft, previous);
      }
    } finally {
      if (request === checkRef.current) setChecking(false);
    }
  };
  const disconnect = async () => {
    const request = ++checkRef.current;
    setChecking(true);
    setError('');
    onCodexStatus?.(draft, null);
    try {
      const { disconnectChatGPT } = await import('../lib/codex');
      const status = await disconnectChatGPT();
      if (request !== checkRef.current) return;
      setCodexStatus(status);
      setAvailableModels([]);
      setAvailableProfiles(status.profiles || []);
      onCodexStatus?.(draft, status);
    } catch (cause) {
      if (request === checkRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === checkRef.current) setChecking(false);
    }
  };
  const openUsage = async () => {
    try {
      const { openChatGPTUsage } = await import('../lib/codex');
      await openChatGPTUsage();
    } catch { setError('无法打开 ChatGPT 用量设置，请稍后重试。'); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (unsupportedCodex) throw new Error(desktopOnly);
      if (!codex) validateEndpoint(draft.baseUrl);
      if (!draft.name.trim() || !draft.model.trim()) throw new Error('请填写服务名称和模型。');
      await onSave(
        {
          ...draft,
          name: draft.name.trim(),
          baseUrl: codex ? '' : draft.baseUrl.trim().replace(/\/+$/, ''),
          model: draft.model.trim(),
        },
        codex ? '' : key,
        codex ? false : removeKey,
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
      if (event.key === 'Escape' && !saving && !cancellingSignIn) void closeEditor();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, saving, cancellingSignIn]);

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!saving && !cancellingSignIn) void closeEditor();
      }}
    >
      <form
        ref={dialogRef}
        tabIndex={-1}
        className="modal provider-modal"
        role="dialog"
        aria-modal="true"
        aria-label={codex ? 'ChatGPT 订阅配置' : 'API 服务配置'}
        onSubmit={(event) => {
          void submit(event);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{existing ? '编辑翻译服务' : '添加翻译服务'}</h2>
            <p>{codex ? '通过官方登录授权使用你的 ChatGPT 订阅。' : '填写地址、模型和密钥即可开始。'}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭配置"
            onClick={() => { void closeEditor(); }}
            disabled={saving || cancellingSignIn}
          >
            <X size={20} />
          </button>
        </div>
        <label className="form-label">
          服务名称
          <input
            autoCapitalize="none"
            autoCorrect="off"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            maxLength={40}
            required
          />
        </label>
        {!codex && <><label className="form-label">
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
        </label></>}
        <label className="form-label">
          模型名称
          <input
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={draft.model}
            disabled={signingIn || cancellingSignIn}
            list={codex ? 'chatgpt-available-models' : undefined}
            onChange={(event) => {
              const next = { ...draft, model: event.target.value };
              setDraft(next);
              if (codex) {
                void cancelSignIn();
                setCodexStatus(null);
                setShowPlanNotice(false);
                setError('');
                onCodexStatus?.(next, null);
              }
            }}
            placeholder="填写服务支持的模型名称"
            required
          />
          {codex && availableModels.length > 0 && <datalist id="chatgpt-available-models">
            {availableModels.map(model => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
          </datalist>}
        </label>
        {codex ? (
          <section className="codex-connection" aria-label="ChatGPT 连接" aria-busy={checking || signingIn}>
            <p>{unsupportedCodex ? desktopOnly : '符合条件的翻译请求将使用你的 ChatGPT 套餐或积分余额。无需 API Key，也无需安装 Codex。'}</p>
            {availableProfiles.length > 0 && <label className="form-label">
              ChatGPT 账号
              <select aria-label="ChatGPT 账号" value={availableProfiles.find(profile => profile.active)?.id || ''} disabled={checking || signingIn || saving || unsupportedCodex} onChange={event => { void selectProfile(event.target.value); }}>
                {!availableProfiles.some(profile => profile.active) && <option value="" disabled>选择账号</option>}
                {availableProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.connected ? '' : '（需重新登录）'}</option>)}
              </select>
            </label>}
            {signingIn ? <div className="chatgpt-actions">
              <span role="status"><LoaderCircle size={15} className="spin" /> 请在系统浏览器中完成 ChatGPT 登录和授权…</span>
              <button className="button secondary small" type="button" disabled={cancellingSignIn} onClick={() => { void cancelSignIn(); }}>{cancellingSignIn ? '正在确认连接' : '取消登录'}</button>
            </div> : <div className="chatgpt-actions">
              {!codexStatus?.connected && <button className="button chatgpt-sign-in" type="button" disabled={checking || saving || unsupportedCodex} onClick={() => { void signIn(); }}>Continue with ChatGPT</button>}
              <button className="button secondary small" type="button" disabled={checking || saving || unsupportedCodex} onClick={() => { void checkCodex(); }}>
                {checking && <LoaderCircle size={15} className="spin" />}{checking ? '正在刷新' : '刷新连接'}
              </button>
              {codexStatus?.connected && <>
                <button className="button secondary small" type="button" disabled={checking || saving} onClick={() => { void signIn(); }}>重新授权</button>
                <button className="text-button danger" type="button" disabled={checking || saving} onClick={() => { void disconnect(); }}>断开连接</button>
              </>}
              {availableProfiles.length > 0 && <button className="text-button" type="button" disabled={checking || saving} onClick={() => { void signIn(true); }}>添加账号</button>}
              {availableProfiles.length > 0 && <button className="text-button danger" type="button" disabled={checking || saving || !availableProfiles.some(profile => profile.active)} onClick={() => { void forgetProfile(); }}>{confirmForget ? '确认忘记此连接' : '忘记此连接'}</button>}
              {!unsupportedCodex && <button className="text-button" type="button" onClick={() => { void openUsage(); }}>管理用量</button>}
            </div>}
            {codexStatus && <p className="codex-status" role="status">{codexStatusMessage(codexStatus)}</p>}
            {confirmForget && <small>将撤销此连接的登录并移除本机注册记录；以后使用需要重新授权，其他账号会保留。</small>}
            {!unsupportedCodex && <small>刷新仅检查连接、授权和可用模型，不发送翻译请求。译文会逐步显示。</small>}
            {showPlanNotice && <div className="chatgpt-plan-notice" role="alertdialog" aria-modal="true" aria-label="正在使用 ChatGPT 套餐">
              <strong>正在使用 ChatGPT 套餐</strong>
              <p>FastLingo 中符合条件的翻译请求会使用你的 ChatGPT 套餐或积分余额。你可以随时在 ChatGPT 设置中管理用量。</p>
              <div className="chatgpt-actions">
                <button className="text-button" type="button" onClick={() => { void openUsage(); }}>管理用量</button>
                <button className="button primary small" type="button" onClick={() => { acknowledgeChatGPTPlan(); setShowPlanNotice(false); }}>知道了</button>
              </div>
            </div>}
          </section>
        ) : <><label className="form-label">
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
                ? operatingSystem === 'windows' ? 'Windows 系统凭据库存储' : '仅本次应用会话保存'
                : '仅当前浏览器会话保存，刷新后需重新输入'}
          </span>
        </div></>}
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
            <button className="button secondary" type="button" onClick={() => { void closeEditor(); }} disabled={saving || cancellingSignIn}>
              取消
            </button>
            <button className="button primary" type="submit" disabled={saving || checking || signingIn || showPlanNotice || unsupportedCodex}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存配置
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
