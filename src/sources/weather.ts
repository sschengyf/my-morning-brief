import type { DateTime } from 'luxon';
import { z } from 'zod';
import type { Location } from '../location.js';
import { describeError, fetchOk, type SourceResult } from './common.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURS = [6, 9, 12, 15, 18, 21];

const WMO_CODES: Record<number, string> = {
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};

export function describeWeatherCode(code: number | null): string {
  if (code === null) return '天气未知';
  return WMO_CODES[code] ?? `天气代码 ${code}`;
}

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

export interface DayForecast {
  date: string;
  condition: string;
  minC: number | null;
  maxC: number | null;
  precipitationChance: number | null;
  uvIndex: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface WeatherRaw {
  city: string;
  timezone: string;
  current: {
    time: string;
    temperatureC: number | null;
    feelsLikeC: number | null;
    condition: string;
    windKmh: number | null;
  };
  today: DayForecast;
  tomorrow: DayForecast | null;
  hourly: {
    time: string;
    temperatureC: number | null;
    condition: string;
    precipitationChance: number | null;
  }[];
}

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

function value(n: number | null, unit: string, digits = 0): string {
  return n === null ? '未知' : `${n.toFixed(digits)}${unit}`;
}

// WHO UV index categories: upper bound → level. Saves the model judging "7" itself.
const UV_LEVELS: [number, string][] = [
  [2, '低'],
  [5, '中等'],
  [7, '高'],
  [10, '很高'],
  [Infinity, '极高'],
];

function uv(index: number | null): string {
  if (index === null) return '未知';
  const rounded = Math.round(index);
  const level = UV_LEVELS.find(([max]) => rounded <= max)![1];
  return `${rounded}（${level}）`;
}

function range(day: DayForecast): string {
  if (day.minC === null || day.maxC === null) return '气温未知';
  return `${day.minC.toFixed(0)}–${day.maxC.toFixed(0)}°C`;
}

export function formatWeather(raw: WeatherRaw): string {
  const { current, today, tomorrow } = raw;
  const lines = [
    `地点：${raw.city}`,
    `现在（${current.time}）：${value(current.temperatureC, '°C', 1)}，体感 ${value(current.feelsLikeC, '°C', 1)}，${current.condition}，风速 ${value(current.windKmh, ' km/h')}`,
    `今天：${today.condition}，${range(today)}，降水概率最高 ${value(today.precipitationChance, '%')}，紫外线指数 ${uv(today.uvIndex)}，日出 ${today.sunrise ?? '未知'}，日落 ${today.sunset ?? '未知'}`,
  ];
  if (raw.hourly.length > 0) {
    const hours = raw.hourly.map(
      (h) =>
        `${h.time} ${value(h.temperatureC, '°C')} ${h.condition} 降水 ${value(h.precipitationChance, '%')}`,
    );
    lines.push(`今天分时：${hours.join('；')}`);
  }
  if (tomorrow) {
    lines.push(
      `明天：${tomorrow.condition}，${range(tomorrow)}，降水概率最高 ${value(tomorrow.precipitationChance, '%')}`,
    );
  }
  return lines.join('\n');
}
