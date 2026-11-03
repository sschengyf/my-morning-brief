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

// WHO UV index categories: upper bound → level. Saves the model judging "7" itself.
const UV_LEVELS: [number, string][] = [
  [2, '低'],
  [5, '中等'],
  [7, '高'],
  [10, '很高'],
  [Infinity, '极高'],
];

export function uv(index: number | null): string {
  if (index === null) return '未知';
  const rounded = Math.round(index);
  const level = UV_LEVELS.find(([max]) => rounded <= max)![1];
  return `${rounded}（${level}）`;
}
