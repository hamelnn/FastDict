import { describe, expect, it } from 'vitest';
import { createTextStream } from '../textStream';

function fixture() {
  const frames = new Map<number, () => void>();
  let nextId = 0;
  const published: string[] = [];
  const stream = createTextStream(value => published.push(value), {
    request(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancel(id) { frames.delete(id); },
  });
  const paint = () => { for (const callback of [...frames.values()]) callback(); };
  return { stream, frames, published, paint };
}

describe('streamed translation presentation', () => {
  it('shows the first text immediately and publishes a burst once per frame without losing order', () => {
    const { stream, frames, published, paint } = fixture();
    stream.append('首');
    expect(published).toEqual(['首']);
    const fragments = Array.from({ length: 1000 }, (_, index) => `${index}译`);
    for (const fragment of fragments) stream.append(fragment);
    expect(frames.size).toBe(1);
    expect(published).toHaveLength(1);
    paint();
    expect(published).toEqual(['首', '首' + fragments.join('')]);
    expect(frames.size).toBe(0);
  });

  it('keeps received text when stopping even if no frame has painted yet', () => {
    const { stream, published, frames, paint } = fixture();
    stream.append('已'); stream.append('接收'); stream.append('文本');
    expect(stream.flush()).toBe('已接收文本');
    expect(stream.flush()).toBe('已接收文本');
    expect(published).toEqual(['已', '已接收文本']);
    expect(frames.size).toBe(0);
    paint();
    expect(published).toHaveLength(2);
  });

  it('reset, replacement and disposal cannot publish buffered text from an old request', () => {
    const { stream, published, frames, paint } = fixture();
    stream.append('old'); stream.append(' pending');
    stream.replace('');
    stream.append('new'); stream.append(' draft');
    stream.replace('complete');
    paint();
    expect(published).toEqual(['old', '', 'new', 'complete']);
    stream.append(' late');
    stream.dispose();
    paint();
    expect(frames.size).toBe(0);
    expect(published.at(-1)).toBe('complete');
    // React StrictMode remounts the effect with the same stream instance.
    stream.append('next');
    expect(published.at(-1)).toBe('next');
  });
});
