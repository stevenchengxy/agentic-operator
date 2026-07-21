import { describe, it, expect, vi, afterEach } from "vitest";
import { fmtAgo, fmtDur, fmtBytes, fmtNum } from "./format";

describe("fmtAgo", () => {
  it("renders an em dash for missing or invalid timestamps", () => {
    expect(fmtAgo(0)).toBe("—");
    expect(fmtAgo(Number.NaN)).toBe("—");
  });

  afterEach(() => vi.useRealTimers());

  it("returns Ns ago under one minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    expect(fmtAgo(Date.now() - 5_000)).toBe("5s ago");
    expect(fmtAgo(Date.now())).toBe("1s ago"); // floor of zero clamps to 1
    expect(fmtAgo(Date.now() - 5_000, "zh")).toBe("5 秒前");
  });

  it("returns Nm ago in minute range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    expect(fmtAgo(Date.now() - 2 * 60_000)).toBe("2m ago");
    expect(fmtAgo(Date.now() - 2 * 60_000, "zh")).toBe("2 分钟前");
  });

  it("returns Nh ago in hour range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    expect(fmtAgo(Date.now() - 3 * 3_600_000)).toBe("3h ago");
    expect(fmtAgo(Date.now() - 3 * 3_600_000, "zh")).toBe("3 小时前");
  });

  it("returns Nd ago beyond a day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    expect(fmtAgo(Date.now() - 2 * 86_400_000)).toBe("2d ago");
    expect(fmtAgo(Date.now() - 2 * 86_400_000, "zh")).toBe("2 天前");
  });
});

describe("fmtDur", () => {
  it("renders ms under one second", () => {
    expect(fmtDur(120)).toBe("120ms");
  });

  it("renders fractional seconds", () => {
    expect(fmtDur(2_350)).toBe("2.35s");
  });

  it("renders minute breakdown", () => {
    expect(fmtDur(125_000)).toBe("2m 5s");
  });

  it("renders hour breakdown", () => {
    expect(fmtDur(3_780_000)).toBe("1h 3m");
  });

  it("handles null/undefined", () => {
    expect(fmtDur(null)).toBe("—");
    expect(fmtDur(undefined)).toBe("—");
  });
});

describe("fmtBytes", () => {
  it("returns bytes under 1 KB", () => {
    expect(fmtBytes(900)).toBe("900 B");
  });
  it("returns KB", () => {
    expect(fmtBytes(2048)).toBe("2.0 KB");
  });
  it("returns MB", () => {
    expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("fmtNum", () => {
  it("returns the raw number below 1000", () => {
    expect(fmtNum(42)).toBe("42");
  });
  it("returns K-suffix in the thousands", () => {
    expect(fmtNum(1500)).toBe("1.5K");
  });
  it("returns M-suffix in the millions", () => {
    expect(fmtNum(2_500_000)).toBe("2.5M");
  });
});
