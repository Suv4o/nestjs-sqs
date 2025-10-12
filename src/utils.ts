export const numberFromEnv = (
  value: string | number | null | undefined,
  fallback: number,
): number => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
