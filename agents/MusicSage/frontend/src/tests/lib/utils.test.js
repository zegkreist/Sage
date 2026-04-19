import { describe, it, expect } from 'vitest';
import {
  escHtml, fmtDate, fmtBytes, fmtSpeed, fmtDuration, relTime, deriveMoodLabel
} from '$lib/utils.js';

describe('escHtml', () => {
  it('escapes < and >', () => expect(escHtml('<b>')).toBe('&lt;b&gt;'));
  it('escapes &', () => expect(escHtml('a&b')).toBe('a&amp;b'));
  it('escapes double-quotes', () => expect(escHtml('"ok"')).toBe('&quot;ok&quot;'));
  it('returns empty string for null', () => expect(escHtml(null)).toBe(''));
  it('returns empty string for undefined', () => expect(escHtml(undefined)).toBe(''));
  it('passes through safe text', () => expect(escHtml('hello world')).toBe('hello world'));
});

describe('fmtBytes', () => {
  it('formats bytes', () => expect(fmtBytes(512)).toBe('512 B'));
  it('formats kilobytes', () => expect(fmtBytes(1024)).toBe('1.0 KB'));
  it('formats megabytes', () => expect(fmtBytes(1024 * 1024)).toBe('1.0 MB'));
  it('formats gigabytes', () => expect(fmtBytes(1024 ** 3)).toBe('1.0 GB'));
  it('returns 0 B for falsy', () => expect(fmtBytes(0)).toBe('0 B'));
});

describe('fmtSpeed', () => {
  it('appends /s to formatted bytes', () => expect(fmtSpeed(1024)).toBe('1.0 KB/s'));
});

describe('fmtDuration', () => {
  it('formats 90 seconds as 1:30', () => expect(fmtDuration(90000)).toBe('1:30'));
  it('formats hours correctly', () => expect(fmtDuration(3700000)).toBe('1:01:40'));
  it('pads single-digit seconds', () => expect(fmtDuration(61000)).toBe('1:01'));
  it('returns — for 0', () => expect(fmtDuration(0)).toBe('—'));
  it('returns — for null', () => expect(fmtDuration(null)).toBe('—'));
});

describe('relTime', () => {
  it('returns agora for < 60 seconds ago', () => {
    const ts = Math.floor(Date.now() / 1000) - 30;
    expect(relTime(ts)).toBe('agora');
  });
  it('returns hours for >= 1 hour ago', () => {
    const ts = Math.floor(Date.now() / 1000) - 90 * 60;
    expect(relTime(ts)).toBe('há 1h');
  });
  it('returns ontem for 1 day ago', () => {
    const ts = Math.floor(Date.now() / 1000) - 86400;
    expect(relTime(ts)).toBe('ontem');
  });
  it('returns — for falsy', () => expect(relTime(0)).toBe('—'));
  it('returns — for null', () => expect(relTime(null)).toBe('—'));
});

describe('deriveMoodLabel', () => {
  it('returns Animado for high energy + valence + dance', () =>
    expect(deriveMoodLabel(8, 7, 8, null)).toBe('Animado 🎉'));
  it('returns Energético for high energy + valence (no dance)', () =>
    expect(deriveMoodLabel(8, 7, 4, null)).toBe('Energético 🔥'));
  it('returns Intenso for high energy + low valence', () =>
    expect(deriveMoodLabel(8, 2, 5, null)).toBe('Intenso ⚡'));
  it('returns Melancólico for low energy + low valence', () =>
    expect(deriveMoodLabel(3, 2, 5, null)).toBe('Melancólico 💙'));
  it('returns Relaxado for low energy alone', () =>
    expect(deriveMoodLabel(2, 5, 5, null)).toBe('Relaxado 🌊'));
  it('falls back to topMood when no data', () =>
    expect(deriveMoodLabel(null, null, null, 'Chill')).toBe('Chill'));
  it('uses Indefinido when no data and no topMood', () =>
    expect(deriveMoodLabel(null, null, null, null)).toBe('Indefinido'));
});

describe('fmtDate', () => {
  it('returns — for null', () => expect(fmtDate(null)).toBe('—'));
  it('formats a JS Date timestamp', () => {
    const result = fmtDate(new Date('2024-01-15').getTime());
    expect(result).toMatch(/jan/i);
    expect(result).toMatch(/2024/);
  });
});
