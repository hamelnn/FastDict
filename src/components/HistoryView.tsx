import { useState } from 'react';
import { ArrowDown, ArrowUpRight, Copy, History, Trash2 } from 'lucide-react';
import type { HistoryItem } from '../types';
import { labelForLanguage } from '../lib/catalog';

interface Props {
  items: HistoryItem[];
  onClear: () => void;
  onOpen: (item: HistoryItem) => void;
  onCopy: (text: string) => void;
  onStart: () => void;
}

export function HistoryView({ items, onClear, onOpen, onCopy, onStart }: Props) {
  const [confirmClear, setConfirmClear] = useState(false);
  const clear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    onClear();
    setConfirmClear(false);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>翻译记录</h1>
          <p>{items.length} 条 · 保存在本机</p>
        </div>
        {items.length > 0 && (
          <button className="button secondary" onClick={clear}>
            <Trash2 size={15} />
            {confirmClear ? '确认清空全部' : '清空记录'}
          </button>
        )}
      </div>
      {items.length ? (
        <div className="history-list">
          {items.map((item) => (
            <article className="history-card" key={item.id}>
              <div className="history-meta">
                <span>
                  {labelForLanguage(item.sourceLang)}
                  <ArrowUpRight size={12} />
                  {labelForLanguage(item.targetLang)}
                </span>
                <time>
                  {new Date(item.createdAt).toLocaleString('zh-CN', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </div>
              <div className="history-content">
                <p>{item.source}</p>
                <ArrowDown size={16} />
                <p>{item.translation}</p>
              </div>
              <div className="history-footer">
                <span>
                  {item.providerName} · {(item.durationMs / 1000).toFixed(2)}s
                </span>
                <button className="text-button" onClick={() => onOpen(item)}>
                  查看
                  <ArrowUpRight size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label="复制记录译文"
                  onClick={() => onCopy(item.translation)}
                >
                  <Copy size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="page-empty">
          <History size={36} strokeWidth={1.2} />
          <h2>暂无翻译记录</h2>
          <button className="button primary" onClick={onStart}>
            开始翻译
            <ArrowUpRight size={16} />
          </button>
        </div>
      )}
    </>
  );
}
