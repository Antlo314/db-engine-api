// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Version");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-20_CANONICAL_v8_STORE_PRICE";

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API live (v8 canonical). Use POST with JSON body.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed", build: BUILD_MARKER });
  }

  // Safe JSON parse
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    body = {};
  }

  const API_BASE = "https://services.leadconnectorhq.com";
  const VERSION = "2021-07-28";

  const token = process.env.GHL_TOKEN;
  const envLocationId = process.env.GHL_LOCATION_ID;
  const locationId = String(body.locationId || envLocationId || "").trim();

  if (!token) {
    return res.status(500).json({ ok: false, build: BUILD_MARKER, error: "Missing env var: GHL_TOKEN" });
  }
  if (!locationId) {
    return res.status(400).json({
      ok: false,
      build: BUILD_MARKER,
      error: "Missing locationId. Provide locationId in body or set env var GHL_LOCATION_ID.",
    });
  }

  // Tenant quirks: MUST be on querystring for your account
  const altId = locationId;
  const altType = "location";
  const tokenPrefix = String(token).slice(0, 10);

  function withTenantQuery(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
    // critical for your tenant (this was the v7 fix)
    u.searchParams.set("locationId", altId);
    return u.toString();
  }

  async function ghlFetch(path, { method = "GET", json } = {}) {
    const url = withTenantQuery(`${API_BASE}${path}`);
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: VERSION,
        "Content-Type": "application/json",
      },
      body: json ? JSON.stringify(json) : undefined,
    });

    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }

    if (!resp.ok) {
      const err = new Error(`GHL ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      err.url = url;
      throw err;
    }
    return data;
  }

  // ---------- Collections ----------
  function normalizeCollectionsResponse(data) {
    return data?.collections || data?.data || data?.items || (Array.isArray(data) ? data : []);
  }

  function getCollectionId(c) {
    return c?.id || c?._id || c?.collectionId || c?.uuid || null;
  }

  function findCollectionByName(collections, collectionName) {
    const target = String(collectionName || "").trim().toLowerCase();
    if (!target) return null;

    let hit = collections.find((c) => String(c?.name || "").trim().toLowerCase() === target) || null;
    if (!hit) {
      hit = collections.find((c) => String(c?.name || "").trim().toLowerCase().includes(target)) || null;
    }
    return hit;
  }

  // ---------- Store include ----------
  async function enforceIncludeInOnlineStore(productId) {
    // Best-effort: try common flags across tenants
    const attempts = [
      { isAvailableInStore: true },
      { availableInStore: true },
      { isVisibleInStore: true },
      { visibleInStore: true },
      { includedInStore: true },
      { isIncludedInStore: true },
      { includeInOnlineStore: true }, // matches UI label wording
    ];

    let lastErr = null;
    for (const payload of attempts) {
      try {
        return await ghlFetch(`/products/${productId}`, { method: "PUT", json: payload });
      } catch (e) {
        lastErr = e;
      }
    }

    return { ok: false, note: "Unable to set include-in-store via flags", lastErr: lastErr?.data || null };
  }

  // ---------- Simple price ----------
  async function enforceSimplePrice(productId, priceNumber) {
    // GHL often wants price in cents OR structured fields; we try several safe variants.
    // We keep it best-effort so it never breaks product creation.
    const price = Number(priceNumber);
    if (!Number.isFinite(price) || price < 0) return { ok: false, note: "No valid price provided" };

    const attempts = [
      { price },                         // some tenants accept
      { defaultPrice: price },            // some tenants accept
      { amount: price },                  // some tenants accept
      { priceAmount: price },             // some tenants accept
      { priceInCents: Math.round(price * 100) }, // some tenants accept
      // Some tenants store in "variants" even for single-price; try a minimal variant:
      { variants: [{ name: "Default", price }] },
    ];

    let lastErr = null;
    for (const payload of attempts) {
      try {
        return await ghlFetch(`/products/${productId}`, { method: "PUT", json: payload });
      } catch (e) {
        lastErr = e;
      }
    }

    return { ok: false, note: "Unable to set price via PUT attempts", lastErr: lastErr?.data || null };
  }

  // ---------- Inputs ----------
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || body.imageUrl || "").trim();
  const collectionName = String(body.collectionName || body.collection || "").trim();
  const sku = body.sku ? String(body.sku).trim() : undefined;

  // Required by your tenant in earlier 422s
  const productType = String(body.productType || "PHYSICAL").trim().toUpperCase();

  // simple price
  const price = body.price ?? body.amount ?? body.defaultPrice;

  if (!name) return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing required field: name" });
  if (!collectionName) {
    return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing required field: collectionName" });
  }

  try {
    // 1) Resolve collection id
    const colRes = await ghlFetch(`/products/collections`, { method: "GET" });
    const collections = normalizeCollectionsResponse(colRes);
    const matched = findCollectionByName(Array.isArray(collections) ? collections : [], collectionName);

    const resolvedCollectionId = matched ? getCollectionId(matched) : null;

    if (!resolvedCollectionId) {
      return res.status(404).json({
        ok: false,
        error: `Collection not found for name: "${collectionName}"`,
        build: BUILD_MARKER,
        debug: {
          tokenPrefix,
          locationId,
          altType,
          collectionsSeen: (Array.isArray(collections) ? collections : []).slice(0, 25).map((c) => ({
            name: c?.name,
            id: c?.id,
            _id: c?._id,
            extractedId: getCollectionId(c),
          })),
        },
      });
    }

    // 2) Create product (include collection fields on create)
    const createPayload = {
      locationId,
      productType,
      name,
      description: description || undefined,
      image: image || undefined,
      sku,

      // collection attempt
      collectionId: String(resolvedCollectionId),
      assignedCollectionId: String(resolvedCollectionId),
      collectionIds: [String(resolvedCollectionId)],
    };

    const created = await ghlFetch(`/products/`, { method: "POST", json: createPayload });

    const productId =
      created?.product?._id || created?.product?.id || created?._id || created?.id;

    if (!productId) {
      return res.status(500).json({
        ok: false,
        build: BUILD_MARKER,
        error: "Created product but could not find productId in response",
        created,
      });
    }

    // 3) Verify
    const verified1 = await ghlFetch(`/products/${productId}`, { method: "GET" });

    // 4) Ensure included in online store (best-effort)
    const storeResp = await enforceIncludeInOnlineStore(String(productId));

    // 5) Simple price (best-effort)
    const priceResp = await enforceSimplePrice(String(productId), price);

    // 6) Final verify
    const verified2 = await ghlFetch(`/products/${productId}`, { method: "GET" });

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      productId: String(productId),
      collection: { name: matched?.name || collectionName, id: String(resolvedCollectionId) },
      enforcement: {
        includeInOnlineStore: storeResp || null,
        price: priceResp || null,
      },
      verified: verified2?.product || verified2 || null,
      debug: {
        tokenPrefix,
        locationId,
        productType,
        ghlUrlSample: withTenantQuery(`${API_BASE}/products/${productId}`),
      },
      created,
      initialVerified: verified1?.product || verified1 || null,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      build: BUILD_MARKER,
      error: err.message,
      details: err.data || null,
      debug: {
        tokenPrefix,
        locationId,
        productType,
        ghlUrl: err.url || null,
      },
    });
  }
}
