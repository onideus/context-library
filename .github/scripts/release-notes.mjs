// Builds RELEASE_NOTES.md for release.yml: what changed since the previous
// release (from squash-merge subjects, grouped by conventional-commit prefix),
// the security alerts fixed in that window, the release-time Trivy result,
// and the exact image. No dependencies: runs on the runner's Node.
//
// Env:
//   VERSION        version being released, without "v"
//   FULL_SHA       commit being released (must be on main)
//   IMAGE          image repository, e.g. ghcr.io/owner/name
//   IMAGE_DIGEST   repo@sha256:... of the pushed release image; empty on a dry run
//   TRIVY_REPORT   path to Trivy's JSON report of the release image (optional)
//   REPO           owner/name; SERVER_URL defaults to https://github.com
//   GITHUB_TOKEN   token with contents + security-events read (optional; without
//                  it the alert sections say they could not be read)
//   OUT            output path (default RELEASE_NOTES.md)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const VERSION = need("VERSION");
const FULL_SHA = need("FULL_SHA");
const IMAGE = need("IMAGE");
const REPO = need("REPO");
const IMAGE_DIGEST = process.env.IMAGE_DIGEST ?? "";
const TRIVY_REPORT = process.env.TRIVY_REPORT ?? "";
const SERVER_URL = process.env.SERVER_URL ?? "https://github.com";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const OUT = process.env.OUT ?? "RELEASE_NOTES.md";
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const repoUrl = `${SERVER_URL}/${REPO}`;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const isAncestor = (a, b) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
};

// ── Range: previous stable release that is an ancestor of this commit ────────
const prevTag = git("tag", "-l", "v*", "--sort=-v:refname")
  .split("\n")
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && t !== `v${VERSION}`)
  .find((t) => isAncestor(t, FULL_SHA));
const range = prevTag ? `${prevTag}..${FULL_SHA}` : FULL_SHA;
const commits = git("log", "--first-parent", "--format=%H%x09%cI%x09%s", range)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, date, ...rest] = line.split("\t");
    return { sha, date, subject: rest.join("\t") };
  });

// ── Categorise squash-merge subjects ─────────────────────────────────────────
const SECTIONS = [
  ["breaking", "Breaking changes"],
  ["security", "Security"],
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["deps", "Dependencies"],
  ["ci", "CI & build"],
  ["docs", "Documentation"],
  ["maint", "Maintenance"],
  ["other", "Other changes"],
];
// A title that plainly describes a security fix goes under Security whatever its prefix.
const SECURITY_RE = /\b(security|vulnerab\w*|CVE-\d{4}-\d+|GHSA-[\w-]+|high-severity|critical\b.*\bfinding)/i;
const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

