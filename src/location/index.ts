// Public API of location/: other modules import from here, never from its files.
export {
  clearLocationOverride,
  getEffectiveLocation,
  homeLocation,
  setLocationOverride,
} from './effective.js';
export type { Location } from './effective.js';
export { searchCity } from './geocoding.js';
export type { CityMatch } from './geocoding.js';
