import { useEffect, useRef, useState } from 'react';
import { createTextStream } from '../lib/textStream';

export function useStreamingOutput() {
  const [output, setOutput] = useState('');
  const stream = useRef<ReturnType<typeof createTextStream> | null>(null);
  if (!stream.current) stream.current = createTextStream(setOutput, {
    request: callback => requestAnimationFrame(callback),
    cancel: id => cancelAnimationFrame(id),
  });
  const current = stream.current;
  useEffect(() => () => current.dispose(), [current]);
  return { output, setOutput: current.replace, appendOutput: current.append, flushOutput: current.flush };
}
