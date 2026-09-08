/**
 * Reading and demonstrating the window's network policy.
 *
 * The point of this module is that the no-network claim can be *shown* rather
 * than asserted: the browser reports its own policy violations, so a blocked
 * request is evidence from the runtime rather than a sentence in a settings
 * page.
 */

export interface CspDirective {
  name: string;
  values: string[];
  meaning: string;
}

/** Plain-English descriptions of the directives this build actually sets. */
const MEANINGS: Record<string, string> = {
  "default-src": "The fallback for everything not named below.",
  "connect-src": "Where scripts may send requests. Only the local IPC bridge — not even this origin.",
  "img-src": "Where images may load from. No remote host, so a tracking pixel in an opened file cannot load.",
  "media-src": "Where audio and video may load from.",
  "worker-src": "Where background workers may be loaded from.",
  "style-src": "Where stylesheets may come from. Inline styles are allowed; remote ones are not.",
  "font-src": "Where fonts may load from. No remote font can be fetched.",
  "object-src": "Plugins and embedded objects. 'none' forbids them entirely.",
  "frame-src": "Nested frames. 'none' forbids them entirely.",
  "base-uri": "Restricts <base>, so injected markup cannot re-point relative URLs.",
  "form-action": "Where forms may submit. 'none' means nowhere.",
  "script-src": "Where scripts may be loaded from.",
};

/** Splits a policy string into its directives, in the order it declares them. */
export function parseCsp(csp: string): CspDirective[] {
  return csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/);
      return { name, values, meaning: MEANINGS[name] ?? "" };
    });
}

/** True when a directive forbids every source. */
export function forbidsEverything(directive: CspDirective): boolean {
  return directive.values.length === 1 && directive.values[0] === "'none'";
}

/** True when a directive permits no remote origin. */
export function allowsNoRemoteHost(directive: CspDirective): boolean {
  return directive.values.every((value) => !/^https?:\/\/(?!ipc\.localhost)/.test(value.replace(/'/g, "")));
}

export type EgressVerdict = "blocked-by-policy" | "failed-otherwise" | "not-blocked" | "unsupported";

export interface EgressResult {
  verdict: EgressVerdict;
  directive: string | null;
  blockedUri: string | null;
  detail: string;
}

/**
 * A reserved TLD from RFC 2606. It can never resolve, so even if the content
 * policy were missing entirely, no packet could reach a real host — the check
 * is safe to run and sends nothing anywhere.
 */
const PROBE_URL = "https://egress-check.invalid/oneopen";

/**
 * Tries one outbound request and reports what stopped it.
 *
 * Only ever called from an explicit button press. A content-policy violation is
 * the signal we want: the browser itself refusing the connection is stronger
 * evidence than the request merely failing, which could just be DNS.
 */
export function probeEgress(timeoutMs = 2000): Promise<EgressResult> {
  if (typeof fetch !== "function" || typeof document === "undefined") {
    return Promise.resolve({
      verdict: "unsupported", directive: null, blockedUri: null,
      detail: "This runtime cannot perform the check.",
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let violation: SecurityPolicyViolationEvent | null = null;

    const onViolation = (event: Event) => {
      const candidate = event as SecurityPolicyViolationEvent;
      if (candidate.blockedURI && PROBE_URL.startsWith(candidate.blockedURI.split("?")[0].slice(0, 24))) {
        violation = candidate;
      } else if (!violation) {
        violation = candidate;
      }
    };
    document.addEventListener("securitypolicyviolation", onViolation);

    const finish = (result: EgressResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      resolve(result);
    };

    const timer = window.setTimeout(() => finish({
      verdict: "failed-otherwise", directive: null, blockedUri: null,
      detail: "The request neither completed nor reported a policy violation before the timeout.",
    }), timeoutMs);

    void fetch(PROBE_URL, { mode: "no-cors", cache: "no-store" })
      .then(() => finish({
        verdict: "not-blocked", directive: null, blockedUri: PROBE_URL,
        detail: "The request was not refused by the content policy. That is unexpected for this build.",
      }))
      .catch(() => {
        // The violation event fires just before the fetch rejects.
        window.setTimeout(() => finish(violation
          ? {
              verdict: "blocked-by-policy",
              directive: violation.violatedDirective || violation.effectiveDirective || "connect-src",
              blockedUri: violation.blockedURI || PROBE_URL,
              detail: "The window refused the connection before it left the process.",
            }
          : {
              verdict: "failed-otherwise", directive: null, blockedUri: PROBE_URL,
              detail: "The request failed, but no content-policy violation was reported — so this does not prove the policy blocked it.",
            }), 0);
      });
  });
}
