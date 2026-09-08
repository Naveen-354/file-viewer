import { useEffect, useState } from "react";
import { AlertTriangle, CloudOff, PlugZap, ShieldCheck, Wifi } from "lucide-react";
import { api } from "../services/tauri";
import type { EngineReport } from "../types/files";
import { allowsNoRemoteHost, forbidsEverything, parseCsp, probeEgress, type EgressResult } from "../utils/network";

/** Things a desktop app commonly sends home, and what OneOpen does about each. */
const ABSENT = [
  { name: "Usage analytics", detail: "No analytics SDK is compiled in and no event is recorded." },
  { name: "Crash reporting", detail: "There is no crash reporter. A panic is not captured, stored or sent." },
  { name: "Update checks", detail: "No updater and no background poll. New versions are installed by you." },
  { name: "Licence or activation calls", detail: "Nothing to activate; the app never contacts a server." },
  { name: "Remote fonts and stylesheets", detail: "Blocked by policy, so a file you open cannot pull one in." },
];

export function TelemetryPanel({ matches }: { matches: (...text: string[]) => boolean }) {
  const [report, setReport] = useState<EngineReport | null>(null);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<EgressResult | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.engineReport()
      .then((value) => { if (!cancelled) setReport(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, []);

  const runProbe = async () => {
    setProbing(true);
    setProbe(await probeEgress());
    setProbing(false);
  };

  const directives = report ? parseCsp(report.isolation.csp) : [];
  const noRemote = directives.length > 0 && directives.every(allowsNoRemoteHost);

  return (
    <>
      {error && <div className="modal-error">{error}</div>}

      {matches("network", "egress", "outbound", "policy", "offline", "airgap", "test") && (
        <section className="settings-card">
          <header><CloudOff size={14} /><div><strong>Outbound network</strong><small>What this window is permitted to contact.</small></div></header>

          <div className="setting-row">
            <span><strong>Permitted destinations</strong><small>The local IPC bridge that carries commands to the Rust core. Nothing else, including this origin.</small></span>
            <span className="engine-badge ok"><Wifi size={11} /> IPC only</span>
          </div>

          <div className="setting-row">
            <span>
              <strong>Verify it now</strong>
              <small>Attempts one request to a reserved <code>.invalid</code> hostname, which can never resolve, and reports what stopped it. Nothing is sent anywhere.</small>
            </span>
            <button className="icon-action labelled" disabled={probing} onClick={() => void runProbe()}>
              <PlugZap size={12} /> {probing ? "Testing…" : "Test egress"}
            </button>
          </div>

          {probe && (
            <div className={`egress-result ${probe.verdict}`}>
              <strong>
                {probe.verdict === "blocked-by-policy" && "Blocked by the content policy"}
                {probe.verdict === "failed-otherwise" && "Request failed — but not provably by the policy"}
                {probe.verdict === "not-blocked" && "Not blocked"}
                {probe.verdict === "unsupported" && "Could not run the check"}
              </strong>
              <span>{probe.detail}</span>
              {probe.directive && <em>violated {probe.directive}</em>}
            </div>
          )}
        </section>
      )}

      {matches("csp", "content security policy", "directive", "policy", "resources") && report && (
        <section className="settings-card">
          <header>
            <ShieldCheck size={14} />
            <div>
              <strong>Content security policy</strong>
              <small>Read from the configuration this build ships, directive by directive.</small>
            </div>
          </header>
          <div className="engine-table-wrap">
            <table className="engine-table wrap-cells">
              <thead><tr><th>Directive</th><th>Permits</th><th>Effect</th></tr></thead>
              <tbody>
                {directives.map((directive) => (
                  <tr key={directive.name}>
                    <td className="engine-module">{directive.name}</td>
                    <td className="engine-version">
                      {forbidsEverything(directive)
                        ? <span className="engine-runtime core">nothing</span>
                        : directive.values.join(" ")}
                    </td>
                    <td className="engine-formats">{directive.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {noRemote && (
            <p className="engine-note">
              No directive names a remote origin, so remote images, fonts, stylesheets, frames and
              connections are all refused — including ones embedded in a file you open.
            </p>
          )}
        </section>
      )}

      {matches("capability", "permission", "allowlist", "plugin", "command") && report && (
        <section className="settings-card">
          <header><ShieldCheck size={14} /><div><strong>Granted capabilities</strong><small>The {report.isolation.permissions.length} permissions this build grants its window.</small></div></header>
          <div className="engine-chips">
            {report.isolation.permissions.map((permission) => <span key={permission}>{permission}</span>)}
          </div>
          <p className="engine-note">
            Window management, event listening, and the open and save dialogs. None of them grants
            HTTP access, a shell, or general filesystem reach — those plugins are not compiled in,
            so there is no permission to revoke.
          </p>
        </section>
      )}

      {matches("telemetry", "analytics", "crash", "update", "tracking", "absent") && (
        <section className="settings-card">
          <header><CloudOff size={14} /><div><strong>What is not here</strong><small>The usual reasons a desktop app opens a socket.</small></div></header>
          <dl className="engine-facts wide">
            {ABSENT.map((entry) => (
              <div key={entry.name}><dt>{entry.name}</dt><dd>{entry.detail}</dd></div>
            ))}
          </dl>
          <p className="engine-note">
            <AlertTriangle size={11} />
            These are absent by construction rather than switched off, which is why the page offers
            nothing to toggle. There is no setting that could turn telemetry on.
          </p>
        </section>
      )}

      {matches("driver", "kernel", "wfp", "attestation", "claims", "not claimed") && (
        <section className="settings-card muted-card">
          <header><AlertTriangle size={14} /><div><strong>Not claimed</strong><small>How this is and is not enforced.</small></div></header>
          <ul className="doc-flags">
            <li className="off">No kernel driver and no Windows Filtering Platform rules</li>
            <li className="off">No packet counters, drop log or traffic graph — nothing is measured</li>
            <li className="off">No named-pipe IPC; Tauri&apos;s bridge is a local HTTP origin</li>
            <li className="off">No cryptographic attestation or signed session record</li>
            <li className="off">No certificate, CRL or OCSP handling — there is no TLS client here</li>
          </ul>
          <p className="muted">
            The guarantee is a policy the window enforces on itself, which is why the test above is
            worth running: it shows the policy refusing a connection. It binds this window only, and
            would not stop another program on this machine.
          </p>
        </section>
      )}
    </>
  );
}
