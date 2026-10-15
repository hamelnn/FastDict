import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Copy,
  Expand,
  History,
  ImagePlus,
  Languages,
  LoaderCircle,
  Menu,
  Minus,
  Monitor,
  Plus,
  ScanLine,
  Settings2,
  Share2,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import type { HistoryItem, Preferences, Provider, Screenshot } from './types';
import { isKeylessProvider, translate } from './lib/translation';
import { recognizeImage, warmOcr } from './lib/ocr';
import {
  captureDisplay,
  expandWindow,
  getShortcutStatus,
  hideWindow,
  isMobile as MOBILE,
  isNative,
  isNativeMac,
  listenInputs,
  operatingSystem,
  pickMobileImage,
  readClipboard,
  shortcutLabels,
  shareText,
  startCapture,
  writeClipboard,
} from './lib/platform';
import {
  addHistory,
  clearHistory,
  deleteApiKey,
  getApiKey,
  getStorageWarnings,
  loadHistory,
  loadPreferences,
  loadProviders,
  saveApiKey,
  savePreferences,
  saveProviders,
} from './lib/storage';
import { ImageCropper } from './components/CaptureOverlay';
import { quitApplication, reportBootStage } from './BootErrorBoundary';
import { useMacScreenPermission } from './components/MacScreenPermission';
import { LANGUAGES, OCR_LANGUAGES } from './lib/catalog';
import { HistoryView } from './components/HistoryView';
import { PreferencesView } from './components/PreferencesView';
import { ProviderEditor, ProviderPresets } from './components/ProviderDialogs';
import { MobileNavigation } from './components/MobileNavigation';

type Phase = 'idle' | 'capturing' | 'ocr' | 'translating' | 'error';
type View = 'translate' | 'history' | 'settings';
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const SAMPLE = 'The real voyage of discovery consists not in seeking new landscapes, but in having new eyes.';

