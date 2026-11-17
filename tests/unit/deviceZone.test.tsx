import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  timeIn,
  useDeviceZone,
} from "../../src/features/calendar/useDeviceZone";

function setZone(zone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone: zone,
  } as Intl.ResolvedDateTimeFormatOptions);
}

describe("device zone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-reads the zone when the window regains focus", () => {
    setZone("Europe/Paris");
    const { result } = renderHook(() => useDeviceZone());
    expect(result.current).toBe("Europe/Paris");
    setZone("America/New_York");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe("America/New_York");
  });

  it("formats an instant in another zone with a 24-hour clock", () => {
    expect(timeIn("2026-11-18T00:00:00Z", "Asia/Tokyo")).toBe("09:00");
    expect(timeIn("2026-03-08T07:30:00Z", "America/New_York")).toBe("03:30");
    expect(timeIn("2026-11-18T23:45:00Z", "UTC")).toBe("23:45");
  });
});
