/** Format integer USD nanodollars without rounding each bucket to a cent. */
export function formatUsdNanos(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const nanos = Math.round(value);
  const sign = nanos < 0 ? "-" : "";
  const absolute = Math.abs(nanos);
  const whole = Math.floor(absolute / 1_000_000_000);
  const fractionNanos = absolute % 1_000_000_000;
  let fraction = fractionNanos.toString().padStart(9, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${fraction}`;
}
