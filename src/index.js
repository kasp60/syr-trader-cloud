const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
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


const ensurePaperSchema = async (db) => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS market_instruments (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      quote_symbol TEXT NOT NULL DEFAULT 'USD', is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS market_prices (
      instrument_id TEXT PRIMARY KEY REFERENCES market_instruments(id) ON DELETE CASCADE,
      price_micro INTEGER NOT NULL CHECK(price_micro > 0),
      updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      cash_cents INTEGER NOT NULL DEFAULT 1000000 CHECK(cash_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_positions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      quantity_micro INTEGER NOT NULL DEFAULT 0 CHECK(quantity_micro >= 0),
      PRIMARY KEY(user_id,instrument_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      side TEXT NOT NULL CHECK(side IN ('buy','sell')), quantity_micro INTEGER NOT NULL CHECK(quantity_micro > 0),
      price_micro INTEGER NOT NULL CHECK(price_micro > 0), total_cents INTEGER NOT NULL CHECK(total_cents > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_orders_user_created ON paper_orders(user_id,created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      order_id TEXT NOT NULL UNIQUE REFERENCES paper_orders(id) ON DELETE RESTRICT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('buy','sell')),
      cash_delta_cents INTEGER NOT NULL, quantity_delta_micro INTEGER NOT NULL,
      instrument_id TEXT NOT NULL REFERENCES market_instruments(id) ON DELETE RESTRICT,
      price_micro INTEGER NOT NULL, created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_ledger_user_created ON paper_ledger(user_id,created_at)")
  ]);
};

const walletApi = async (request, env, url) => {
  const user = await currentUser(request, env.DB);
  if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
  if (url.pathname.startsWith("/api/market/") || url.pathname.startsWith("/api/paper/") ||
      url.pathname.startsWith("/api/admin/market-")) {
    await ensurePaperSchema(env.DB);
    await env.DB.prepare("INSERT OR IGNORE INTO paper_accounts (user_id,cash_cents) VALUES (?,1000000)").bind(user.id).run();
  }

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


  if (url.pathname === "/api/market/board" && request.method === "GET") {
    const [market, account, positions, orders] = await Promise.all([
      env.DB.prepare(`SELECT i.id,i.symbol,i.name,i.quote_symbol AS quoteSymbol,p.price_micro AS priceMicro,p.updated_at AS updatedAt
        FROM market_instruments i LEFT JOIN market_prices p ON p.instrument_id=i.id
        WHERE i.is_active=1 ORDER BY i.symbol`).all(),
      env.DB.prepare("SELECT cash_cents AS cashCents FROM paper_accounts WHERE user_id=?").bind(user.id).first(),
      env.DB.prepare(`SELECT pp.instrument_id AS instrumentId,pp.quantity_micro AS quantityMicro,i.symbol
        FROM paper_positions pp JOIN market_instruments i ON i.id=pp.instrument_id
        WHERE pp.user_id=? AND pp.quantity_micro>0`).bind(user.id).all(),
      env.DB.prepare(`SELECT o.id,o.side,o.quantity_micro AS quantityMicro,o.price_micro AS priceMicro,
        o.total_cents AS totalCents,o.created_at AS createdAt,i.symbol
        FROM paper_orders o JOIN market_instruments i ON i.id=o.instrument_id
        WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 50`).bind(user.id).all()
    ]);
    return json({ok:true,market:market.results||[],cashCents:account?.cashCents??0,
      positions:positions.results||[],orders:orders.results||[]});
  }

  if (url.pathname === "/api/admin/market-instruments" && request.method === "GET") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    const rows=await env.DB.prepare(`SELECT i.id,i.symbol,i.name,i.is_active AS isActive,
      p.price_micro AS priceMicro,p.updated_at AS updatedAt
      FROM market_instruments i LEFT JOIN market_prices p ON p.instrument_id=i.id
      ORDER BY i.symbol`).all();
    return json({ok:true,instruments:rows.results||[]});
  }

  if (url.pathname === "/api/admin/market-instrument-status" && request.method === "POST") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const instrumentId=String(body.instrumentId||"");
    const isActive=body.isActive;
    if(!instrumentId||instrumentId.length>80||typeof isActive!=="boolean")
      return json({ok:false,error:"بيانات الأداة غير صحيحة"},400);
    const result=await env.DB.prepare(`UPDATE market_instruments SET is_active=?
      WHERE id=? AND (?=1 OR NOT EXISTS(
        SELECT 1 FROM paper_positions p
        WHERE p.instrument_id=market_instruments.id AND p.quantity_micro>0
      ))`).bind(isActive?1:0,instrumentId,isActive?1:0).run();
    if(!result.meta?.changes){
      const instrument=await env.DB.prepare("SELECT id FROM market_instruments WHERE id=?").bind(instrumentId).first();
      if(!instrument)return json({ok:false,error:"الأداة غير موجودة"},404);
      if(!isActive)return json({ok:false,error:"لا يمكن إيقاف الأداة لأن هناك مستخدمين يملكون كميات مفتوحة منها؛ يجب إغلاق المراكز أولاً"},409);
      return json({ok:false,error:"تعذر تحديث حالة الأداة"},409);
    }
    return json({ok:true,instrumentId,isActive});
  }

  if (url.pathname === "/api/admin/market-instrument" && request.method === "POST") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const symbol=String(body.symbol||"").trim().toUpperCase();
    const name=String(body.name||"").trim();
    if (!/^[A-Z0-9._-]{2,20}$/.test(symbol)||name.length<2||name.length>60)
      return json({ok:false,error:"رمز السوق أو الاسم غير صحيح"},400);
    try {
      await env.DB.prepare("INSERT INTO market_instruments (id,symbol,name,quote_symbol) VALUES (?,?,?,'USD')")
        .bind(crypto.randomUUID(),symbol,name).run();
    } catch { return json({ok:false,error:"الرمز موجود مسبقاً أو تعذر إنشاء الأداة"},409); }
    return json({ok:true});
  }

  if (url.pathname === "/api/admin/market-price" && request.method === "POST") {
    if (user.role !== "admin") return json({ok:false,error:"غير مصرح"},403);
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const instrumentId=String(body.instrumentId||"");
    const price=Number(body.price);
    if (!instrumentId||instrumentId.length>80||!Number.isFinite(price)||price<=0||price>1000000000)
      return json({ok:false,error:"السعر غير صحيح"},400);
    const priceMicro=Math.round(price*1000000);
    if (!Number.isSafeInteger(priceMicro)||priceMicro<=0) return json({ok:false,error:"دقة السعر غير مقبولة"},400);
    const exists=await env.DB.prepare("SELECT id FROM market_instruments WHERE id=? AND is_active=1").bind(instrumentId).first();
    if(!exists)return json({ok:false,error:"الأداة غير موجودة"},404);
    await env.DB.prepare(`INSERT INTO market_prices (instrument_id,price_micro,updated_by,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(instrument_id) DO UPDATE SET price_micro=excluded.price_micro,
      updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(instrumentId,priceMicro,user.id,new Date().toISOString()).run();
    return json({ok:true,priceMicro});
  }


  if (url.pathname === "/api/paper/history" && request.method === "GET") {
    const rows=await env.DB.prepare(`SELECT l.id,l.order_id AS orderId,l.entry_type AS side,
      l.cash_delta_cents AS cashDeltaCents,l.quantity_delta_micro AS quantityDeltaMicro,
      l.price_micro AS priceMicro,l.created_at AS createdAt,i.symbol,i.name
      FROM paper_ledger l JOIN market_instruments i ON i.id=l.instrument_id
      WHERE l.user_id=? ORDER BY l.created_at DESC LIMIT 100`).bind(user.id).all();
    return json({ok:true,entries:rows.results||[]});
  }

  if (url.pathname === "/api/paper/order" && request.method === "POST") {
    if (!requireSameOrigin(request,url)) return json({ok:false,error:"طلب غير موثوق"},403);
    let body; try { body=await readJson(request); } catch { return json({ok:false,error:"بيانات الطلب غير صحيحة"},400); }
    const instrumentId=String(body.instrumentId||"");
    const side=String(body.side||"");
    const quantity=Number(body.quantity);
    if(!instrumentId||instrumentId.length>80||!["buy","sell"].includes(side)||
      !Number.isFinite(quantity)||quantity<=0||quantity>1000000)
      return json({ok:false,error:"تحقق من الأداة والاتجاه والكمية"},400);
    const quantityMicro=Math.round(quantity*1000000);
    if(!Number.isSafeInteger(quantityMicro)||quantityMicro<=0)
      return json({ok:false,error:"الكمية بدقة غير مقبولة"},400);
    const instrument=await env.DB.prepare(`SELECT i.id,i.symbol,p.price_micro AS priceMicro
      FROM market_instruments i JOIN market_prices p ON p.instrument_id=i.id
      WHERE i.id=? AND i.is_active=1`).bind(instrumentId).first();
    if(!instrument)return json({ok:false,error:"لا يوجد سعر معتمد لهذه الأداة حالياً"},409);
    const notional=BigInt(instrument.priceMicro)*BigInt(quantityMicro);
    const totalBig=side==="buy"?(notional+9999999999n)/10000000000n:notional/10000000000n;
    if(totalBig<=0n||totalBig>9007199254740991n)return json({ok:false,error:"قيمة الصفقة أقل من سنت أو خارج النطاق"},400);
    const totalCents=Number(totalBig);
    const account=await env.DB.prepare("SELECT cash_cents AS cashCents FROM paper_accounts WHERE user_id=?").bind(user.id).first();
    const position=await env.DB.prepare("SELECT quantity_micro AS quantityMicro FROM paper_positions WHERE user_id=? AND instrument_id=?")
      .bind(user.id,instrumentId).first();
    if(side==="buy"&&Number(account?.cashCents||0)<totalCents)
      return json({ok:false,error:"رصيد التداول التجريبي غير كافٍ"},409);
    if(side==="sell"&&Number(position?.quantityMicro||0)<quantityMicro)
      return json({ok:false,error:"الكمية المملوكة تجريبياً غير كافية للبيع"},409);
    const now=new Date().toISOString(),orderId=crypto.randomUUID();
    const orderInsert=env.DB.prepare(`INSERT INTO paper_orders (id,user_id,instrument_id,side,quantity_micro,price_micro,total_cents)
      SELECT ?,?,?,?,?,?,? WHERE changes()=1`).bind(orderId,user.id,instrumentId,side,quantityMicro,instrument.priceMicro,totalCents);
    const ledgerInsert=env.DB.prepare(`INSERT INTO paper_ledger
      (id,user_id,order_id,entry_type,cash_delta_cents,quantity_delta_micro,instrument_id,price_micro,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),user.id,orderId,side,
        side==="buy"?-totalCents:totalCents,side==="buy"?quantityMicro:-quantityMicro,
        instrumentId,instrument.priceMicro,now);
    const statements=side==="buy"?[
      env.DB.prepare(`UPDATE paper_accounts SET cash_cents=cash_cents-?,updated_at=?
        WHERE user_id=? AND cash_cents>=?
          AND EXISTS(SELECT 1 FROM market_instruments WHERE id=? AND is_active=1)
          AND NOT EXISTS(SELECT 1 FROM paper_positions
            WHERE user_id=? AND instrument_id=? AND quantity_micro>9007199254740991-?)`)
        .bind(totalCents,now,user.id,totalCents,instrumentId,user.id,instrumentId,quantityMicro),
      env.DB.prepare(`INSERT INTO paper_positions (user_id,instrument_id,quantity_micro)
        SELECT ?,?,? WHERE changes()=1
        ON CONFLICT(user_id,instrument_id) DO UPDATE SET quantity_micro=quantity_micro+excluded.quantity_micro
        WHERE quantity_micro<=9007199254740991-excluded.quantity_micro`)
        .bind(user.id,instrumentId,quantityMicro),
      orderInsert,
      ledgerInsert
    ]:[
      env.DB.prepare(`UPDATE paper_positions SET quantity_micro=quantity_micro-?
        WHERE user_id=? AND instrument_id=? AND quantity_micro>=?
          AND EXISTS(SELECT 1 FROM paper_accounts WHERE user_id=? AND cash_cents<=9007199254740991-?)
          AND EXISTS(SELECT 1 FROM market_instruments WHERE id=? AND is_active=1)`)
        .bind(quantityMicro,user.id,instrumentId,quantityMicro,user.id,totalCents,instrumentId),
      env.DB.prepare("UPDATE paper_accounts SET cash_cents=cash_cents+?,updated_at=? WHERE user_id=? AND cash_cents<=9007199254740991-? AND changes()=1")
        .bind(totalCents,now,user.id,totalCents),
      orderInsert,
      ledgerInsert
    ];
    let results;
    try { results=await env.DB.batch(statements); }
    catch { return json({ok:false,error:"تعذر تنفيذ الأمر التجريبي؛ لم يتم اعتماد العملية"},409); }
    if(!results?.[results.length-1]?.meta?.changes)
      return json({ok:false,error:side==="buy"?"رصيد التداول التجريبي غير كافٍ":"الكمية المملوكة تجريبياً غير كافية"},409);
    return json({ok:true,orderId,side,symbol:instrument.symbol,quantity,price:Number(instrument.priceMicro)/1000000,totalCents});
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
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
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
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ ok: false, error: "Invalid request body" }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || email.length > 254 || password.length > 128) {
      return json({ ok: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 400);
    }
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const loginKey = await sha256(clientIp + "|" + email);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS auth_login_limits (
      login_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL, blocked_until INTEGER
    )`).run();
    const limit = await env.DB.prepare(`INSERT INTO auth_login_limits
      (login_key,attempts,window_started_at,blocked_until) VALUES (?,1,?,NULL)
      ON CONFLICT(login_key) DO UPDATE SET
        attempts=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.attempts
          WHEN auth_login_limits.window_started_at<=? THEN 1 ELSE auth_login_limits.attempts+1 END,
        window_started_at=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.window_started_at
          WHEN auth_login_limits.window_started_at<=? THEN excluded.window_started_at ELSE auth_login_limits.window_started_at END,
        blocked_until=CASE WHEN auth_login_limits.blocked_until>? THEN auth_login_limits.blocked_until
          WHEN auth_login_limits.window_started_at<=? THEN NULL
          WHEN auth_login_limits.attempts+1>=10 THEN ? ELSE auth_login_limits.blocked_until END
      RETURNING attempts,blocked_until`).bind(loginKey,nowSeconds,nowSeconds,nowSeconds-900,nowSeconds,nowSeconds-900,nowSeconds,nowSeconds-900,nowSeconds+900).first();
    if (Number(limit?.blocked_until || 0) > nowSeconds) {
      return json({ ok: false, error: "محاولات دخول كثيرة؛ حاول بعد 15 دقيقة" }, 429);
    }
    const user = await env.DB.prepare(
      "SELECT id, email, password_hash, display_name, role, status FROM users WHERE email = ? LIMIT 1"
    ).bind(email).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return json({ ok: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 401);
    }
    if (user.status !== "active") return json({ ok: false, error: "الحساب غير نشط، يرجى مراجعة الإدارة" }, 403);
    await env.DB.prepare("DELETE FROM auth_login_limits WHERE login_key=?").bind(loginKey).run();
    const token = await createSession(env.DB, user.id);
    return json(
      { ok: true, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } },
      200,
      { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) }
    );
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (!requireSameOrigin(request, url)) return json({ ok: false, error: "طلب غير موثوق" }, 403);
    const token = getCookie(request, COOKIE_NAME);
    if (token && token.length <= 128) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    }
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env.DB);
    if (!user || user.status !== "active") return json({ ok: false, error: "غير مسجل الدخول" }, 401);
    await ensurePaperSchema(env.DB);
    await env.DB.prepare("INSERT OR IGNORE INTO paper_accounts (user_id,cash_cents) VALUES (?,1000000)").bind(user.id).run();
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

    if (url.pathname.startsWith("/api/wallet/") || url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/api/market/") || url.pathname.startsWith("/api/paper/")) {
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

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("x-frame-options", "DENY");
      headers.set("referrer-policy", "strict-origin-when-cross-origin");
      headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers
      });
    }
    return new Response("SYR TRADER assets are not configured.", { status: 503 });
  }
};
