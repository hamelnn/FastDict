import { describe, expect, it } from 'vitest';
import { detectOperatingSystem } from '../platform';

describe('shared platform detection', () => {
  it('recognizes macOS, Windows and mobile native build targets', () => {
    expect(detectOperatingSystem({ buildPlatform: 'darwin', platform: 'Win32' })).toBe('macos');
    expect(detectOperatingSystem({ buildPlatform: 'windows', platform: 'MacIntel' })).toBe('windows');
    expect(detectOperatingSystem({ buildPlatform: 'ios', platform: 'MacIntel' })).toBe('ios');
    expect(detectOperatingSystem({ buildPlatform: 'android' })).toBe('android');
  });
  it('does not mistake an iPad reporting MacIntel for a macOS desktop app', () => {
    expect(detectOperatingSystem({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', maxTouchPoints: 5 })).toBe('ios');
    expect(detectOperatingSystem({ platform: 'MacIntel', maxTouchPoints: 0 })).toBe('macos');
    expect(detectOperatingSystem({ platform: 'MacIntel', userAgent: 'iPad', maxTouchPoints: 0 })).toBe('ios');
  });
  it('uses browser/device hints safely when build metadata is absent', () => {
    expect(detectOperatingSystem({ platform: 'Win32', userAgent: 'Windows NT 10.0' })).toBe('windows');
    expect(detectOperatingSystem({ platform: 'Linux armv8l', userAgent: 'Android' })).toBe('android');
    expect(detectOperatingSystem({ platform: 'Linux x86_64' })).toBe('linux');
    expect(detectOperatingSystem({})).toBe('unknown');
  });
});
