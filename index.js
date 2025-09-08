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
  const header = req.headers.authorization || "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  const token = bearer || (typeof req.query.token === "string" ? req.query.token : "");
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "unauthorized" });
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
      const max = Math.min(parseInt(req.body?.max ?? 300, 10) || 300, 2000);      // сколько максимум собрать
      const timeoutMs = Math.min(parseInt(req.body?.timeoutMs ?? 30000, 10) || 30000, 120000); // общий таймаут
    
      if (!username) throw new Error("username required");
      await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: "domcontentloaded" });
    
      // открыть followers (клик или прямой переход)
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
            await Promise.race([ page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(()=>{}), loc.click() ]);
            clicked = true; break;
          } catch {}
        }
      }
      if (!clicked) {
        await page.goto(`https://www.instagram.com/${username}/followers/`, { waitUntil: "domcontentloaded" }).catch(()=>{});
      }
    
      // есть ли модалка?
      const hadModal = await page.locator('div[role="dialog"]').first().count().then(n=>n>0).catch(()=>false);
    
      // Находим скроллируемый контейнер (в модалке или весь документ)
      const scrollHandle = hadModal
        ? await page.locator('div[role="dialog"]').first().elementHandle()
        : null;
    
      // функция прокрутки
      async function scrollStep() {
        if (scrollHandle) {
          await page.evaluate(el => { el.scrollBy(0, el.scrollHeight); }, scrollHandle);
        } else {
          await page.evaluate(() => window.scrollBy(0, document.documentElement.scrollHeight));
        }
        await page.waitForTimeout(400 + Math.floor(Math.random() * 400));
      }
    
      // сбор одного «батча» ссылок
      async function collectOnce() {
        return await page.evaluate(() => {
          const root = document.querySelector('div[role="dialog"]') || document;
          const anchors = Array.from(root.querySelectorAll('a[role="link"][href^="/"], a[href^="/"]'));
          const items = [];
          for (const a of anchors) {
            const h = a.getAttribute("href");
            if (!h) continue;
            // отсекаем системные пути
            if (/^\/(accounts|explore|p|reel|reels|direct|stories)\//.test(h)) continue;
            // профиль: /username/ или /username/?...
            const m = h.match(/^\/([^\/\?]+)\/(\?[^#]*)?$/);
            if (!m) continue;
            const uname = m[1];
            const text = (a.textContent || "").trim();
            items.push({ username: uname, href: h, text });
          }
          // уникализируем по username
          return Array.from(new Map(items.map(i => [i.username, i])).values());
        });
      }
    
      const started = Date.now();
      const linksMap = new Map();
      let lastSize = 0, still = 0;
    
      while (linksMap.size < max && (Date.now() - started) < timeoutMs && still < 4) {
        const batch = await collectOnce();
        batch.forEach(i => linksMap.set(i.username, i));
        if (linksMap.size === lastSize) still++; else still = 0;
        lastSize = linksMap.size;
        await scrollStep();
      }
    
      out.links = Array.from(linksMap.values());
      out.count = out.links.length;
      out.hadModal = hadModal;
      out.reachedEnd = still >= 4 || (Date.now() - started) >= timeoutMs || linksMap.size >= max;
      out.ok = out.count > 0;
    }
    else if (action === "notificationsSubscribersLinks") {
      const timeoutMs = Math.min(parseInt(req.body?.timeoutMs ?? 30000, 10) || 30000, 120000);
      const max = Math.min(parseInt(req.body?.max ?? 300, 10) || 300, 2000);
      // Переходим на публичную страницу уведомлений
      await page.goto('https://www.instagram.com/notifications/', { waitUntil: 'domcontentloaded' }).catch(()=>{});

      // если нас перекинуло на логин — сообщаем явно и выходим
      const redirectedToLogin = /\/accounts\/login\//.test(page.url());
      if (redirectedToLogin) {
        out.needLogin = true;
        out.ok = false;
        out.url = page.url();
        out.title = await page.title().catch(()=>null);
        return res.json(out);
      }

      // авто‑скролл страницы и сбор уведомлений
      async function scrollDown() {
        await page.evaluate(() => window.scrollBy(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(350 + Math.floor(Math.random()*250));
      }

      async function collectOnce() {
        return await page.evaluate(() => {
          const items = [];
          const blocks = Array.from(document.querySelectorAll('[data-pressable-container="true"]'));
          for (const b of blocks) {
            const a = b.querySelector('a[href^="/"]');
            if (!a) continue;
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([^\/\?]+)\/?/);
            const username = m ? m[1] : null;
            if (!username) continue;
            const text = (b.textContent || '').trim();
            items.push({ username, href, text });
          }
          return Array.from(new Map(items.map(i => [i.username+"|"+i.text, i])).values());
        });
      }

      const started = Date.now();
      const map = new Map();
      while ((Date.now() - started) < timeoutMs && map.size < max) {
        const batch = await collectOnce();
        batch.forEach(i => map.set(i.username+"|"+i.text, i));
        await scrollDown();
      }

      out.links = Array.from(map.values());
      out.count = out.links.length;
      out.ok = true;
    }
     else {
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
