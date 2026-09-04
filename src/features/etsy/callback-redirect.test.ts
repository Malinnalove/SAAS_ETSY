import { describe, expect, it } from "vitest";
import { buildEtsyCallbackRedirectUrl } from "./callback-redirect";

describe("buildEtsyCallbackRedirectUrl", () => {
  it("uses the configured public app URL for a saved return path", () => {
    const redirectUrl = buildEtsyCallbackRedirectUrl(
      "https://zlinfun.com",
      "/settings?lang=zh",
      67630345,
      "reconnected",
    );

    expect(redirectUrl.origin).toBe("https://zlinfun.com");
    expect(redirectUrl.pathname).toBe("/settings");
    expect(redirectUrl.searchParams.get("shopId")).toBe("67630345");
    expect(redirectUrl.searchParams.get("settingsStatus")).toBe("reconnected");
  });

  it("uses the configured public app URL for the default dashboard", () => {
    expect(
      buildEtsyCallbackRedirectUrl("https://zlinfun.com", undefined, 67630345, "connected").toString(),
    ).toBe("https://zlinfun.com/dashboard?shopId=67630345");
  });
});
