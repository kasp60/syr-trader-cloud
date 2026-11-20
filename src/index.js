const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 7;
const COOKIE_NAME = "syr_session";

const base64url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

const fromBase64url = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const randomToken = (size = 32) => {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return base64url(bytes);
};

const sha256 = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
};

const passwordHash = async (password, salt = crypto.getRandomValues(new Uint8Array(16))) => {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
};

const verifyPassword = async (password, stored) => {
  const [algorithm, iterationsText, saltText, expectedText] = String(stored).split("$");
  if (algorithm !== "pbkdf2" || !iterationsText || !saltText || !expectedText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 100000) return false;
  const actual = await passwordHashWithParams(password, fromBase64url(saltText), iterations);
  const actualBytes = fromBase64url(actual.split("$")[3]);
  const expectedBytes = fromBase64url(expectedText);
  if (actualBytes.length !== expectedBytes.length) return false;
  let difference = 0;
  for (let i = 0; i < actualBytes.length; i++) difference |= actualBytes[i] ^ expectedBytes[i];
  return difference === 0;
};

const passwordHashWithParams = async (password, salt, iterations) => {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256
  );
  return `pbkdf2$${iterations}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
};

const getCookie = (request, name) => {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return entry ? entry.slice(name.length + 1) : null;
};

const sessionCookie = (token, maxAge) =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const readJson = async (request) => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("CONTENT_TYPE");
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 8192) throw new Error("TOO_LARGE");
  return request.json();
};

const createSession = async (db, userId) => {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), userId, tokenHash, expiresAt).run();
  return token;
};

const currentUser = async (request, db) => {
  const token = getCookie(request, COOKIE_NAME);
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const result = await db.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`
  ).bind(tokenHash, new Date().toISOString()).first();
  return result || null;
};


const requireSameOrigin = (request, url) => {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === url.origin);
};

