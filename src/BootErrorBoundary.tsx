import { Component, useEffect } from 'react';
import type { PropsWithChildren } from 'react';
import { isNative, isNativeMac, shortcutLabels } from './lib/platform';

export type BootStage = 'bootstrap-start' | 'bootstrap-import-failed' | 'react-render-failed' | 'storage-read-failed' | 'storage-write-failed' | 'unhandled-error' | 'unhandled-rejection' | 'bootstrap-timeout';
declare global {
  interface Window {
    __FASTD_BOOT__?: { fail: (stage: BootStage) => void; report: (stage: BootStage) => void; done: () => void };
  }
}

export function reportBootStage(stage: BootStage): void {
  window.__FASTD_BOOT__?.report(stage);
}

export async function quitApplication(): Promise<void> {
  const bridge = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
  if (!bridge) throw new Error('退出应用仅在桌面版中可用。');
  await bridge.invoke('quit_app');
}

export function BootMounted({ children }: PropsWithChildren) {
  useEffect(() => { window.__FASTD_BOOT__?.done(); }, []);
  return children;
}

export default class BootErrorBoundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(): void {
    // Error strings/stacks can contain API keys or translated input: log a stage only.
    window.__FASTD_BOOT__?.fail('react-render-failed');
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="boot-surface" role="alert"><div className="boot-card"><div className="boot-brand">FASTDICT · 轻译</div><h2>应用界面未能启动</h2><p>可以重新加载或退出。现有配置、历史和密钥没有被清除。</p><div className="boot-actions"><button onClick={() => window.location.reload()}>重新加载</button><button onClick={() => {void quitApplication().catch(() => window.__FASTD_BOOT__?.fail('unhandled-error'));}}>退出应用</button></div>{isNative && <p className="boot-stage">{isNativeMac ? '⌘Q 退出应用；⌥⌘Q 可立即退出。' : `${shortcutLabels.emergencyQuit} 可立即退出应用。`}</p>}</div></section>;
  }
}
