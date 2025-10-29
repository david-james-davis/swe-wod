import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import "dotenv/config";

type WodEntry = {
  word: string;
  partOfSpeech?: string;
  definition: string;
  example?: string;
  date: string; // YYYY-MM-DD
  hash?: number;
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4.1-mini";

const todayISO = new Date().toISOString().slice(0, 10);
const OUT_PATH = path.join(process.cwd(), "public", "wod.json");

// Policy knobs
const MAX_DAYS: number | undefined = 365; // keep last N (or undefined = keep all)
const NO_REPEAT_WINDOW_DAYS = 30;         // do not repeat within this many days
const MAX_MODEL_ATTEMPTS = 4;             // how many re-tries if model returns a dup

// A small fallback pool to guarantee progress if the model is stubborn:
const FALLBACK_TERMS = [
  "throughput","idempotent","circuit breaker","backpressure","debounce",
  "throttling","eventual consistency","memoization","race condition","retry jitter",
  "dead letter queue","quorum","canary release","blue-green deployment","hedging",
  "saga","bulkhead","fan-out","fan-in","poison pill"
];

function dayHash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const normalize = (w: string) => w.trim().toLowerCase();

async function readHistory(): Promise<WodEntry[]> {
  try {
    const buf = await fs.readFile(OUT_PATH, "utf8");
    const parsed = JSON.parse(buf);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(entries: WodEntry[]) {
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed =
    typeof MAX_DAYS === "number" && entries.length > MAX_DAYS
      ? entries.slice(-MAX_DAYS)
      : entries;
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
}

function pickFallback(exclusions: Set<string>): string | null {
  const candidates = FALLBACK_TERMS.filter(t => !exclusions.has(normalize(t)));
  if (candidates.length === 0) return null;
  // deterministically vary by day so it’s stable per-day run
  const idx = dayHash(todayISO) % candidates.length;
  return candidates[idx];
}

async function fetchEntry(exclusions: Set<string>): Promise<WodEntry> {
  const excludedList = Array.from(exclusions).sort().join(", ");
  const mustNot = excludedList
    ? `You MUST NOT return any of these terms: ${excludedList}.`
    : `Avoid repeating recent days.`;

  const system = `
    You generate ONE software engineering TERM OF THE DAY.

    Constraints:
    - Useful, common engineering jargon only (e.g., "throughput", "idempotent", "circuit breaker", "debounce").
    - Concise, standard definition (1–2 sentences) and a short engineering example.
    - Include partOfSpeech if obvious (noun/verb/adjective). No brands, people, NSFW or political content.
    - Output STRICT JSON with keys: word, partOfSpeech, definition, example, date (YYYY-MM-DD).
    - Date must be ${todayISO}.
    - ${mustNot}
    `.trim();

  const user = `Generate today's SWE term with definition & example.`;

  const r = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    // You could also add low temperature for consistency:
    // temperature: 0.2,
  });

  const jsonText = r.choices[0]?.message?.content ?? "";
  if (!jsonText) throw new Error("No output from model");
  const entry = JSON.parse(jsonText) as WodEntry;

  entry.date = todayISO;
  entry.hash = dayHash(todayISO);
  return entry;
}

async function main() {
  const history = await readHistory();

  // Idempotency: if today's date already exists, do nothing.
  if (history.some(e => e.date === todayISO)) {
    console.log(`wod.json already contains ${todayISO}; no change.`);
    await writeHistory(history);
    return;
  }

  // Build the exclusion set for the last N days
  const recent = history.slice(-NO_REPEAT_WINDOW_DAYS);
  const exclusions = new Set(recent.map(e => normalize(e.word)));

  // Try the model a few times to avoid duplicates
  let entry: WodEntry | null = null;
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    const candidate = await fetchEntry(exclusions);
    if (!exclusions.has(normalize(candidate.word))) {
      entry = candidate;
      break;
    }
    console.warn(
      `Attempt ${attempt}: model returned recent duplicate "${candidate.word}". Retrying...`
    );
  }

  // Fallback: pick from curated list if still duplicate after retries
  if (!entry) {
    const picked = pickFallback(exclusions);
    if (!picked) {
      throw new Error("No available fallback terms; expand FALLBACK_TERMS.");
    }
    entry = {
      word: picked,
      partOfSpeech: "noun",
      definition:
        "A commonly used software engineering term (fallback). See project docs for definition details.",
      example: "Consult the project’s glossary for the canonical definition.",
      date: todayISO,
      hash: dayHash(todayISO),
    };
    console.log(`Using fallback term: ${picked}`);
  }

  history.push(entry);
  await writeHistory(history);
  console.log(`Appended ${entry.word} for ${todayISO}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});