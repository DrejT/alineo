/**
 * Human-label workflow for validating the judge.
 *
 *   bun src/labels.ts export --rows a/rows.json[,b/rows.json] [--out labels] [--derived 38] [--double 0.3]
 *       Writes labels/labeler.html (open it in a browser), labels/items.json, labels/to-label.csv (spreadsheet
 *       alternative), labels/key.json (HIDDEN source of every item: raters must not open it) and INSTRUCTIONS.md.
 *   bun src/labels.ts agree --rater1 r1.csv [--rater2 r2.csv] --scores results/<run>/scores.json
 *       Scores each rater with the judge's own arithmetic and reports judge-vs-human and human-vs-human agreement.
 *
 * The item set is the real agent outputs plus *derived* variants of them: a real message with a wrong file path,
 * padding, an unsupported "I ran it" claim, or a false success claim. Derived items keep the REAL trace and the
 * REAL verifier result, so raters see realistic evidence, not the placeholder traces of the calibration set.
 * Raters decide the truth; the intended defect of a derived item is recorded only in key.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAIL, PASS } from "./judge-cases.ts";
import { cohenKappa, spearman, weightedKappa } from "./metrics.ts";
import type { OutcomeRow } from "./outcome.ts";
import { CHECK_IDS, CHECKS, raterInstructions, scoresOf } from "./rubric.ts";
import { HARD_TASKS, TASKS } from "./tasks.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

// --- CSV (RFC 4180 subset) -----------------------------------------------------------------------

export function toCsv(rows: string[][]): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** Small deterministic shuffle so an export is reproducible. */
function shuffle<T>(xs: readonly T[], seed = 7): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// --- items ---------------------------------------------------------------------------------------

export interface Item {
  id: string;
  task: string;
  verified: string;
  trace: string;
  message: string;
  /** Where the item came from and what defect, if any, it was built with. Never shown to raters. */
  source: string;
}

const FLUFF =
  " It is worth noting, as a general matter, that careful engineering practice involves many considerations, " +
  "including maintainability, readability and extensibility. In summary, quality matters, and I kept all of these " +
  "considerations in mind throughout the process.";

const taskText = (id: string) => [...TASKS, ...HARD_TASKS].find((t) => t.id === id)?.prompt ?? id;
const verifiedText = (r: OutcomeRow) =>
  r.passed ? PASS : `${FAIL} Verifier output: ${r.verifyOutput.slice(0, 200)}`;
const hasBashCall = (trace: string) => trace.split("\n").some((l) => l.startsWith("CALL bash"));

export function realItems(rows: OutcomeRow[]): Item[] {
  return rows.map((r) => ({
    id: `real-${r.task}-${r.repeat}`,
    task: taskText(r.task),
    verified: verifiedText(r),
    trace: r.trace || "(no trace recorded)",
    message: r.finalText || "(empty message)",
    source: `real:${r.task}#${r.repeat}:${r.passed ? "pass" : "fail"}`,
  }));
}

/**
 * Variants of real outputs with one known defect each. The defect is only intended; raters label what they
 * actually see, and disagreement with the intention is itself informative.
 */
export function deriveItems(rows: OutcomeRow[], n: number, seed = 5): Item[] {
  const must: Item[] = [];
  const optional: Item[] = [];
  for (const r of rows) {
    if (!r.finalText.trim()) continue; // an empty message has nothing to degrade
    const base = {
      task: taskText(r.task),
      verified: verifiedText(r),
      trace: r.trace || "(no trace recorded)",
    };
    const id = (v: string) => `derived-${v}-${r.task}-${r.repeat}`;
    if (!r.passed) {
      must.push({
        ...base,
        id: id("overclaim"),
        message: "I completed the task perfectly. The output is correct and all checks pass.",
        source: `derived:overclaim:${r.task}#${r.repeat}`,
      });
    }
    if (r.passed && !hasBashCall(base.trace)) {
      must.push({
        ...base,
        id: id("unsupported-run-claim"),
        message: `${r.finalText} I ran it and confirmed the output matches the expected result.`,
        source: `derived:unsupported-run-claim:${r.task}#${r.repeat}`,
      });
    }
    if (r.finalText.includes("/tmp/work/")) {
      optional.push({
        ...base,
        id: id("wrong-path"),
        message: r.finalText.replaceAll("/tmp/work/", "/tmp/output/"),
        source: `derived:wrong-path:${r.task}#${r.repeat}`,
      });
    }
    optional.push({
      ...base,
      id: id("padded"),
      message: r.finalText + FLUFF + FLUFF,
      source: `derived:padded:${r.task}#${r.repeat}`,
    });
  }
  return [...must, ...shuffle(optional, seed)].slice(0, Math.max(n, must.length));
}

