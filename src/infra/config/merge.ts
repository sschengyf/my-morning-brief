type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The shared config with a person's config on top: tables merge key by key and
 * the person's values win; arrays and other values are replaced, not joined.
 */
export function mergeConfig(shared: Table, personal: Table): Table {
  const merged: Table = { ...shared };
  for (const [key, value] of Object.entries(personal)) {
    const base = merged[key];
    merged[key] = isTable(base) && isTable(value) ? mergeConfig(base, value) : value;
  }
  return merged;
}
