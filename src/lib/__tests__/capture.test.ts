import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureDisplay } from '../platform';

class FakeTrack extends EventTarget { readyState = 'live'; stop = vi.fn(() => { this.readyState = 'ended'; }); }
class FakeVideo extends EventTarget {
  readyState = 2; videoWidth = 800; videoHeight = 600; muted = false; playsInline = false;
  srcObject: unknown = null;
  play = vi.fn(() => Promise.resolve()); pause = vi.fn();
}
let tracks: FakeTrack[], stream: MediaStream, video: FakeVideo, getDisplayMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  tracks = [new FakeTrack(), new FakeTrack()];
  stream = { getTracks: () => tracks } as unknown as MediaStream;
  video = new FakeVideo();
  getDisplayMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal('document', { createElement: vi.fn((tag: string) => {
    if (tag === 'video') return video;
    return { getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/png;base64,frame' };
  }) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function expectReleased() {
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(video.srcObject).toBeNull();
}
describe('browser capture lifetime', () => {
  it('captures one frame and immediately releases every track', async () => {
    expect(await captureDisplay()).toEqual({ dataUrl: 'data:image/png;base64,frame', width: 800, height: 600 });
    expectReleased(); expect(video.pause).toHaveBeenCalled();
  });
  it('times out video.play that never resolves and can capture again', async () => {
    vi.useFakeTimers(); video.play.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = captureDisplay(); const check = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10_000); await check; expectReleased();
    tracks = [new FakeTrack()];
    expect(await captureDisplay()).toMatchObject({ width: 800 });
    expectReleased();
  });
  it('stops sharing immediately when cancelled while playback is pending', async () => {
    video.play.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = captureDisplay(controller.signal); const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
    controller.abort(); await check; expectReleased();
  });
  it('cancels while the system picker is open and stops a stream granted later', async () => {
    let grant!: (stream: MediaStream) => void;
    getDisplayMedia.mockImplementationOnce(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
    const controller = new AbortController();
    const pending = captureDisplay(controller.signal); const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await check;
    expect(video.play).not.toHaveBeenCalled();
    grant(stream); await Promise.resolve(); await Promise.resolve();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
  });
  it('handles track ended during pending playback and ignores late playback completion', async () => {
    let play!: () => void;
    video.play.mockImplementationOnce(() => new Promise<void>(resolve => { play = resolve; }));
    const pending = captureDisplay(); const check = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
    tracks[0].dispatchEvent(new Event('ended')); await check; expectReleased();
    play(); await Promise.resolve(); expect(video.srcObject).toBeNull();
  });
  it('does not start playback for a stream whose track already ended', async () => {
    tracks[0].readyState = 'ended';
    video.play.mockRejectedValueOnce(new Error('play must never be called'));
    await expect(captureDisplay()).rejects.toMatchObject({ name: 'AbortError' });
    expect(video.play).not.toHaveBeenCalled(); expectReleased();
  });
  it('handles synchronous abort inside play and a later play rejection', async () => {
    const controller = new AbortController();
    video.play.mockImplementationOnce(() => { controller.abort(); return Promise.reject(new Error('play was aborted')); });
    await expect(captureDisplay(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); expectReleased();
  });
  it('bounds first-frame waiting after playback and cleans up listeners', async () => {
    vi.useFakeTimers(); video.readyState = 0;
    const remove = vi.spyOn(video, 'removeEventListener');
    const pending = captureDisplay(); const check = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10_000); await check; expectReleased();
    expect(remove.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['loadeddata', 'error']));
  });
  it('releases a granted stream when play rejects', async () => {
    video.play.mockRejectedValueOnce(new Error('playback failed'));
    await expect(captureDisplay()).rejects.toThrow('playback failed'); expectReleased();
  });
  it('does not open the picker when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(captureDisplay(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});