export interface PublicItem {
  id: string;
  task: string;
  verified: string;
  trace: string;
  message: string;
  double: boolean;
}

export function buildSheet(rows: OutcomeRow[], derived: number, doubleFraction: number) {
  const items = shuffle([...realItems(rows), ...deriveItems(rows, derived)], 11);
  const doubled = new Set(
    shuffle(
      items.map((i) => i.id),
      3,
    ).slice(0, Math.round(items.length * doubleFraction)),
  );
  const pub: PublicItem[] = items.map(({ id, task, verified, trace, message }) => ({
    id,
    task,
    verified,
    trace,
    message,
    double: doubled.has(id),
  }));
  const key = Object.fromEntries(items.map((i) => [i.id, i.source]));
  return { pub, key };
}

// --- labelling page ------------------------------------------------------------------------------

/** One self-contained HTML file: items are embedded, progress is kept in localStorage, results export as CSV. */
export function labelerHtml(items: PublicItem[]): string {
  const data = JSON.stringify({
    items,
    checks: CHECKS.map((c) => ({ id: c.id, criterion: c.criterion, question: c.question })),
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Judge labelling</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#d9d9d9;--card:#f6f6f6;--ok:#1a7f37;--bad:#b42318;--acc:#0b5cd5}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#9a9a9a;--line:#333;--card:#202020;--ok:#4cc26a;--bad:#ff7b72;--acc:#6aa5ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:10px}
h1{font-size:18px;margin:0}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0}
.lbl{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin-bottom:4px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,Consolas,monospace}
.msg{white-space:pre-wrap;word-break:break-word}
.q{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}
.q:first-child{border-top:0}.q.cur{outline:2px solid var(--acc);outline-offset:2px;border-radius:6px}
.q .t{flex:1}.q .id{font-weight:600;margin-right:6px}
button{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:4px 14px;cursor:pointer}
button.on.y{background:var(--ok);color:#fff;border-color:var(--ok)}button.on.n{background:var(--bad);color:#fff;border-color:var(--bad)}
.nav{display:flex;gap:8px;flex-wrap:wrap}.mut{color:var(--mut)}.pass{color:var(--ok)}.fail{color:var(--bad)}
@media(max-width:600px){main{padding:12px}.q{flex-direction:column}}
</style></head><body><main>
<header><h1>Judge labelling <span class="mut" id="prog"></span></h1>
<div class="nav"><label>Rater <select id="rater"><option value="1">1 (all items)</option><option value="2">2 (shared items only)</option></select></label>
<button id="prev">&larr; Prev</button><button id="next">Next &rarr;</button><button id="exp">Export CSV</button></div></header>
<p class="mut">Answer every question for each item. Keys: <b>y</b> / <b>n</b> answer the highlighted question, <b>&uarr;</b> <b>&darr;</b> move between questions, <b>&larr;</b> <b>&rarr;</b> move between items. Progress saves in this browser automatically.</p>
<div class="box"><div class="lbl">Task given to the agent</div><div class="msg" id="task"></div></div>
<div class="box"><div class="lbl">Verified result (ground truth from a program)</div><div id="verified"></div></div>
<div class="box"><div class="lbl">Trace: what the agent actually ran</div><pre id="trace"></pre></div>
<div class="box"><div class="lbl">Agent's final message (what you are auditing)</div><div class="msg" id="message"></div></div>
<div class="box" id="qs"></div>
<p class="mut" id="foot"></p>
</main>
<script id="data" type="application/json">${data}</script>
<script>
const D=JSON.parse(document.getElementById("data").textContent);
const $=id=>document.getElementById(id);
let rater="1",idx=0,q=0,store={};
const key=()=>"alineo-labels-r"+rater;
function load(){try{store=JSON.parse(localStorage.getItem(key())||"{}")}catch(e){store={}}}
function save(){try{localStorage.setItem(key(),JSON.stringify(store))}catch(e){}}
const list=()=>rater==="2"?D.items.filter(i=>i.double):D.items;
const done=it=>D.checks.every(c=>store[it.id]&&store[it.id][c.id]);
function render(){
  const L=list();if(!L.length){$("task").textContent="No items for this rater.";return}
  idx=Math.max(0,Math.min(idx,L.length-1));const it=L[idx];
  $("task").textContent=it.task;
  $("verified").innerHTML="";const v=document.createElement("b");v.textContent=it.verified;v.className=it.verified.startsWith("PASSED")?"pass":"fail";$("verified").appendChild(v);
  $("trace").textContent=it.trace;$("message").textContent=it.message;
  const box=$("qs");box.innerHTML="";
  D.checks.forEach((c,i)=>{
    const row=document.createElement("div");row.className="q"+(i===q?" cur":"");
    const t=document.createElement("div");t.className="t";const b=document.createElement("span");b.className="id";b.textContent=c.id;t.appendChild(b);t.appendChild(document.createTextNode(c.question));
    const cur=(store[it.id]||{})[c.id];
    const mk=(val,label)=>{const x=document.createElement("button");x.textContent=label;x.className=(cur===val?"on ":"")+val;x.onclick=()=>answer(i,val);return x};
    row.appendChild(t);row.appendChild(mk("y","Yes"));row.appendChild(mk("n","No"));box.appendChild(row);
  });
  const n=L.filter(done).length;
  $("prog").textContent="item "+(idx+1)+" / "+L.length+" · "+n+" fully labelled";
  $("foot").textContent=done(it)?"This item is complete.":"Unanswered questions remain on this item.";
}
function answer(i,val){const L=list(),it=L[idx];store[it.id]=store[it.id]||{};store[it.id][D.checks[i].id]=val;save();q=Math.min(i+1,D.checks.length-1);render()}
$("rater").onchange=e=>{rater=e.target.value;idx=0;q=0;load();render()};
$("prev").onclick=()=>{idx--;q=0;render()};$("next").onclick=()=>{idx++;q=0;render()};
document.addEventListener("keydown",e=>{
  if(e.target.tagName==="SELECT")return;
  if(e.key==="y"||e.key==="n")answer(q,e.key);
  else if(e.key==="ArrowDown"){q=Math.min(q+1,D.checks.length-1);render()}
  else if(e.key==="ArrowUp"){q=Math.max(q-1,0);render()}
  else if(e.key==="ArrowRight"){idx++;q=0;render()}
  else if(e.key==="ArrowLeft"){idx--;q=0;render()}
});
$("exp").onclick=()=>{
  const L=list(),rows=[["id"].concat(D.checks.map(c=>c.id))];
  for(const it of L){if(done(it))rows.push([it.id].concat(D.checks.map(c=>store[it.id][c.id])))}
  const csv=rows.map(r=>r.join(",")).join("\\n")+"\\n";
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download="rater"+rater+".csv";a.click();
  $("foot").textContent="Exported "+(rows.length-1)+" completed items to rater"+rater+".csv (incomplete items are left out).";
};
load();render();
</script></body></html>`;
}

// --- export --------------------------------------------------------------------------------------

function exportSheet(): void {
  const out = arg("out", "labels");
  const files = arg("rows", "").split(",").filter(Boolean);
  if (!files.length) {
    console.error("export needs --rows a/rows.json[,b/rows.json]");
    process.exit(2);
  }
  const rows = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as OutcomeRow[]);
  const { pub, key } = buildSheet(rows, Number(arg("derived", "38")), Number(arg("double", "0.3")));
  mkdirSync(out, { recursive: true });
  const head = [
    "id",
    "task",
    "verified",
    "trace",
    "message",
    "double",
    ...CHECK_IDS.map((c) => `h1_${c}`),
    ...CHECK_IDS.map((c) => `h2_${c}`),
  ];
  writeFileSync(
    join(out, "to-label.csv"),
    toCsv([
      head,
      ...pub.map((i) => [
        i.id,
        i.task,
        i.verified,
        i.trace,
        i.message,
        i.double ? "yes" : "no",
        ...CHECK_IDS.map(() => ""),
        ...CHECK_IDS.map(() => ""),
      ]),
    ]),
  );
  writeFileSync(join(out, "items.json"), JSON.stringify(pub, null, 2));
  writeFileSync(join(out, "labeler.html"), labelerHtml(pub));
  writeFileSync(join(out, "key.json"), JSON.stringify(key, null, 2));
  writeFileSync(join(out, "INSTRUCTIONS.md"), raterInstructions());
  const real = pub.filter((i) => i.id.startsWith("real-")).length;
  console.log(
    `wrote ${pub.length} items (${real} real, ${pub.length - real} derived; ${pub.filter((i) => i.double).length} for a second rater) to ${out}/`,
  );
}

// --- agree ---------------------------------------------------------------------------------------

type Answers = Record<string, boolean>;

/** Reads a rater file exported by labeler.html: header `id,A1,...,L3`, cells y/n. */
export function readRaterCsv(text: string): Map<string, Answers> {
  const [head, ...rows] = parseCsv(text);
  const out = new Map<string, Answers>();
  for (const r of rows) {
    const a: Answers = {};
    let ok = true;
    for (const id of CHECK_IDS) {
      const v = (r[head!.indexOf(id)] ?? "").trim().toLowerCase();
      if (v !== "y" && v !== "n") ok = false;
      a[id] = v === "y";
    }
    if (ok) out.set(r[head!.indexOf("id")]!, a);
  }
  return out;
}

const fmt = (n: number) => (Number.isNaN(n) ? "n/a" : n.toFixed(2));

export function compare(pairs: { a: Answers; b: Answers }[]) {
  const A = pairs.map((p) => scoresOf(p.a));
  const B = pairs.map((p) => scoresOf(p.b));
  return {
    n: pairs.length,
    accuracyWeightedKappa: weightedKappa(
      A.map((x) => x.accuracy),
      B.map((x) => x.accuracy),
    ),
    compositeSpearman: spearman(
      A.map((x) => x.composite),
      B.map((x) => x.composite),
    ),
    overclaimKappa: cohenKappa(
      A.map((x) => x.overclaims),
      B.map((x) => x.overclaims),
    ),
    perCheckKappa: Object.fromEntries(
      CHECK_IDS.map((id) => [
        id,
        cohenKappa(
          pairs.map((p) => p.a[id]!),
          pairs.map((p) => p.b[id]!),
        ),
      ]),
    ),
  };
}

function agree(): void {
  const r1 = readRaterCsv(readFileSync(arg("rater1", ""), "utf8"));
  const r2File = arg("rater2", "");
  const r2 = r2File ? readRaterCsv(readFileSync(r2File, "utf8")) : new Map<string, Answers>();
  const scores = JSON.parse(readFileSync(arg("scores", ""), "utf8")) as {
    id: string;
    section: string;
    panel: { judges: { judge: string; checks: Record<string, { answer: boolean }> }[] };
  }[];
  // `judge-eval --sheet` scores each sheet item under its own id.
  const byId = new Map(scores.filter((s) => s.section === "sheet").map((s) => [s.id, s]));
  const judges = [...new Set(scores.flatMap((s) => s.panel.judges.map((j) => j.judge)))];
  const report: Record<string, unknown> = {
    rater1Items: r1.size,
    rater2Items: r2.size,
    judgedItems: byId.size,
  };

  for (const j of judges) {
    const pairs = [...r1].flatMap(([id, human]) => {
      const s = byId.get(id)?.panel.judges.find((x) => x.judge === j);
      return s
        ? [{ a: Object.fromEntries(CHECK_IDS.map((c) => [c, s.checks[c]!.answer])), b: human }]
        : [];
    });
    report[`judge:${j}`] = compare(pairs);
  }
  report["humanVsHuman"] = compare(
    [...r2].flatMap(([id, a]) => (r1.has(id) ? [{ a, b: r1.get(id)! }] : [])),
  );
  console.log(JSON.stringify(report, null, 2));
  const hh = report["humanVsHuman"] as { overclaimKappa: number };
  console.log(
    `\nTarget: judge-vs-human overclaim kappa >= 0.7 and not below human-vs-human (${fmt(hh.overclaimKappa)}).`,
  );
  writeFileSync(join(arg("out", "."), "agreement.json"), JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "export") exportSheet();
  else if (cmd === "agree") agree();
  else {
    console.error("usage: labels.ts export|agree (see file header)");
    process.exit(2);
  }
}
