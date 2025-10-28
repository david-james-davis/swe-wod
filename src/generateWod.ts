import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import "dotenv/config";

type WodEntry = {
    word: string;
    partOfSpeech?: string;
    definition: string;
    example?: string;
    date: string;
    hash?: number;
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = "gpt-4.1-mini"

const todayISO = new Date().toISOString().slice(0, 10)
const OUTPUT_PATH = path.join(process.cwd(), "public", "wod.json")
const MAX_DAYS: number | undefined = 365

function dayHash(s: string) {
    let h = 0
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h)
    }
}

async function readHistory(): Promise<WodEntry[]> {
    try {
        const buf = await fs.readFile(OUTPUT_PATH, "utf8")
        const parsed = JSON.parse(buf)
        return Array.isArray(parsed) ? parsed : []
    } catch (error) {
        return []
    }
}

async function writeHistory(entries: WodEntry[]) {
    entries.sort((a, b) => a.date.localeCompare(b.date))

    const trimmed = typeof MAX_DAYS === "number" && entries.length > MAX_DAYS
        ? entries.slice(-MAX_DAYS)
        : entries;

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
    await fs.writeFile(OUTPUT_PATH, JSON.stringify(trimmed, null, 2) + "\n", "utf8")
}

// @ts-ignore
async function fetchTodaysEntry(): Promise<WodEntry> {
    const system = `
    You are generating a single software engineering TERM OF THE DAY.
    Constraints:
    - Prefer jargon useful in everyday SWE/team discussions (e.g., "throughput", "idempotent", "circuit breaker", "debounce").
    - Avoid profanity, people, brands, NSFW, or political content.
    - Use concise, standard definitions (1–2 sentences) and a short engineering-relevant example.
    - Include part of speech if obvious (noun/verb/adjective).
    - Do NOT invent nonstandard terms.
    Output strictly JSON with keys: word, partOfSpeech, definition, example, date (YYYY-MM-DD).
    Date must be ${todayISO}.
    `.trim();

    const user = `Generate today's SWE word. Pick a different one if it was used recently.`;

    const response = await client.chat.completions.create({
        model: MODEL,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user }
        ],
        response_format: { type: "json_object" },
    })

    const jsonText = response.choices[0]?.message?.content ?? "";

    if (!jsonText) throw new Error("No output from model");

    const entry = JSON.parse(jsonText) as WodEntry;
    entry.date = todayISO;
    entry.hash = dayHash(todayISO);
    return entry;
}

async function main() {
    const history = await readHistory();

    // Skip if today's date exists already (idempotent reruns)
    const already = history.find(e => e.date === todayISO);
    if (already) {
        console.log(`wod.json already contains ${todayISO}; no change.`);
        await writeHistory(history);
        return;
    }

    const todayEntry = await fetchTodaysEntry();
    history.push(todayEntry);
    await writeHistory(history);
    console.log(`Appended WOD for ${todayISO}: ${todayEntry.word}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
