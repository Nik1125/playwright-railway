import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- config ---
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PORT = process.env.PORT || 3000;
const USER_DATA_DIR = process.env.USER_DATA_DIR || "/data/ig-profile"; // mount Railway Volume to /data
const DEFAULT_UA = process.env.DEFAULT_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- simple bearer auth middleware ---
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const h = req.headers.authorization || "";
  if (h !== `Bearer ${AUTH_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  next();
});

// --- one persistent context shared by all requests ---
let ctx;
async function ensureContext() {
  if (ctx && !ctx.isClosed?.()) return ctx;
  ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    viewport: { width: 1366, height: 800 },
    userAgent: DEFAULT_UA,
    locale: "ru-RU",
  });
  return ctx;
}

// tiny in-process queue to avoid tab races
let chain = Promise.resolve();
function enqueue(fn) {
  const job = chain.then(fn).catch((e) => { throw e; });
  chain = job.catch(() => {});
  return job;
}

// health
app.get("/health", async (_req, res) => {
  try {
    await ensureContext();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// seed cookies once (optional) — migrate from your browser
app.post("/seed-cookies", (req, res) => enqueue(async () => {
  const { cookies = [] } = req.body || {};
  const context = await ensureContext();
  if (Array.isArray(cookies) && cookies.length) {
    const mapped = cookies.map(c => ({
      name: c.name, value: String(c.value), domain: ".instagram.com", path: "/"
    }));
    await context.addCookies(mapped);
  }
  res.json({ ok: true, added: cookies.map(c => c.name) });
}));

// universal runner with few actions
app.post("/run", (req, res) => enqueue(async () => {
  const { action = "loginCheck", username, targetUser, needScreenshot = false } = req.body || {};
  const context = await ensureContext();

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  await page.setExtraHTTPHeaders({ "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" });

  const out = { action, ok: false, url: null, title: null };

  try {
    if (action === "loginCheck") {
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      out.url = page.url(); out.title = await page.title();
      out.apiStatus = await page.evaluate(async () => {
        try {
          const r = await fetch("/api/v1/accounts/edit/web_form_data/", { credentials: "include" });
          return r.status;
        } catch { return -1; }
      });
      out.isLoggedIn = out.apiStatus === 200;
      out.ok = true;

    } else if (action === "openSettings") {
      await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded" });
      try { await page.waitForSelector('form[action="/accounts/edit/"]', { timeout: 5000 }); out.ok = true; } catch {}
      out.url = page.url();

    } else if (action === "followersLinks") {
      if (!username) throw new Error("username required");
      await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: "domcontentloaded" });
      const sels = [
        `a[href='/${username}/followers/']`,
        `a[href^='/${username}/followers']`,
        `a[role='link'][href*='/followers']`,
        `a[href*='/followers']`,
      ];
      let clicked = false;
      for (const s of sels) {
        const loc = page.locator(s).first();
        if (await loc.count()) {
          try {
            await loc.scrollIntoViewIfNeeded();
            await Promise.race([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(()=>{}), loc.click()]);
            clicked = true; break;
          } catch {}
        }
      }
      if (!clicked) await page.goto(`https://www.instagram.com/${username}/followers/`, { waitUntil: "domcontentloaded" }).catch(()=>{});
      try { await page.locator('div[role="dialog"]').first().waitFor({ state: "visible", timeout: 7000 }); } catch {}
      out.links = await page.evaluate(() => {
        const root = document.querySelector('div[role="dialog"]') || document;
        const A = [...root.querySelectorAll('a[href^="/"]')];
        const arr = [];
        for (const a of A) {
          const h = a.getAttribute("href");
          if (!h) continue;
          if (/^\/(accounts|explore|p|reel|direct|stories)\//.test(h)) continue;
          if (!/^\/[^\/\?#]+\/(\?[^#]*)?$/.test(h)) continue;
          const text = (a.textContent || "").trim();
          arr.push({ href: h, text });
        }
        return Array.from(new Map(arr.map(o => [o.href, o])).values());
      });
      if (targetUser) out.foundTarget = out.links.some(x => x.href.startsWith(`/${targetUser}/`));
      out.ok = (out.links?.length || 0) > 0;

    } else {
      throw new Error(`unknown action: ${action}`);
    }

    out.url = out.url || page.url();
    out.title = out.title || await page.title();
    if (needScreenshot) {
      const b = await page.screenshot({ fullPage: true });
      out.screenshot = `data:image/png;base64,${b.toString("base64")}`;
    }
    res.json(out);

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    await page.close().catch(()=>{});
  }
}));

app.listen(PORT, () => console.log("Playwright API listening on", PORT));
