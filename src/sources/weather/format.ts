import { uv } from './codes.js';
import type { DayForecast, WeatherRaw } from './types.js';

function value(n: number | null, unit: string, digits = 0): string {
  return n === null ? '未知' : `${n.toFixed(digits)}${unit}`;
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
