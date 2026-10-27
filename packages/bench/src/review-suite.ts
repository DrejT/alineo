/**
 * Code-review suite. Six small Python modules with two seeded bugs each (12 bugs) and one clean module as a
 * precision control. Every fixture is a (buggy, fixed, test) triple: the test fails on the buggy code and passes on
 * the fixed code, which `selftest.ts` proves in a container, so no bug here is imaginary. Reviews are scored by
 * code: recall is the share of seeded bugs found at (about) the right line, precision the share of findings that
 * point at a real bug.
 */

export interface Fixture {
  file: string;
  /** Source with ` # BUG` markers on buggy lines. Markers are stripped from what the agent sees. */
  marked: string;
  /** Same module with the bugs fixed. */
  fixed: string;
  /** Python that passes on `fixed` and fails on the buggy code (run next to the module). */
  test: string;
}

export const FIXTURES: Fixture[] = [
  {
    file: "inventory.py",
    marked: `def add_item(stock, name, qty):
    stock[name] = stock.get(name, 0) + qty
    return stock


def remove_item(stock, name, qty):
    stock[name] = stock.get(name, 0) - qty  # BUG
    return stock


def total_value(stock, prices):
    total = 0
    for name, qty in stock.items():
        total += qty + prices[name]  # BUG
    return total
`,
    fixed: `def add_item(stock, name, qty):
    stock[name] = stock.get(name, 0) + qty
    return stock


def remove_item(stock, name, qty):
    if stock.get(name, 0) < qty:
        raise ValueError("not enough stock")
    stock[name] = stock.get(name, 0) - qty
    return stock


def total_value(stock, prices):
    total = 0
    for name, qty in stock.items():
        total += qty * prices[name]
    return total
`,
    test: `from inventory import remove_item, total_value
try:
    remove_item({"a": 1}, "a", 5)
    raise SystemExit("negative stock allowed")
except ValueError:
    pass
assert total_value({"a": 2}, {"a": 5}) == 10
print("ok")
`,
  },
  {
    file: "stats2.py",
    marked: `def average(xs):
    return sum(xs) / len(xs)  # BUG


def max_run(xs):
    if not xs:
        return 0
    best = cur = 1
    for i in range(1, len(xs)):
        if xs[i] == xs[i - 1]:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0  # BUG
    return best
`,
    fixed: `def average(xs):
    if not xs:
        return 0.0
    return sum(xs) / len(xs)


def max_run(xs):
    if not xs:
        return 0
    best = cur = 1
    for i in range(1, len(xs)):
        if xs[i] == xs[i - 1]:
            cur += 1
            best = max(best, cur)
        else:
            cur = 1
    return best
`,
    test: `from stats2 import average, max_run
assert average([]) == 0.0
assert max_run([1, 2, 2, 3]) == 2
print("ok")
`,
  },
  {
    file: "dates2.py",
    marked: `def is_leap(y):
    return y % 4 == 0 and y % 100 != 0  # BUG


def days_in_month(y, m):
    days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if m == 2 and is_leap(y):
        return 29
    return days[m]  # BUG
`,
    fixed: `def is_leap(y):
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def days_in_month(y, m):
    days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if m == 2 and is_leap(y):
        return 29
    return days[m - 1]
`,
    test: `from dates2 import is_leap, days_in_month
assert is_leap(2000) is True
assert days_in_month(2023, 1) == 31
print("ok")
`,
  },
  {
    file: "text2.py",
    marked: `def word_count(s):
    return len(s.split(" "))  # BUG


def truncate(s, n):
    if len(s) <= n:
        return s
    return s[:n] + "..."  # BUG
`,
    fixed: `def word_count(s):
    return len(s.split())


def truncate(s, n):
    if len(s) <= n:
        return s
    return s[: n - 3] + "..."
`,
    test: `from text2 import word_count, truncate
assert word_count("a  b") == 2
assert len(truncate("abcdefghij", 8)) == 8
print("ok")
`,
  },
  {
    file: "cart.py",
    marked: `def apply_discount(price, pct):
    return price - price * pct  # BUG


def split_bill(total, people):
    return round(total / people, 2)  # BUG
`,
    fixed: `def apply_discount(price, pct):
    return price - price * pct / 100


def split_bill(total, people):
    if people <= 0:
        raise ValueError("people must be positive")
    return round(total / people, 2)
`,
    test: `from cart import apply_discount, split_bill
assert apply_discount(200, 10) == 180
try:
    split_bill(10, 0)
    raise SystemExit("no error")
except ValueError:
    pass
print("ok")
`,
  },
  {
    file: "queue2.py",
    marked: `class Queue:
    def __init__(self):
        self.items = []

    def push(self, x):
        self.items.append(x)

    def pop(self):
        return self.items.pop()  # BUG

    def peek(self):
        return self.items[1]  # BUG
`,
    fixed: `class Queue:
    def __init__(self):
        self.items = []

    def push(self, x):
        self.items.append(x)

    def pop(self):
        return self.items.pop(0)

    def peek(self):
        return self.items[0]
`,
    test: `from queue2 import Queue
q = Queue()
q.push(1)
q.push(2)
assert q.peek() == 1
assert q.pop() == 1
print("ok")
`,
  },
];

