export function gridPageNumber(value: unknown) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 1 ? page : 1;
}
