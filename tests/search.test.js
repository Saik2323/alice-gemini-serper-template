import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/index.js";

async function invoke(command) {
  let payload;
  await handler({ method: "POST", body: { request: { command } } }, {
    status() { return this; }, json(value) { payload = value; }, setHeader() {}
  });
  return payload;
}

function setup(t, fetch) {
  const previous = { gemini: process.env.GEMINI_API_KEY, serper: process.env.SERPER_API_KEY };
  process.env.GEMINI_API_KEY = "test-only";
  process.env.SERPER_API_KEY = "test-only";
  t.mock.method(globalThis, "fetch", fetch);
  t.after(() => {
    for (const [key, value] of [["GEMINI_API_KEY", previous.gemini], ["SERPER_API_KEY", previous.serper]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("search slower than the old 600ms limit reaches Gemini", async t => {
  setup(t, async (url, options) => {
    if (url.includes("serper.dev")) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 750);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
      return Response.json({ organic: [{ title: "Serper", snippet: "Google Search API", link: "https://serper.dev" }] });
    }
    assert.match(JSON.parse(options.body).contents.at(-1).parts[0].text, /Google Search API/);
    return Response.json({ candidates: [{ content: { parts: [{ text: "Serper предоставляет API поиска." }] } }] });
  });
  const result = await invoke("Найди сайт Serper");
  assert.equal(result.response.text, "Serper предоставляет API поиска.");
});

test("Gemini abort preserves the real search result and conversation", async t => {
  setup(t, async url => {
    if (url.includes("serper.dev")) return Response.json({ organic: [{ title: "Serper", snippet: "Google Search API" }] });
    throw new DOMException("This operation was aborted", "AbortError");
  });
  const result = await invoke("Найди сайт Serper");
  assert.match(result.response.text, /По результатам поиска, Serper: Google Search API/);
  assert.equal(result.session_state.history.length, 2);
});

test("failed search does not silently invent current information with Gemini", async t => {
  let calls = 0;
  setup(t, async () => { calls++; return Response.json({}, { status: 403 }); });
  const result = await invoke("Какая погода сегодня?");
  assert.equal(calls, 1);
  assert.match(result.response.text, /не удалось получить результаты поиска/);
});

test("ordinary Gemini abort gives a timeout message", async t => {
  setup(t, async () => { throw new DOMException("This operation was aborted", "AbortError"); });
  const result = await invoke("Сколько будет два плюс два?");
  assert.match(result.response.text, /Не успела подготовить ответ/);
});

test("Google overload is reported separately from a key or timeout error", async t => {
  setup(t, async () => Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 }));
  const result = await invoke("Расскажи про Луну");
  assert.match(result.response.text, /Gemini сейчас перегружен/);
});
