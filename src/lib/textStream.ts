interface FrameScheduler {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

/** Publish the first text immediately, then coalesce network fragments per frame. */
export function createTextStream(publish: (text: string) => void, frames: FrameScheduler) {
  let text = '';
  let pending: string[] = [];
  let frame: number | undefined;
  const cancelFrame = () => {
    if (frame !== undefined) frames.cancel(frame);
    frame = undefined;
  };
  const flush = () => {
    cancelFrame();
    if (!pending.length) return text;
    text += pending.join('');
    pending = [];
    publish(text);
    return text;
  };
  return {
    append(delta: string) {
      if (!delta) return;
      if (!text) { text = delta; publish(text); return; }
      pending.push(delta);
      if (frame === undefined) frame = frames.request(flush);
    },
    replace(value: string) {
      cancelFrame();
      pending = [];
      text = value;
      publish(text);
    },
    flush,
    dispose() { cancelFrame(); pending = []; text = ''; },
  };
}