const walletApi = async (request, env, url) => {
  const user = await currentUser(request, env.DB);
  if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);

  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    const rows = await env.DB.prepare(
      `SELECT id, email, display_name AS displayName, role, status, created_at AS createdAt
       FROM users ORDER BY created_at DESC LIMIT 500`
    ).all();
    return json({ ok: true, users: rows.results || [] });
  }

  if (url.pathname === "/api/admin/user-status" && request.method === "POST") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const userId = String(body.userId || "");
    const status = String(body.status || "");
    if (!userId || userId.length > 80 || !["active", "suspended"].includes(status)) {
      return json({ ok: false, error: "بيانات المستخدم غير صحيحة" }, 400);
    }
    if (userId === user.id && status === "suspended") {
      return json({ ok: false, error: "لا يمكنك إيقاف حسابك الحالي" }, 400);
    }
    const target = await env.DB.prepare(
      "SELECT id, role, status FROM users WHERE id = ? LIMIT 1"
    ).bind(userId).first();
    if (!target) return json({ ok: false, error: "المستخدم غير موجود" }, 404);
    if (target.role === "admin" && target.status === "active" && status === "suspended") {
      const admins = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'"
      ).first();
      if (Number(admins?.count || 0) <= 1) {
        return json({ ok: false, error: "لا يمكن إيقاف المدير النشط الأخير" }, 409);
      }
    }
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, userId).run();
    if (status === "suspended") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    }
    return json({ ok: true, userId, status });
  }

  if (url.pathname === "/api/market/rate" && request.method === "GET") {
    const rate = await env.DB.prepare(
      "SELECT base_symbol AS baseSymbol, quote_symbol AS quoteSymbol, rate, updated_at AS updatedAt FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1"
    ).first();
    return json({ ok: true, rate: rate || null });
  }

  if (url.pathname === "/api/admin/exchange-rate" && request.method === "POST") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000000) {
      return json({ ok: false, error: "سعر الصرف غير صحيح" }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO exchange_rates (id, base_symbol, quote_symbol, rate, updated_by, updated_at)
       VALUES ('usd-syp','USD','SYP',?,?,?)
       ON CONFLICT(base_symbol,quote_symbol) DO UPDATE SET rate=excluded.rate, updated_by=excluded.updated_by, updated_at=excluded.updated_at`
    ).bind(rate, user.id, new Date().toISOString()).run();
    return json({ ok: true, rate });
  }

  if (url.pathname === "/api/admin/wallets" && request.method === "GET") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('syr-lira','SYP','ليرة',1)"),
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('usd-dollar','USD','دولار أمريكي',1)"),
      env.DB.prepare("INSERT OR IGNORE INTO wallets (id,user_id,asset_id,balance_minor) SELECT lower(hex(randomblob(16))),u.id,a.id,0 FROM users u CROSS JOIN assets a WHERE a.symbol IN ('SYP','USD') AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id=u.id AND w.asset_id=a.id)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS exchange_rates (
        id TEXT PRIMARY KEY, base_symbol TEXT NOT NULL, quote_symbol TEXT NOT NULL,
        rate REAL NOT NULL CHECK(rate > 0), updated_by TEXT REFERENCES users(id),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(base_symbol, quote_symbol)
      )`),
    ]);
    const rows = await env.DB.prepare(
      `SELECT w.id AS walletId, u.email, u.display_name AS displayName,
              a.name AS assetName, a.symbol, w.balance_minor AS balanceMinor
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       JOIN assets a ON a.id = w.asset_id
       ORDER BY u.created_at DESC LIMIT 500`
    ).all();
    return json({ ok: true, wallets: rows.results || [] });
  }

  if (url.pathname === "/api/wallet/ledger" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT le.id, le.entry_type AS type, le.amount_minor AS amountMinor,
              le.reference, le.note, le.created_at AS createdAt, a.symbol
       FROM ledger_entries le
       JOIN wallets w ON w.id = le.wallet_id
       JOIN assets a ON a.id = w.asset_id
       WHERE w.user_id = ?
       ORDER BY le.created_at DESC, le.id DESC LIMIT 100`
    ).bind(user.id).all();
    return json({ ok: true, entries: rows.results || [] });
  }

  if (url.pathname === "/api/admin/wallet-adjust" && request.method === "POST") {
    if (user.role !== "admin") return json({ ok: false, error: "غير مصرح" }, 403);
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "بيانات الطلب غير صحيحة" }, 400); }
    const walletId = String(body.walletId || "");
    const type = String(body.type || "");
    const amountMinor = Number(body.amountMinor);
    const note = String(body.note || "").trim();
    const idempotencyKey = String(body.idempotencyKey || "");
    if (!walletId || walletId.length > 80 ||
        !["credit", "debit"].includes(type) ||
        !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
        amountMinor > 1000000000000 ||
        !/^[0-9a-f-]{36}$/i.test(idempotencyKey) ||
        note.length > 240) {
      return json({ ok: false, error: "تحقق من نوع الحركة والمبلغ والبيانات" }, 400);
    }

    const existing = await env.DB.prepare(
      "SELECT id FROM ledger_entries WHERE idempotency_key = ? LIMIT 1"
    ).bind(idempotencyKey).first();
    if (existing) return json({ ok: false, error: "هذه الحركة مسجلة مسبقاً" }, 409);

    const entryId = crypto.randomUUID();
    const updateSql = type === "credit"
      ? "UPDATE wallets SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ? AND balance_minor <= 9007199254740991 - ?"
      : "UPDATE wallets SET balance_minor = balance_minor - ?, updated_at = ? WHERE id = ? AND balance_minor >= ?";
    const results = await env.DB.batch([
      env.DB.prepare(updateSql).bind(amountMinor, new Date().toISOString(), walletId, amountMinor),
      env.DB.prepare(
        `INSERT INTO ledger_entries
          (id, wallet_id, entry_type, amount_minor, idempotency_key, created_by, note)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`
      ).bind(entryId, walletId, type, amountMinor, idempotencyKey, user.id, note || null)
    ]);
    if (!results?.[0]?.meta?.changes) {
      return json({ ok: false, error: "المحفظة غير موجودة أو الرصيد غير كافٍ" }, 409);
    }
    if (!results?.[1]?.meta?.changes) {
      return json({ ok: false, error: "تعذر تسجيل الحركة" }, 409);
    }
    const wallet = await env.DB.prepare(
      "SELECT balance_minor AS balanceMinor FROM wallets WHERE id = ?"
    ).bind(walletId).first();
    return json({ ok: true, balanceMinor: wallet?.balanceMinor ?? null, entryId });
  }

  return json({ ok: false, error: "API route not found" }, 404);
};

const authApi = async (request, env, url) => {
  if (!env.DB) return json({ ok: false, error: "Database is not configured" }, 503);

  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "Invalid request body" }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const displayName = String(body.displayName || "").trim();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json({ ok: false, error: "يرجى إدخال بريد إلكتروني صحيح" }, 400);
    }
    if (displayName.length < 2 || displayName.length > 60) {
      return json({ ok: false, error: "الاسم يجب أن يكون بين حرفين و60 حرفاً" }, 400);
    }
    if (password.length < 10 || password.length > 128) {
      return json({ ok: false, error: "كلمة المرور يجب أن تكون 10 أحرف على الأقل" }, 400);
    }
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first();
    if (exists) return json({ ok: false, error: "البريد الإلكتروني مستخدم مسبقاً" }, 409);

    const userId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    const usdWalletId = crypto.randomUUID();
    const passwordDigest = await passwordHash(password);
    const token = randomToken();
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('syr-lira', 'SYP', 'ليرة', 1)"
        ),
        env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)"
        ).bind(userId, email, passwordDigest, displayName),
        env.DB.prepare(
          "INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('usd-dollar', 'USD', 'دولار أمريكي', 1)"
        ),
        env.DB.prepare(
          "INSERT INTO wallets (id, user_id, asset_id, balance_minor) SELECT ?, ?, id, 0 FROM assets WHERE symbol = 'SYP'"
        ).bind(walletId, userId),
        env.DB.prepare(
          "INSERT INTO wallets (id, user_id, asset_id, balance_minor) SELECT ?, ?, id, 0 FROM assets WHERE symbol = 'USD'"
        ).bind(usdWalletId, userId),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS exchange_rates (
            id TEXT PRIMARY KEY, base_symbol TEXT NOT NULL, quote_symbol TEXT NOT NULL,
            rate REAL NOT NULL CHECK(rate > 0), updated_by TEXT REFERENCES users(id),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(base_symbol, quote_symbol)
          )`
        ),
        env.DB.prepare("INSERT OR IGNORE INTO exchange_rates (id, base_symbol, quote_symbol, rate) VALUES ('usd-syp','USD','SYP',0)"),
        env.DB.prepare(
          "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), userId, tokenHash, expiresAt)
      ]);
    } catch {
      return json({ ok: false, error: "تعذر إنشاء الحساب، تحقق من البيانات وحاول مجدداً" }, 409);
    }
    return json(
      { ok: true, user: { id: userId, email, displayName, role: "user" } },
      201,
      { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) }
    );
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "Invalid request body" }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password || email.length > 254 || password.length > 128) {
      return json({ ok: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 400);
    }
    const user = await env.DB.prepare(
      "SELECT id, email, password_hash, display_name, role, status FROM users WHERE email = ? LIMIT 1"
    ).bind(email).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return json({ ok: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 401);
    }
    if (user.status !== "active") return json({ ok: false, error: "الحساب غير نشط، يرجى مراجعة الإدارة" }, 403);
    const token = await createSession(env.DB, user.id);
    return json(
      { ok: true, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } },
      200,
      { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) }
    );
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = getCookie(request, COOKIE_NAME);
    if (token && token.length <= 128) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env.DB);
    if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('syr-lira', 'SYP', 'ليرة', 1)"),
      env.DB.prepare("INSERT OR IGNORE INTO assets (id, symbol, name, is_active) VALUES ('usd-dollar', 'USD', 'دولار أمريكي', 1)"),
      env.DB.prepare("INSERT OR IGNORE INTO wallets (id, user_id, asset_id, balance_minor) SELECT lower(hex(randomblob(16))), ?, id, 0 FROM assets WHERE symbol IN ('SYP','USD')").bind(user.id),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS exchange_rates (
        id TEXT PRIMARY KEY, base_symbol TEXT NOT NULL, quote_symbol TEXT NOT NULL,
        rate REAL NOT NULL CHECK(rate > 0), updated_by TEXT REFERENCES users(id),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(base_symbol, quote_symbol)
      )`),
    ]);
    const wallets = await env.DB.prepare(
      `SELECT a.name AS assetName, a.symbol, w.id AS walletId, w.balance_minor AS balanceMinor
       FROM wallets w JOIN assets a ON a.id = w.asset_id
       WHERE w.user_id = ? AND a.symbol IN ('SYP','USD') ORDER BY CASE a.symbol WHEN 'SYP' THEN 1 ELSE 2 END`
    ).bind(user.id).all();
    const rates = await env.DB.prepare(
      "SELECT base_symbol AS baseSymbol, quote_symbol AS quoteSymbol, rate, updated_at AS updatedAt FROM exchange_rates WHERE base_symbol='USD' AND quote_symbol='SYP' LIMIT 1"
    ).first();
    return json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
      wallets: wallets.results || [],
      exchangeRate: rates || null
    });
  }

  return json({ ok: false, error: "API route not found" }, 404);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        if (!env.DB) throw new Error("D1 binding missing");
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json({
          ok: true,
          service: "SYR TRADER",
          environment: "cloudflare-workers",
          database: "connected",
          timestamp: new Date().toISOString()
        });
      } catch {
        return json({ ok: false, service: "SYR TRADER", database: "unavailable" }, 503);
      }
    }

    if (url.pathname.startsWith("/api/wallet/") || url.pathname.startsWith("/api/admin/")) {
      try { return await walletApi(request, env, url); }
      catch (error) {
        console.error("SYR_TRADER_WALLET_ERROR", {
          path: url.pathname,
          method: request.method,
          message: error instanceof Error ? error.message : String(error)
        });
        return json({ ok: false, error: "حدث خطأ داخلي، حاول مجدداً" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/auth/")) {
      try { return await authApi(request, env, url); }
      catch (error) {
        console.error("SYR_TRADER_AUTH_ERROR", {
          path: url.pathname,
          method: request.method,
          message: error instanceof Error ? error.message : String(error)
        });
        return json({ ok: false, error: "حدث خطأ داخلي، حاول مجدداً" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "API route not found" }, 404);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("SYR TRADER assets are not configured.", { status: 503 });
  }
};
