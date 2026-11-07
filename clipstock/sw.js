// ClipStock のサービスワーカー：画面一式と、GitHub から取った暗号化済みのデータを端末に置く
// 一覧・ノート・夜間処理は index.html 側で「保存分を先に出して裏で更新」している。ここでは本文とサムネを担当。
const SHELL = "clipstock-shell-v1", DATA = "clipstock-data", FONTS = "clipstock-fonts";
const SHELL_FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("clipstock-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 本文・サムネはめったに変わらないので、保存分をすぐ返し、裏で新しいものに入れ替える（開くのを速く）
  // 暗号化されたまま保存する。URL だけを鍵にして、Authorization ヘッダーは残さない
  if (url.host === "api.github.com" && /\/contents\/(items\/[^/]+\.json\.age|thumbs\/[^/]+\.jpg\.age)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      const hit = await c.match(req.url);
      const fresh = fetch(req).then(async res => { if (res.ok) await c.put(req.url, res.clone()); return res; });
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    })());
    return;
  }

  // GitHub の目録など（index / notes / night）は index.html が自分で保存・更新するのでここでは触らない
  if (url.host === "api.github.com" || url.host === "script.google.com" || url.host === "script.googleusercontent.com") return;

  // 文字（Google Fonts）は一度取れば使い回す
  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // 画面一式：通信できれば最新を取り、できなければ保存分を使う
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await c.match("index.html") : undefined) || Response.error();
      }
    })());
  }
});