export default function App() {
  const macPermission = useMacScreenPermission();
  const [providers, setProviders] = useState(loadProviders);
  const [preferences, setPreferences] = useState(loadPreferences);
  const [history, setHistory] = useState(loadHistory);
  const [storageWarning, setStorageWarning] = useState(() => getStorageWarnings().join(' '));
  const [view, setView] = useState<View>('translate');
  const [text, setText] = useState('');
  const [output, setOutput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrMessage, setOcrMessage] = useState('');
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [crop, setCrop] = useState<Screenshot | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [firstToken, setFirstToken] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [windowMode, setWindowMode] = useState<'sidebar' | 'expanded'>('expanded');
  const [ocrReady, setOcrReady] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const jobRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const savedPreferencesRef = useRef(preferences);
  const savedProvidersRef = useRef(providers);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const active = providers.find((p) => p.id === preferences.activeProviderId) || providers[0];
  const busy = ['capturing', 'ocr', 'translating'].includes(phase);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!MOBILE) return;
    const viewport = window.visualViewport;
    let fullHeight = window.innerHeight;
    let fullWidth = window.innerWidth;
    const updateViewport = () => {
      if (Math.abs(window.innerWidth - fullWidth) > 80) {
        fullWidth = window.innerWidth;
        fullHeight = window.innerHeight;
      }
      fullHeight = Math.max(fullHeight, window.innerHeight);
      const height = viewport?.height ?? window.innerHeight;
      const editable = document.activeElement?.matches('input, textarea, select');
      setKeyboardOpen(Boolean(editable && fullHeight - height > 150));
      document.documentElement.style.setProperty('--mobile-visible-height', `${height}px`);
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    viewport?.addEventListener('resize', updateViewport);
    document.addEventListener('focusout', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('resize', updateViewport);
      document.removeEventListener('focusout', updateViewport);
      document.documentElement.style.removeProperty('--mobile-visible-height');
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (storageWarning) reportBootStage('storage-read-failed');
  }, []);
  useEffect(() => {
    if (savedPreferencesRef.current === preferences) return;
    try {
      savePreferences(preferences);
      savedPreferencesRef.current = preferences;
    } catch {
      setStorageWarning('偏好设置暂时无法保存，当前界面仍可使用。原有数据已保留。');
      reportBootStage('storage-write-failed');
    }
  }, [preferences]);
  useEffect(() => {
    if (savedProvidersRef.current === providers) return;
    try {
      saveProviders(providers);
      savedProvidersRef.current = providers;
    } catch {
      setStorageWarning('API 配置暂时无法保存，当前界面仍可使用。原有配置与密钥未被清除。');
      reportBootStage('storage-write-failed');
    }
  }, [providers]);
  useEffect(() => {
    if (!isNative || MOBILE) return;
    let disposed = false;
    setOcrReady(false);
    const timer = window.setTimeout(() => {
      if (phaseRef.current !== 'idle') return;
      void warmOcr(preferences.ocrLang)
        .then(() => {
          if (!disposed) setOcrReady(true);
        })
        .catch(() => {
          if (!disposed) {
            setOcrReady(false);
            setError('本地识别引擎预热失败，截图时会重新尝试加载。');
          }
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [preferences.ocrLang]);
  useEffect(() => {
    if (!isNative) return;
    let disposed = false;
    void Promise.all(
      providers.map(async (provider) => ({ id: provider.id, hasKey: Boolean(await getApiKey(provider.id)) })),
    )
      .then((keys) => {
        if (disposed || providersRef.current !== providers) return;
        const refreshed = providers.map((provider) => {
          const key = keys.find((item) => item.id === provider.id);
          return key && key.hasKey !== provider.hasKey ? { ...provider, hasKey: key.hasKey } : provider;
        });
        if (refreshed.every((provider, index) => provider === providers[index])) return;
        // Vault hydration changes a connection indicator, not the saved configuration.
        savedProvidersRef.current = refreshed;
        setProviders((current) => (current === providers ? refreshed : current));
      })
      .catch(() => {
        if (!disposed) setError('暂时无法读取系统保险库中的密钥，请检查系统权限后重试。');
      });
    return () => {
      disposed = true;
    };
  }, []);
  const stop = useCallback(() => {
    ++jobRef.current;
    abortRef.current?.abort();
    setPhase('idle');
    setError('');
  }, []);
  useEffect(() => {
    if (!MOBILE) return;
    let paused = false;
    const onVisibility = () => {
      if (document.hidden && ['ocr', 'translating'].includes(phaseRef.current)) {
        stop();
        paused = true;
      } else if (!document.hidden && paused) {
        paused = false;
        notify('已停止后台任务，可重新识别或翻译。');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stop, notify]);
  const updatePreferences = (patch: Partial<Preferences>) => {
    if (patch.sourceLang || patch.targetLang || patch.activeProviderId || patch.ocrLang) stop();
    setPreferences((p) => ({ ...p, ...patch }));
  };

  const runTranslation = useCallback(
    async (source: string, input: HistoryItem['input'] = 'text') => {
      if (!source.trim()) {
        sourceRef.current?.focus();
        return;
      }
      abortRef.current?.abort();
      const job = ++jobRef.current,
        controller = new AbortController();
      abortRef.current = controller;
      setError('');
      setOutput('');
      setDuration(null);
      setFirstToken(null);
      setView('translate');
      setPhase('translating');
      const started = performance.now();
      let tokenSeen = false;
      try {
        if (!active) throw new Error('请先添加一个翻译 API。');
        const apiKey = await getApiKey(active.id);
        if (job !== jobRef.current) return;
        if (!apiKey && !isKeylessProvider(active)) {
          setEditing(active);
          throw new Error('请为当前服务填写 API Key，然后开始翻译。');
        }
        setPhase('translating');
        const result = await translate({
          provider: active,
          apiKey: apiKey || '',
          text: source,
          sourceLang: preferences.sourceLang,
          targetLang: preferences.targetLang,
          signal: controller.signal,
          onDelta: (delta) => {
            if (job !== jobRef.current) return;
            if (!tokenSeen) {
              tokenSeen = true;
              setFirstToken(performance.now() - started);
            }
            setOutput((current) => current + delta);
          },
        });
        if (job !== jobRef.current) return;
        if (!result.trim()) throw new Error('API 未返回翻译文本，请检查模型名称或重试。');
        setOutput(result);
        const elapsed = performance.now() - started;
        setDuration(elapsed);
        setPhase('idle');
        try {
          setHistory(
            addHistory({
              id: crypto.randomUUID(),
              source,
              translation: result,
              sourceLang: preferences.sourceLang,
              targetLang: preferences.targetLang,
              providerName: active.name,
              createdAt: Date.now(),
              durationMs: elapsed,
              input,
            }),
          );
        } catch {
          setStorageWarning('译文已完成，但本地翻译记录暂时无法保存。原有记录已保留。');
          reportBootStage('storage-write-failed');
        }
      } catch (e) {
        if (job !== jobRef.current || controller.signal.aborted) return;
        setError(errorMessage(e));
        setPhase('error');
      }
    },
    [active, preferences.sourceLang, preferences.targetLang],
  );

  const handleImage = useCallback(
    async (dataUrl: string, captureInput = false) => {
      abortRef.current?.abort();
      const job = ++jobRef.current,
        controller = new AbortController();
      abortRef.current = controller;
      setView('translate');
      setImage(dataUrl);
      setText('');
      setOutput('');
      setError('');
      setDuration(null);
      setFirstToken(null);
      setOcrConfidence(null);
      setOcrProgress(0);
      setOcrMessage('正在准备本地识别引擎');
      setPhase('ocr');
      try {
        const result = await recognizeImage(
          dataUrl,
          preferences.ocrLang,
          (progress, status) => {
            if (job === jobRef.current) {
              setOcrProgress(progress);
              setOcrMessage(
                status === 'recognizing text'
                  ? '正在识别文字'
                  : status.startsWith('loading')
                    ? '正在加载本地识别模型'
                    : status.startsWith('initializing')
                      ? '正在初始化识别引擎'
                      : '正在准备文字识别',
              );
            }
          },
          controller.signal,
        );
        if (job !== jobRef.current) return;
        if (!result.text.trim()) throw new Error('未识别到文字，请选择更清晰的区域，或更换识别语言。');
        setText(result.text.trim());
        setOcrConfidence(result.confidence);
        setOcrReady(true);
        setPhase('idle');
        // A screenshot shortcut explicitly requests immediate translation.
        if (captureInput || preferences.autoTranslate) await runTranslation(result.text.trim(), 'image');
      } catch (e) {
        if (job !== jobRef.current || controller.signal.aborted) return;
        setError(errorMessage(e));
        setPhase('error');
      }
    },
    [preferences.ocrLang, preferences.autoTranslate, runTranslation],
  );

  const handleClipboard = useCallback(
    async (provided?: string) => {
      stop();
      const job = jobRef.current;
      try {
        const content = provided ?? (await readClipboard());
        if (job !== jobRef.current) return;
        if (!content.trim()) throw new Error('剪贴板中没有文字，请先复制内容。');
        setText(content);
        setImage(null);
        setOcrConfidence(null);
        setOutput('');
        setDuration(null);
        setView('translate');
        setMenuOpen(false);
        if (preferences.autoTranslate) await runTranslation(content, 'clipboard');
      } catch (e) {
        if (job !== jobRef.current) return;
        setError(errorMessage(e));
        setPhase('error');
      }
    },
    [stop, preferences.autoTranslate, runTranslation],
  );

  const inputHandlersRef = useRef({ handleClipboard, handleImage });
  inputHandlersRef.current = { handleClipboard, handleImage };
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listenInputs({
      onClipboard: (content) => {
        void inputHandlersRef.current.handleClipboard(content);
      },
      onImage: (screenshot) => {
        void inputHandlersRef.current.handleImage(screenshot.dataUrl, true);
      },
      onMode: (mode) => {
        setWindowMode(mode);
        if (mode === 'sidebar' && phaseRef.current === 'capturing') setPhase('idle');
      },
      onNavigate: (view) => {
        setView(view);
        setMenuOpen(false);
        if (isNativeMac) void macPermission.check().catch(() => undefined);
      },
      onError: (message) => {
        ++jobRef.current;
        abortRef.current?.abort();
        setError(message);
        setPhase('error');
        if (isNativeMac)
          void macPermission
            .check()
            .then((permission) => {
              if (!permission.granted) setView('settings');
            })
            .catch(() => undefined);
      },
    })
      .then(async (fn) => {
        if (disposed) {
          fn();
          return;
        }
        cleanup = fn;
        if (isNative && !MOBILE) {
          const { invoke } = await import('@tauri-apps/api/core');
          if (!disposed) await invoke('frontend_ready');
        }
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    void getShortcutStatus()
      .then((status) => {
        if (!disposed && status?.error) setError(status.error);
      })
      .catch(() => {
        if (!disposed) setError('无法读取桌面快捷键状态，请重新启动应用后重试。');
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      ++jobRef.current;
    },
    [],
  );

  const capture = useCallback(async () => {
    if (MOBILE) {
      if (!isNative) {
        fileRef.current?.click();
        return;
      }
      stop();
      const job = jobRef.current;
      setPhase('capturing');
      try {
        const selected = await pickMobileImage();
        if (job !== jobRef.current) return;
        setPhase('idle');
        if (selected) await handleImage(selected.dataUrl);
      } catch (cause) {
        if (job !== jobRef.current) return;
        setError(errorMessage(cause));
        setPhase('error');
      }
      return;
    }
    if (!isNative) {
      notify('桌面截图快捷键请在轻译桌面应用中使用。网页可通过“浏览器截图体验”试用。');
      return;
    }
    stop();
    const job = jobRef.current;
    setError('');
    setMenuOpen(false);
    try {
      if (isNativeMac) {
        const permission = await macPermission.check();
        if (job !== jobRef.current) return;
        if (!permission.granted) {
          setView('settings');
          notify('请先开启 macOS 屏幕录制权限。');
          return;
        }
      }
      setView('translate');
      setPhase('capturing');
      await startCapture();
    } catch (e) {
      if (job !== jobRef.current) return;
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setError(errorMessage(e));
      setPhase('error');
    }
  }, [stop, notify, macPermission.check, handleImage]);
  const capturePreview = useCallback(async () => {
    stop();
    const job = jobRef.current;
    setError('');
    setMenuOpen(false);
    setPhase('capturing');
    try {
      const screenshot = await captureDisplay();
      if (job !== jobRef.current) return;
      setCrop(screenshot);
      setPhase('idle');
    } catch (e) {
      if (job !== jobRef.current) return;
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setError(errorMessage(e));
      setPhase('error');
    }
  }, [stop]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        void runTranslation(text);
      }
      if (!isNative && modifier && event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        void capture();
      }
      if (!isNative && modifier && event.shiftKey && event.code === 'KeyD') {
        event.preventDefault();
        void handleClipboard();
      }
      if (event.key === 'Escape' && busy) stop();
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [runTranslation, text, capture, handleClipboard, busy, stop]);

  const importFile = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notify('请选择 PNG、JPEG 或 WebP 图片');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      notify('图片超过 25 MB，请先裁剪或压缩');
      return;
    }
    stop();
    const job = jobRef.current;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('图片读取失败'));
        reader.readAsDataURL(file);
      });
      if (job !== jobRef.current) return;
      await handleImage(dataUrl);
    } catch (e) {
      if (job !== jobRef.current) return;
      setError(errorMessage(e));
      setPhase('error');
    }
  };
  const saveProvider = async (provider: Provider, key: string, removeKey: boolean) => {
    if (removeKey) await deleteApiKey(provider.id);
    else if (key.trim()) await saveApiKey(provider.id, key.trim());
    const saved = { ...provider, hasKey: removeKey ? false : Boolean(key.trim() || provider.hasKey) };
    setProviders((current) =>
      current.some((p) => p.id === saved.id)
        ? current.map((p) => (p.id === saved.id ? saved : p))
        : [...current, saved],
    );
    updatePreferences({ activeProviderId: saved.id });
    setEditing(null);
    setShowPresets(false);
    notify('API 配置已保存');
  };
  const removeProvider = async (provider: Provider) => {
    try {
      await deleteApiKey(provider.id);
      setProviders((current) => current.filter((p) => p.id !== provider.id));
      setEditing(null);
      notify('API 配置已移除');
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const copyOutput = async () => {
    try {
      await writeClipboard(output);
      notify('译文已复制');
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const chooseView = (next: View) => {
    setView(next);
    setMenuOpen(false);
    if (MOBILE) window.scrollTo({ top: 0 });
  };
  const readyCount = providers.filter((provider) => provider.hasKey || isKeylessProvider(provider)).length;

  return (
    <div
      className={`app-shell ${windowMode === 'sidebar' ? 'sidebar-mode' : ''} ${isNativeMac ? 'native-macos' : ''} ${MOBILE ? 'mobile-app' : ''} ${keyboardOpen ? 'keyboard-open' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void importFile(event.dataTransfer.files[0]);
      }}
    >
      {!MOBILE && <aside className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            chooseView('translate');
          }}
          aria-label="轻译首页"
        >
          <span className="brand-mark">
            <Languages size={23} strokeWidth={1.8} />
          </span>
          <span>
            <strong>
              轻译<span className="brand-dot">.</span>
            </strong>
            <small>{isNativeMac ? 'FASTDICT FOR MAC' : 'FASTDICT'}</small>
          </span>
        </a>
        <div className="sidebar-caption">工作空间</div>
        <nav className="navigation">
          <button className={view === 'translate' ? 'selected' : ''} onClick={() => chooseView('translate')}>
            <Languages size={18} />
            <span>即时翻译</span>
            <ChevronRight size={15} />
          </button>
          <button className={view === 'history' ? 'selected' : ''} onClick={() => chooseView('history')}>
            <History size={18} />
            <span>翻译记录</span>
            {history.length > 0 && <span className="count">{history.length}</span>}
          </button>
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-caption provider-caption">
          <span>翻译服务</span>
          <button
            className="icon-button"
            title="添加 API"
            aria-label="添加 API"
            onClick={() => {
              setShowPresets(true);
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="provider-list">
          {providers.map((provider, index) => (
            <button
              key={provider.id}
              className={`provider-row ${active?.id === provider.id ? 'active' : ''}`}
              onClick={() => updatePreferences({ activeProviderId: provider.id })}
            >
              <span className={`provider-avatar provider-${provider.kind}`}>
                {provider.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="provider-copy">
                <strong>{provider.name}</strong>
                <small>{provider.model || '未设置模型'}</small>
              </span>
              {active?.id === provider.id ? (
                <Check className="provider-check" size={15} />
              ) : (
                <span className={`connection-dot ${provider.hasKey ? 'connected' : ''}`} />
              )}
              <span className="sr-only">服务 {index + 1}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`settings-nav ${view === 'settings' ? 'selected' : ''}`}
            onClick={() => chooseView('settings')}
          >
            <Settings2 size={18} />
            <span>偏好设置</span>
          </button>
        </div>
      </aside>}
      {!MOBILE && menuOpen && (
        <button className="mobile-backdrop" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />
      )}
      <main className="main">
        {storageWarning && (
          <div className="storage-warning" role="alert">
            <span>{storageWarning}</span>
            <button className="text-button" onClick={() => setStorageWarning('')}>
              关闭提示
            </button>
          </div>
        )}
        {MOBILE ? (
          <header className="mobile-header">
            <a className="mobile-brand" href="#" aria-label="轻译首页" onClick={(event) => {
              event.preventDefault();
              chooseView('translate');
            }}>
              <span className="brand-mark"><Languages size={22} strokeWidth={1.8} /></span>
              <span><strong>轻译<span className="brand-dot">.</span></strong><small>FASTDICT · {operatingSystem === 'ios' ? 'iOS' : 'ANDROID'}</small></span>
            </a>
            <span className="availability"><span className={readyCount ? 'status-dot' : 'status-dot unconfigured'} />{readyCount ? '已就绪' : '待配置 API'}</span>
          </header>
        ) : <header className="topbar" data-tauri-drag-region>
          <div className="breadcrumbs" data-tauri-drag-region>
            <button
              className="icon-button menu-toggle"
              aria-label="打开菜单"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong data-tauri-drag-region>
              {view === 'translate' ? '即时翻译' : view === 'history' ? '翻译记录' : '偏好设置'}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="availability">
              <span className={readyCount ? 'status-dot' : 'status-dot unconfigured'} />
              {readyCount ? '随时就绪' : '等待连接 API'}
            </span>
            {isNative && (
              <button
                className="icon-button"
                title="展开工作空间"
                aria-label="展开工作空间"
                onClick={() => {
                  void expandWindow().catch((e) => notify(errorMessage(e)));
                }}
              >
                <Expand size={16} />
              </button>
            )}
            <button
              className="icon-button"
              title="查看使用指南"
              aria-label="使用指南"
              onClick={() => {
                chooseView('settings');
                requestAnimationFrame(() => {
                  document.getElementById('quickstart')?.scrollIntoView({ behavior: 'smooth' });
                });
              }}
            >
              <CircleHelp size={18} />
            </button>
            {isNative && !MOBILE && (
              <button
                className="icon-button"
                title={isNativeMac ? '隐藏到菜单栏' : '最小化到托盘'}
                aria-label={isNativeMac ? '隐藏到菜单栏' : '最小化到托盘'}
                onClick={() => {
                  void hideWindow().catch((e) => notify(errorMessage(e)));
                }}
              >
                <Minus size={17} />
              </button>
            )}
          </div>
        </header>}
        <div className={`workspace ${view === 'translate' ? 'translation-workspace' : ''}`}>
          {isNativeMac &&
            view === 'translate' &&
            macPermission.permission &&
            !macPermission.permission.granted && (
              <div className="mac-permission-notice">
                <ShieldCheck size={17} />
                <span>开启屏幕录制权限，即可使用 ⌥⌘S 框选翻译。</span>
                <button className="text-button" onClick={() => chooseView('settings')}>
                  设置录屏权限
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
          {!isNative && !MOBILE && (
            <div className="preview-notice">
              <Monitor size={16} />
              <span>
                <strong>当前是网页预览</strong>桌面快捷键与直接框选请打开轻译桌面应用。
              </span>
              <button
                className="text-button"
                onClick={() => {
                  void capturePreview();
                }}
                disabled={phase === 'capturing'}
              >
                浏览器截图体验
                <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {view === 'translate' && (
            <>
              <div className="intro">
                <div>
                  <h1>{MOBILE ? '看懂眼前的文字' : '即时翻译'}</h1>
                  <p>{MOBILE ? '选一张截图，或粘贴一段文字。' : '截图、粘贴或导入图片，译文即时呈现。'}</p>
                </div>
              </div>
              <div className="capture-bar">
                <div className="capture-buttons">
                  <button
                    className="button primary capture-button"
                    onClick={() => {
                      void capture();
                    }}
                    disabled={phase === 'capturing'}
                  >
                    <ScanLine size={17} />
                    <span>{MOBILE ? '选取截图' : isNative ? '截图翻译' : '桌面截图翻译'}</span>
                    {!MOBILE && <kbd>{shortcutLabels.capture}</kbd>}
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      void handleClipboard();
                    }}
                  >
                    <Clipboard size={16} />
                    <span>粘贴文本</span>
                    {isNativeMac && <kbd>{shortcutLabels.clipboard}</kbd>}
                  </button>
                  {!MOBILE && <button className="button subtle" onClick={() => fileRef.current?.click()}>
                    <ImagePlus size={17} />
                    <span>导入图片</span>
                  </button>}
                </div>
                <span className="capture-hint">
                  <Zap size={13} />
                  {isNative && !MOBILE
                    ? ocrReady
                      ? '本机识别已就绪 · 松开即翻译'
                      : '框选后立即翻译'
                    : preferences.autoTranslate
                      ? '导入后自动翻译'
                      : '导入后手动翻译'}
                </span>
              </div>
              <div className="translator">
                <div className="language-bar">
                  <div className="language-select">
                    <span className="language-caption">从</span>
                    <select
                      aria-label="源语言"
                      value={preferences.sourceLang}
                      onChange={(event) => updatePreferences({ sourceLang: event.target.value })}
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <button
                    className="swap-button"
                    aria-label="交换翻译方向"
                    title="交换翻译方向"
                    onClick={() => {
                      if (preferences.sourceLang === 'auto') {
                        notify('请先选择源语言再交换');
                        return;
                      }
                      stop();
                      updatePreferences({
                        sourceLang: preferences.targetLang,
                        targetLang: preferences.sourceLang,
                      });
                      if (output) {
                        setText(output);
                        setOutput('');
                      }
                    }}
                  >
                    <ArrowLeftRight size={17} />
                  </button>
                  <div className="language-select target-language">
                    <span className="language-caption">到</span>
                    <select
                      aria-label="目标语言"
                      value={preferences.targetLang}
                      onChange={(event) => updatePreferences({ targetLang: event.target.value })}
                    >
                      {LANGUAGES.filter((l) => l.code !== 'auto').map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <span className="model-label">
                    <span /> {active?.model || '未选择服务'}
                  </span>
                </div>
                <div className="translation-panels">
                  <section className="source-panel">
                    <div className="panel-label">
                      <span>原文</span>
                      <div>
                        {image && (
                          <span className="image-label">
                            <ImagePlus size={12} />
                            图片识别
                          </span>
                        )}
                        {text && (
                          <button
                            className="icon-button"
                            aria-label="清空原文"
                            title="清空"
                            onClick={() => {
                              stop();
                              setText('');
                              setOutput('');
                              setImage(null);
                              setDuration(null);
                              setOcrConfidence(null);
                            }}
                          >
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                    {image && (
                      <div className="image-preview">
                        <img src={image} alt="识别图片" />
                        <span>
                          {phase === 'ocr'
                            ? '本地 OCR 识别中'
                            : ocrConfidence !== null
                              ? `识别置信度 ${Math.round(ocrConfidence)}%`
                              : '已取消识别'}
                          <small>{OCR_LANGUAGES.find((l) => l.value === preferences.ocrLang)?.label}</small>
                        </span>
                        <button
                          className="icon-button"
                          title="重新识别"
                          aria-label="重新识别图片"
                          onClick={() => {
                            void handleImage(image);
                          }}
                        >
                          <ScanLine size={16} />
                        </button>
                      </div>
                    )}
                    <textarea
                      ref={sourceRef}
                      aria-label="待翻译文本"
                      placeholder={MOBILE ? '输入文字，或从其他应用复制后粘贴…' : '粘贴、输入，或截取屏幕上的一段文字…'}
                      value={text}
                      spellCheck={false}
                      disabled={phase === 'ocr'}
                      onChange={(event) => {
                        stop();
                        setText(event.target.value);
                        setOutput('');
                        setDuration(null);
                        setError('');
                      }}
                      onPaste={(event) => {
                        const file = Array.from(event.clipboardData.items)
                          .find((item) => item.type.startsWith('image/'))
                          ?.getAsFile();
                        if (file) {
                          event.preventDefault();
                          void importFile(file);
                        }
                      }}
                    />
                    <div className="source-footer">
                      <span>{text.length.toLocaleString()} 字符</span>
                      {!text && !image && (
                        <button
                          className="text-button example-button"
                          onClick={() => {
                            setText(SAMPLE);
                            sourceRef.current?.focus();
                          }}
                        >
                          试试一段英文
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  </section>
                  <section className="result-panel" aria-label="翻译结果">
                    <div className="panel-label">
                      <span>
                        译文 <span className="ai-badge">AI</span>
                      </span>
                      <div>
                      {MOBILE && isNative && <button
                        className="icon-button"
                        disabled={!output}
                        aria-label="分享译文"
                        title="分享译文"
                        onClick={() => { void shareText(output).catch((cause) => notify(errorMessage(cause))); }}
                      ><Share2 size={18} /></button>}
                      <button
                        className="icon-button"
                        disabled={!output}
                        title="复制译文"
                        aria-label="复制译文"
                        onClick={() => {
                          void copyOutput();
                        }}
                      >
                        <Copy size={16} />
                      </button>
                      </div>
                    </div>
                    {output ? (
                      <div
                        className={`translation-output ${phase === 'translating' ? 'streaming' : ''}`}
                        aria-live="polite"
                        aria-atomic="false"
                      >
                        {output}
                      </div>
                    ) : (
                      <div className={`empty-result ${busy ? 'working' : ''}`}>
                        <div className="empty-glyph">
                          {busy ? (
                            <LoaderCircle size={28} className="spin" />
                          ) : (
                            <Languages size={31} strokeWidth={1.25} />
                          )}
                        </div>
                        <strong>
                          {phase === 'ocr'
                            ? '正在读懂图片中的文字'
                            : phase === 'translating'
                              ? '正在等待第一段译文'
                              : phase === 'capturing'
                                ? MOBILE
                                  ? '请选择一张截图'
                                  : isNative
                                  ? '正在准备桌面框选'
                                  : '请选择浏览器分享内容'
                                : '译文将在这里出现'}
                        </strong>
                        <p>
                          {phase === 'ocr'
                            ? ocrMessage
                            : phase === 'translating'
                              ? '译文会随生成进度逐字呈现'
                              : MOBILE ? '选取截图，或在上方输入原文' : '截取屏幕文字，或在左侧输入原文'}
                        </p>
                        {phase === 'ocr' && (
                          <div className="progress-track">
                            <span style={{ width: `${Math.round(ocrProgress * 100)}%` }} />
                          </div>
                        )}
                      </div>
                    )}
                    <div className="result-footer">
                      <span className="result-status">
                        {phase === 'translating' ? (
                          <>
                            <span className="status-dot pulse" />
                            正在翻译
                          </>
                        ) : duration !== null ? (
                          <>
                            <Check size={13} />
                            已完成 · {(duration / 1000).toFixed(2)}s
                          </>
                        ) : (
                          <>
                            <span className="quiet-dot" />
                            等待翻译
                          </>
                        )}
                      </span>
                      {firstToken !== null && (
                        <span className="token-time">首字 {(firstToken / 1000).toFixed(2)}s</span>
                      )}
                    </div>
                  </section>
                </div>
                <div className="translator-bottom">
                  <div className="service-selector">
                    <span className="service-icon">
                      <Sparkles size={14} />
                    </span>
                    <select
                      aria-label="翻译服务"
                      value={active?.id || ''}
                      onChange={(event) => updatePreferences({ activeProviderId: event.target.value })}
                    >
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} />
                  </div>
                  <div className="translate-actions">
                    {!MOBILE && <span className="enter-hint">{shortcutLabels.translate}</span>}
                    {busy ? (
                      <button className="button stop-button" onClick={stop}>
                        <X size={15} />
                        停止
                      </button>
                    ) : (
                      <button
                        className="button primary translate-button"
                        disabled={!text.trim()}
                        onClick={() => {
                          void runTranslation(text);
                        }}
                      >
                        <span>翻译</span>
                        <ArrowUpRight size={17} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {error && (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  <button
                    className="icon-button"
                    aria-label="关闭错误提示"
                    onClick={() => {
                      setError('');
                      setPhase('idle');
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              <div className="under-card">
                <span>
                  <ShieldCheck size={14} />
                  OCR 本机处理，文本发送至你选择的 API
                </span>
                <button className="text-button" onClick={() => chooseView('settings')}>
                  调整识别语言
                  <ChevronRight size={13} />
                </button>
              </div>
            </>
          )}
          {view === 'history' && (
            <HistoryView
              items={history}
              onClear={() => {
                try {
                  clearHistory();
                  setHistory([]);
                  notify('翻译记录已清空');
                } catch {
                  setStorageWarning('翻译记录暂时无法清除，请检查本地存储权限。原有记录已保留。');
                  reportBootStage('storage-write-failed');
                }
              }}
              onOpen={(item) => {
                stop();
                setText(item.source);
                setOutput(item.translation);
                setImage(null);
                setOcrConfidence(null);
                setDuration(item.durationMs);
                updatePreferences({ sourceLang: item.sourceLang, targetLang: item.targetLang });
                chooseView('translate');
              }}
              onCopy={(value) => {
                void writeClipboard(value)
                  .then(() => notify('译文已复制'))
                  .catch((error) => notify(errorMessage(error)));
              }}
              onStart={() => chooseView('translate')}
            />
          )}
          {view === 'settings' && (
            <PreferencesView
              preferences={preferences}
              providers={providers}
              macPermission={macPermission}
              onPreferences={updatePreferences}
              onAddProvider={() => setShowPresets(true)}
              onEditProvider={setEditing}
              onCapture={() => {
                void capture();
              }}
              onWarmOcr={() => {
                notify('正在预热 OCR…');
                void warmOcr(preferences.ocrLang)
                  .then(() => notify('识别引擎已就绪'))
                  .catch((error) => notify(errorMessage(error)));
              }}
              onQuit={() => {
                void quitApplication().catch(() => notify('退出请求未完成，请使用窗口关闭按钮。'));
              }}
            />
          )}
        </div>
      </main>
      {MOBILE && <MobileNavigation view={view} onChange={chooseView} />}
      <input
        className="sr-only"
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {showPresets && (
        <ProviderPresets
          onClose={() => setShowPresets(false)}
          onChoose={(provider) => {
            setShowPresets(false);
            setEditing(provider);
          }}
        />
      )}
      {editing && (
        <ProviderEditor
          provider={editing}
          existing={providers.some((p) => p.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={saveProvider}
          onRemove={removeProvider}
        />
      )}
      {crop && (
        <ImageCropper
          screenshot={crop}
          onCancel={() => setCrop(null)}
          onConfirm={(rect) => {
            const screenshot = crop;
            setCrop(null);
            stop();
            const job = jobRef.current;
            void (async () => {
              const img = new Image();
              img.src = screenshot.dataUrl;
              await img.decode();
              if (job !== jobRef.current) return;
              const canvas = document.createElement('canvas');
              canvas.width = rect.width;
              canvas.height = rect.height;
              canvas
                .getContext('2d')!
                .drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
              await handleImage(canvas.toDataURL('image/png'), true);
            })().catch((e) => {
              if (job !== jobRef.current) return;
              setError(errorMessage(e));
              setPhase('error');
            });
          }}
        />
      )}
    </div>
  );
}
