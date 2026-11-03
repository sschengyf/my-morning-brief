import type { DateTime } from 'luxon';
import { z } from 'zod';
import type { Location } from '../../location/index.js';
import { describeError, fetchOk, type SourceResult } from '../common.js';
import { describeWeatherCode } from './codes.js';
import { formatWeather } from './format.js';
import type { DayForecast, WeatherRaw } from './types.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURS = [6, 9, 12, 15, 18, 21];

// Open-Meteo reports null for values it has no data for.
const num = z.number().nullable();

const forecastSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: num,
    apparent_temperature: num,
    weather_code: num,
    wind_speed_10m: num,
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(num),
    temperature_2m_max: z.array(num),
    temperature_2m_min: z.array(num),
    precipitation_probability_max: z.array(num),
    uv_index_max: z.array(num),
    sunrise: z.array(z.string().nullable()),
    sunset: z.array(z.string().nullable()),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(num),
    weather_code: z.array(num),
    precipitation_probability: z.array(num),
  }),
});

export function forecastUrl(location: Location): URL {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  // Without this, daily values are split on UTC days and "today" is wrong.
  url.searchParams.set('timezone', location.timezone);
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
  );
  url.searchParams.set('hourly', 'temperature_2m,weather_code,precipitation_probability');
  return url;
}

export async function fetchWeather(
  location: Location,
  now: DateTime,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceResult<WeatherRaw | null>> {
  try {
    const response = await fetchOk(forecastUrl(location), fetchImpl);
    const raw = toWeatherRaw(location, now, forecastSchema.parse(await response.json()));
    return { text: formatWeather(raw), raw, ok: true };
  } catch (error) {
    return { text: `（天气获取失败：${describeError(error)}）`, raw: null, ok: false };
  }
}

function toWeatherRaw(
  location: Location,
  now: DateTime,
  data: z.infer<typeof forecastSchema>,
): WeatherRaw {
  const todayDate = now.setZone(location.timezone).toISODate()!;
  const todayIndex = data.daily.time.indexOf(todayDate);
  if (todayIndex === -1) throw new Error(`预报里没有今天（${todayDate}）的数据`);

  const day = (index: number): DayForecast | null => {
    const date = data.daily.time[index];
    if (date === undefined) return null;
    return {
      date,
      condition: describeWeatherCode(data.daily.weather_code[index] ?? null),
      minC: data.daily.temperature_2m_min[index] ?? null,
      maxC: data.daily.temperature_2m_max[index] ?? null,
      precipitationChance: data.daily.precipitation_probability_max[index] ?? null,
      uvIndex: data.daily.uv_index_max[index] ?? null,
      sunrise: clockTime(data.daily.sunrise[index] ?? null),
      sunset: clockTime(data.daily.sunset[index] ?? null),
    };
  };

  const hourly = HOURS.flatMap((hour) => {
    const time = `${todayDate}T${String(hour).padStart(2, '0')}:00`;
    const index = data.hourly.time.indexOf(time);
    if (index === -1) return [];
    return [
      {
        time: clockTime(time)!,
        temperatureC: data.hourly.temperature_2m[index] ?? null,
        condition: describeWeatherCode(data.hourly.weather_code[index] ?? null),
        precipitationChance: data.hourly.precipitation_probability[index] ?? null,
      },
    ];
  });

  return {
    city: location.city,
    timezone: location.timezone,
    current: {
      time: clockTime(data.current.time)!,
      temperatureC: data.current.temperature_2m,
      feelsLikeC: data.current.apparent_temperature,
      condition: describeWeatherCode(data.current.weather_code),
      windKmh: data.current.wind_speed_10m,
    },
    today: day(todayIndex)!,
    tomorrow: day(todayIndex + 1),
    hourly,
  };
}

/** "2026-11-03T06:14" → "06:14". Open-Meteo already returns local time when timezone is set. */
function clockTime(isoLocal: string | null): string | null {
  return isoLocal?.slice(11, 16) ?? null;
}