/** A correct module: any finding on it is a false positive. */
export const CLEAN_FILE = {
  file: "clean.py",
  source: `def clamp(x, lo, hi):
    if lo > hi:
        raise ValueError("lo must not exceed hi")
    return max(lo, min(x, hi))


def gcd(a, b):
    while b:
        a, b = b, a % b
    return abs(a)
`,
};

export interface SeededBug {
  file: string;
  line: number;
}

const stripMarker = (line: string) => line.replace(/\s+# BUG$/, "");

/** What the agent sees (no markers), the seeded bug locations, and the full file set. */
export function buildRepo(): { files: Record<string, string>; bugs: SeededBug[] } {
  const files: Record<string, string> = {};
  const bugs: SeededBug[] = [];
  for (const f of FIXTURES) {
    const lines = f.marked.split("\n");
    lines.forEach((l, i) => {
      if (/\s# BUG$/.test(l)) bugs.push({ file: f.file, line: i + 1 });
    });
    files[f.file] = lines.map(stripMarker).join("\n");
  }
  files[CLEAN_FILE.file] = CLEAN_FILE.source;
  return { files, bugs };
}

export interface Finding {
  file: string;
  line: number;
  issue?: string;
}

/** Tolerant parse of the agent's review.json: finds the first JSON array of objects with file and line. */
export function parseFindings(text: string): Finding[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown[];
    return arr.flatMap((x) => {
      const o = x as { file?: unknown; line?: unknown; issue?: unknown };
      const line = typeof o.line === "number" ? o.line : Number(o.line);
      return typeof o.file === "string" && Number.isFinite(line)
        ? [{ file: o.file.replace(/^.*\//, ""), line, ...(typeof o.issue === "string" ? { issue: o.issue } : {}) }]
        : [];
    });
  } catch {
    return [];
  }
}

export interface ReviewScore {
  bugs: number;
  found: number;
  findings: number;
  truePositives: number;
  recall: number;
  precision: number;
  f1: number;
  falsePositivesOnCleanFile: number;
}

/**
 * A finding matches a seeded bug when it names the same file and a line within `tolerance` of the bug. Each bug is
 * credited once, each finding counted once; findings on the clean file or at no bug are false positives.
 */
export function scoreReview(findings: Finding[], bugs: SeededBug[], tolerance = 2): ReviewScore {
  const credited = new Set<number>();
  let tp = 0;
  for (const f of findings) {
    const idx = bugs.findIndex((b, i) => !credited.has(i) && b.file === f.file && Math.abs(b.line - f.line) <= tolerance);
    if (idx >= 0) {
      credited.add(idx);
      tp++;
    }
  }
  const recall = bugs.length ? credited.size / bugs.length : 0;
  const precision = findings.length ? tp / findings.length : 0;
  return {
    bugs: bugs.length,
    found: credited.size,
    findings: findings.length,
    truePositives: tp,
    recall,
    precision,
    f1: recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision),
    falsePositivesOnCleanFile: findings.filter((f) => f.file === CLEAN_FILE.file).length,
  };
}

export const REVIEW_PROMPT =
  "Review the Python files in /tmp/work/repo and find real bugs: code that gives wrong results or crashes on valid " +
  "input. Ignore style. Write /tmp/work/review.json as a JSON array of objects " +
  '{"file": "name.py", "line": <line number of the buggy line>, "issue": "<short description>"}. ' +
  "Report only genuine bugs. Do not modify any code. Then reply with one sentence.";
