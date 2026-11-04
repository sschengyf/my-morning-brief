import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import type { Location } from '#/location/effective.js';
import { describeWeatherCode } from './codes.js';
import { fetchWeather } from './fetch.js';
import { readFixture } from '../../../test/helpers.js';

const AUCKLAND: Location = {
  city: 'Auckland',
  timezone: 'Pacific/Auckland',
  latitude: -36.85,
  longitude: 174.76,
  isHome: true,
};

// The fixture was captured at 07:15 on 3 Nov 2026 in Auckland.
const NOW = DateTime.fromISO('2026-11-03T07:20', { zone: 'Pacific/Auckland' });

async function fixtureFetch() {
  const body = await readFixture('weather-auckland.json');
  return vi.fn<typeof fetch>(async () => new Response(body));
}

describe('fetchWeather', () => {
  it('asks Open-Meteo for the effective location and timezone', async () => {
    const fetchMock = await fixtureFetch();
    await fetchWeather(
      { ...AUCKLAND, timezone: 'Asia/Shanghai', latitude: 31.2, longitude: 121.5 },
      NOW,
      fetchMock,
    );
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('timezone')).toBe('Asia/Shanghai');
    expect(url.searchParams.get('latitude')).toBe('31.2');
    expect(url.searchParams.get('longitude')).toBe('121.5');
  });

  it('summarises current, today, hourly and tomorrow in Chinese', async () => {
    const result = await fetchWeather(AUCKLAND, NOW, await fixtureFetch());
    expect(result.ok).toBe(true);
    expect(result.text.split('\n')).toEqual([
      '地点：Auckland',
      '现在（07:15）：16.4°C，体感 15.5°C，阴，风速 13 km/h',
      '今天：毛毛雨，16–19°C，降水概率最高 9%，紫外线指数 7（高），日出 06:14，日落 19:55',
      expect.stringMatching(/^今天分时：06:00 \d+°C \S+ 降水 \d+%；09:00 .+；21:00 .+$/),
      '明天：小阵雨，16–20°C，降水概率最高 31%',
    ]);
  });

  it('picks today by the effective timezone, not the system one', async () => {
    // 23:30 on 2 Nov in UTC is already 3 Nov in Auckland.
    const lateUtc = DateTime.fromISO('2026-11-02T23:30', { zone: 'utc' });
    const result = await fetchWeather(AUCKLAND, lateUtc, await fixtureFetch());
    expect(result.raw?.today.date).toBe('2026-11-03');
  });

  it('reports HTTP errors and timeouts without throwing', async () => {
    const busy = await fetchWeather(
      AUCKLAND,
      NOW,
      vi.fn<typeof fetch>(async () => new Response('busy', { status: 503 })),
    );
    expect(busy).toEqual({ text: '（天气获取失败：HTTP 503）', raw: null, ok: false });

    const slow = await fetchWeather(
      AUCKLAND,
      NOW,
      vi.fn<typeof fetch>(async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }),
    );
    expect(slow.text).toBe('（天气获取失败：请求超时）');
  });

  it('fails cleanly when the forecast does not cover today', async () => {
    const result = await fetchWeather(AUCKLAND, NOW.plus({ days: 7 }), await fixtureFetch());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('预报里没有今天');
  });

  it('maps WMO codes, including unknown ones', () => {
    expect(describeWeatherCode(0)).toBe('晴');
    expect(describeWeatherCode(95)).toBe('雷暴');
    expect(describeWeatherCode(42)).toBe('天气代码 42');
    expect(describeWeatherCode(null)).toBe('天气未知');
  });
});
