export function dateFromTimestamp(value: number | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}
