export type ProviderKind = 'openai' | 'anthropic' | 'gemini';
export interface Provider { id: string; name: string; kind: ProviderKind; baseUrl: string; model: string; hasKey: boolean; }
export interface Preferences { sourceLang: string; targetLang: string; ocrLang: string; autoTranslate: boolean; activeProviderId: string; }
export interface DesktopPreferences {
  closeAction: 'quit' | 'tray';
  launchAtLogin: boolean;
  trayAvailable: boolean;
  autostartAvailable: boolean;
  autostartError?: string;
}
export interface HistoryItem { id: string; source: string; translation: string; sourceLang: string; targetLang: string; providerName: string; createdAt: number; durationMs: number; input: 'text' | 'clipboard' | 'image'; }
export interface TranslationRequest { provider: Provider; apiKey: string; text: string; sourceLang: string; targetLang: string; signal: AbortSignal; onDelta: (text: string) => void; }
export interface Screenshot { dataUrl: string; width: number; height: number; }
