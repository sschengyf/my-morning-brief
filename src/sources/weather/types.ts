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