const groups = new Map(SECTIONS.map(([k]) => [k, []]));
for (const c of commits) {
  const m = c.subject.match(/^(.*?)\s*\(#(\d+)\)$/);
  const pr = m ? Number(m[2]) : null;
  const title = (m ? m[1] : c.subject).replace(/^\[Pipeline\]\s*/, "");
  if (/^chore(\([^)]*\))?:\s*bump version to /i.test(title)) continue; // legacy version-bump PRs
  const cc = title.match(CONVENTIONAL_RE);
  const type = cc?.[1].toLowerCase();
  const scope = cc?.[2]?.toLowerCase() ?? "";
  let key;
  if (cc?.[3]) key = "breaking";
  else if (SECURITY_RE.test(title) || type === "security" || scope === "security") key = "security";
  else if (!cc) key = "other";
  else if (/^deps(-dev)?$/.test(scope)) key = "deps";
  else if (type === "feat") key = "feat";
  else if (type === "fix") key = "fix";
  else if (type === "perf") key = "perf";
  else if (type === "ci" || type === "build") key = "ci";
  else if (type === "docs") key = "docs";
  else if (["chore", "test", "refactor", "style", "revert"].includes(type)) key = "maint";
  else key = "other";
  const ref = pr ? ` ([#${pr}](${repoUrl}/pull/${pr}))` : ` (\`${c.sha.slice(0, 7)}\`)`;
  groups.get(key).push(`- ${title}${ref}`);
}

// ── Security alerts fixed in this release's window ───────────────────────────
// A fix lands on main shortly after the merge that caused it, so the window
// runs from the first commit in this release to the first commit after it
// (or now, if this is main's head).
// git gives local offsets and GitHub gives UTC, so compare epoch milliseconds.
const windowStart = commits.length ? Date.parse(commits[commits.length - 1].date) : NaN;
const nextOnMain = git("log", "--first-parent", "--reverse", "--format=%cI", `${FULL_SHA}..origin/main`)
  .split("\n")
  .filter(Boolean)[0];
const windowEnd = nextOnMain ? Date.parse(nextOnMain) : Date.now();
const inWindow = (t) => {
  const ms = Date.parse(t ?? "");
  return ms >= windowStart && ms < windowEnd;
};

async function apiList(path) {
  if (!TOKEN) return { error: "no token" };
  const items = [];
  let url = `${API}${path}`;
  for (let page = 0; url && page < 10; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    items.push(...(await res.json()));
    url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return { items };
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 };
const bySeverity = (a, b) => (SEV_ORDER[a.sev] ?? 9) - (SEV_ORDER[b.sev] ?? 9);

const dependabot = await apiList(`/repos/${REPO}/dependabot/alerts?state=fixed&per_page=100`);
const depFixed = (dependabot.items ?? [])
  .filter((a) => inWindow(a.fixed_at))
  .map((a) => ({
    sev: a.security_advisory?.severity ?? "unknown",
    runtime: a.dependency?.scope !== "development",
    line:
      `**${(a.security_advisory?.severity ?? "unknown").toUpperCase()}** ` +
      `[${a.security_advisory?.ghsa_id}](${a.html_url}) \`${a.dependency?.package?.name}\`` +
      (a.security_vulnerability?.first_patched_version?.identifier
        ? ` (fixed in ${a.security_vulnerability.first_patched_version.identifier})`
        : "") +
      ` — ${a.security_advisory?.summary ?? ""}`,
  }))
  .sort(bySeverity);

const codeScanning = await apiList(`/repos/${REPO}/code-scanning/alerts?state=fixed&per_page=100`);
const csFixed = (codeScanning.items ?? [])
  .filter((a) => inWindow(a.fixed_at))
  .map((a) => {
    const sev = a.rule?.security_severity_level ?? a.rule?.severity ?? "unknown";
    return {
      sev,
      line:
        `**${sev.toUpperCase()}** [${a.tool?.name} #${a.number}](${a.html_url}) ` +
        `${a.rule?.description ?? a.rule?.id} — \`${a.most_recent_instance?.location?.path ?? "?"}\``,
    };
  })
  .sort(bySeverity);

// ── Release-time Trivy result ────────────────────────────────────────────────
let scanLines = ["- Scan report unavailable."];
if (TRIVY_REPORT && existsSync(TRIVY_REPORT)) {
  const report = JSON.parse(readFileSync(TRIVY_REPORT, "utf8"));
  const vulns = (report.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
  const count = (pred) => vulns.filter(pred).length;
  const hc = (v) => v.Severity === "HIGH" || v.Severity === "CRITICAL";
  const fixable = (v) => Boolean(v.FixedVersion);
  scanLines = [
    `- Fixable HIGH/CRITICAL: **${count((v) => hc(v) && fixable(v))}** (the release is blocked unless this is 0).`,
    `- Known HIGH/CRITICAL with no fix available upstream: ${count((v) => hc(v) && !fixable(v))} ` +
      `(mostly base-image OS packages; listed in \`trivy-report.json\`).`,
    `- All severities: ${["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
      .map((s) => `${s} ${count((v) => v.Severity === s)}`)
      .join(", ")}.`,
    `- Scanned ${report.CreatedAt ? `at ${report.CreatedAt.slice(0, 16).replace("T", " ")} UTC ` : ""}` +
      `with Trivy${report.Trivy?.Version ? ` ${report.Trivy.Version}` : ""}, OS and npm packages.`,
  ];
}

// ── Assemble ─────────────────────────────────────────────────────────────────
const short = FULL_SHA.slice(0, 7);
const today = new Date().toISOString().slice(0, 10);
const out = [];
out.push(`# Context Library v${VERSION}`, "");
out.push(
  `Released ${today} from [\`${short}\`](${repoUrl}/commit/${FULL_SHA})` +
    (prevTag ? `, ${commits.length} merged change${commits.length === 1 ? "" : "s"} since ${prevTag}.` : "."),
  "",
);

out.push("## Image", "");
out.push("```bash", `docker pull ${IMAGE}:${VERSION}`, "```", "");
out.push(
  IMAGE_DIGEST
    ? `Digest: \`${IMAGE_DIGEST.split("@")[1]}\` — pin with \`${IMAGE_DIGEST}\`.`
    : "Digest: assigned when the image is pushed (dry run).",
);
out.push(
  "",
  `The image is the one built and tested when \`${short}\` merged: it passed CI, the build-time ` +
    "Trivy scan and the release-time re-scan below. The release only adds the version to its config.",
  "",
);

out.push("## Security", "");
out.push("### Fixed in this release", "");
if (dependabot.error) out.push(`- Dependabot alerts could not be read (${dependabot.error}).`, "");
if (codeScanning.error) out.push(`- Code scanning alerts could not be read (${codeScanning.error}).`, "");
const fixedGroups = [
  ["In the released image (runtime dependencies)", depFixed.filter((x) => x.runtime)],
  ["In source code (code scanning)", csFixed],
  ["Development and build tooling only (not shipped in the image)", depFixed.filter((x) => !x.runtime)],
];
let anyFixed = false;
for (const [label, list] of fixedGroups) {
  if (!list.length) continue;
  anyFixed = true;
  out.push(`**${label}:**`, "", ...list.map((x) => `- ${x.line}`), "");
}
if (!anyFixed) out.push("- No Dependabot or code scanning alerts were closed by changes in this release.", "");
if (groups.get("security").length) {
  out.push("**Security-related changes:**", "", ...groups.get("security"), "");
}
out.push("### Release scan", "", ...scanLines, "");

out.push("## Changes", "");
let any = false;
for (const [key, heading] of SECTIONS) {
  if (key === "security") continue; // listed under Security above
  const items = groups.get(key);
  if (!items.length) continue;
  any = true;
  out.push(`### ${heading}`, "", ...items, "");
}
if (!any && !groups.get("security").length) out.push("- No merged changes.", "");
if (prevTag) out.push(`**Full changelog:** ${repoUrl}/compare/${prevTag}...v${VERSION}`, "");

out.push("## Attached files", "");
out.push("- `RELEASE_NOTES.md` — these notes.");
out.push("- `sbom.cdx.json` — CycloneDX SBOM of the release image: every OS and npm package it contains.");
out.push("- `trivy-report.json` — the release-time vulnerability scan of the image, all severities.");
out.push("");

writeFileSync(OUT, out.join("\n"));
console.log(`Wrote ${OUT}: ${commits.length} commits since ${prevTag ?? "the beginning"}, ` +
  `${depFixed.length} Dependabot + ${csFixed.length} code scanning alerts fixed.`);
