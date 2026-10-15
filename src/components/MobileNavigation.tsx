import { History, Languages, Settings2 } from 'lucide-react';

export type MobileView = 'translate' | 'history' | 'settings';

export function MobileNavigation({ view, onChange }: { view: MobileView; onChange: (view: MobileView) => void }) {
  const tabs = [
    { id: 'translate', label: '翻译', accessibleLabel: '即时翻译', Icon: Languages },
    { id: 'history', label: '记录', accessibleLabel: '翻译记录', Icon: History },
    { id: 'settings', label: '设置', accessibleLabel: '偏好设置', Icon: Settings2 },
  ] as const;

  return (
    <nav className="mobile-navigation" aria-label="移动导航">
      {tabs.map(({ id, label, accessibleLabel, Icon }) => (
        <button
          key={id}
          className={view === id ? 'selected' : ''}
          aria-label={accessibleLabel}
          aria-current={view === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          <span className="mobile-tab-icon"><Icon size={22} strokeWidth={1.8} /></span>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
