import { describe, it, expect, mock } from "bun:test";
import { withSessionRetry } from "./tracker.ts";
import { RiichiCityClient, SessionExpiredError } from "./riichicity.ts";

function makeMockClient(): RiichiCityClient {
  return {
    login: mock(() => Promise.resolve()),
  } as unknown as RiichiCityClient;
}

describe("withSessionRetry", () => {
  it("calls fn once and does not login when no error", async () => {
    const client = makeMockClient();
    const fn = mock(() => Promise.resolve());
    await withSessionRetry(client, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.login).not.toHaveBeenCalled();
  });

  it("re-logs in and retries once on SessionExpiredError", async () => {
    const client = makeMockClient();
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls === 1) throw new SessionExpiredError("/test", 10001);
    });
    await withSessionRetry(client, fn);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates non-session errors without retrying or re-logging in", async () => {
    const client = makeMockClient();
    const fn = mock(async () => { throw new Error("network failure"); });
    await expect(withSessionRetry(client, fn)).rejects.toThrow("network failure");
    expect(client.login).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates SessionExpiredError if the retry also fails", async () => {
    const client = makeMockClient();
    const fn = mock(async () => { throw new SessionExpiredError("/test", 401); });
    await expect(withSessionRetry(client, fn)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates login failure without calling fn a second time", async () => {
    const client = {
      login: mock(async () => { throw new Error("login failed"); }),
    } as unknown as RiichiCityClient;
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls === 1) throw new SessionExpiredError("/test", 401);
    });
    await expect(withSessionRetry(client, fn)).rejects.toThrow("login failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
