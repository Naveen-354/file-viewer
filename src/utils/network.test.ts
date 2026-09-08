import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsNoRemoteHost, forbidsEverything, parseCsp, probeEgress } from "./network";

const REAL_CSP = "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

describe("policy parsing", () => {
  it("splits the shipped policy into its directives, in order", () => {
    const directives = parseCsp(REAL_CSP);
    expect(directives.map((d) => d.name)).toEqual([
      "default-src", "connect-src", "img-src", "media-src", "worker-src",
      "style-src", "font-src", "object-src", "frame-src", "base-uri", "form-action",
    ]);
    expect(directives[1].values).toEqual(["ipc:", "http://ipc.localhost"]);
  });

  it("explains every directive the build actually sets", () => {
    for (const directive of parseCsp(REAL_CSP)) {
      expect(directive.meaning, `${directive.name} has no explanation`).not.toBe("");
    }
  });

  it("identifies the directives that forbid everything", () => {
    const none = parseCsp(REAL_CSP).filter(forbidsEverything).map((d) => d.name);
    expect(none).toEqual(["object-src", "frame-src", "base-uri", "form-action"]);
  });

  it("finds no remote host permitted anywhere in the policy", () => {
    // The IPC bridge is local; nothing else may be reached.
    expect(parseCsp(REAL_CSP).every(allowsNoRemoteHost)).toBe(true);
  });

  it("would notice a remote host being added", () => {
    const loosened = parseCsp("img-src 'self' https://cdn.example.com");
    expect(loosened.every(allowsNoRemoteHost)).toBe(false);
  });

  it("tolerates trailing separators and extra whitespace", () => {
    expect(parseCsp("  default-src 'self' ;; ").map((d) => d.name)).toEqual(["default-src"]);
    expect(parseCsp("")).toEqual([]);
  });
});

describe("egress probe", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("reports a policy block when the browser raises a violation", async () => {
    vi.stubGlobal("fetch", () => {
      // The violation event fires before the rejection, as the browser does.
      const event = new Event("securitypolicyviolation") as SecurityPolicyViolationEvent;
      Object.assign(event, { blockedURI: "https://egress-check.invalid/oneopen", violatedDirective: "connect-src" });
      document.dispatchEvent(event);
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    const result = await probeEgress(500);
    expect(result.verdict).toBe("blocked-by-policy");
    expect(result.directive).toBe("connect-src");
  });

  it("does not claim a policy block when the request merely failed", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const result = await probeEgress(500);
    expect(result.verdict).toBe("failed-otherwise");
    expect(result.detail).toContain("does not prove");
  });

  it("flags an unblocked request as unexpected rather than fine", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null)));
    const result = await probeEgress(500);
    expect(result.verdict).toBe("not-blocked");
    expect(result.detail).toContain("unexpected");
  });

  it("gives up rather than hanging when nothing settles", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const result = await probeEgress(20);
    expect(result.verdict).toBe("failed-otherwise");
  });

  it("says so when the runtime cannot run the check", async () => {
    vi.stubGlobal("fetch", undefined);
    await expect(probeEgress(20)).resolves.toMatchObject({ verdict: "unsupported" });
  });

  it("only ever targets a reserved TLD, so nothing can leave the machine", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (url: string) => { seen.push(url); return Promise.reject(new TypeError("no")); });
    await probeEgress(200);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]).hostname.endsWith(".invalid")).toBe(true);
  });
});
