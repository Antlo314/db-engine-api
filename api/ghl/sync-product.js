// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-20_CANONICAL_v10_QP_LOCATIONID";

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API is live. Use POST with JSON body.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed", build: BUILD_MARKER });
  }

  // --- Safe body parsing ---
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    body = {};
  }

  // --- ENV ---
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
      error: "Missing locationId. Provide locationId in JSON body or set env var GHL_LOCATION_ID.",
    });
  }

  // Your tenant requirement:
  // - altId + altType MUST be query params
  // - locationId MUST ALSO be on query params
  const altType = "location";
  const altId = locationId;

  const tokenPrefix = String(token).slice(0, 12);

  function withTenantParams(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
    u.searchParams.set("locationId", locationId); // <-- CRITICAL FIX (your v7 success requirement)
    return u.toString();
  }

  async function ghlFetch(path, { method = "GET", json } = {}) {
    const url = withTenantParams(`${API_BASE}${path}`);

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
  function normalizeCollectionId(c) {
    return c?.id || c?._id || c?.collectionId || null;
  }

  async function fetchCollections() {
    const data = await ghlFetch(`/products/collections`, { method: "GET" });
    const arr = data?.collections || data?.data || data?.items || (Array.isArray(data) ? data : []);
    return Array.isArray(arr) ? arr : [];
  }

  function findCollectionByName(collections, collectionName) {
    const target = String(collectionName || "").trim().toLowerCase();
    if (!target) return null;

    let hit = collections.find((c) => String(c?.name || "").trim().toLowerCase() === target) || null;
    if (!hit) {
      hit = collections.find((c) => String(c?.name || "").trim().toLowerCase().includes(target)) || null;
    }
    if (!hit) return null;

    const id = normalizeCollectionId(hit);
    return id ? { ...hit, __resolvedId: String(id) } : { ...hit, __resolvedId: null };
  }

  // ---------- Product update (must be full payload on your tenant) ----------
  async function putProduct(productId, payload) {
    return await ghlFetch(`/products/${productId}`, { method: "PUT", json: payload });
  }

  // ---------- Price create ----------
  async function createPrice(productId, pricePayload) {
    // Official endpoint per docs: POST /products/:productId/price
    return await ghlFetch(`/products/${productId}/price`, { method: "POST", json: pricePayload });
  }

  async function getProduct(productId) {
    return await ghlFetch(`/products/${productId}`, { method: "GET" });
  }

  // ---------- Inputs ----------
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim(); // plain text only, no HTML
  const collectionName = String(body.collectionName || body.collection || "").trim();

  const image = String(body.image || body.imageUrl || "").trim();

  const availableInStore = body.availableInStore === false ? false : true; // default true
  const productType = String(body.productType || "PHYSICAL").trim().toUpperCase();

  const priceAmount = body.price ?? body.amount ?? null;
  const currency = String(body.currency || "USD").trim();
  const priceType = String(body.priceType || "one_time").trim();

  // Optional SEO best-effort (tenant dependent)
  const seoTitle = String(body.seoTitle || "").trim();
  const seoDescription = String(body.seoDescription || "").trim();

  if (!name) return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing required field: name" });
  if (!collectionName) {
    return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing required field: collectionName" });
  }

  try {
    // 1) Resolve collection id
    const collections = await fetchCollections();
    const matched = findCollectionByName(collections, collectionName);

    if (!matched?.__resolvedId) {
      return res.status(404).json({
        ok: false,
        build: BUILD_MARKER,
        error: `Collection not found (or missing id) for name: "${collectionName}"`,
        debug: {
          tokenPrefix,
          locationId,
          altType,
          collectionsSeen: collections.slice(0, 25).map((c) => ({
            name: c?.name,
            id: normalizeCollectionId(c),
          })),
        },
      });
    }

    const resolvedCollectionId = matched.__resolvedId;

    // 2) Build medias payload if image provided (GHL supports medias array on product) — best effort
    const mediasPayload = image
      ? [
          {
            id: crypto.randomUUID(),
            title: name,
            url: image,
            type: "image",
            isFeatured: true,
          },
        ]
      : undefined;

    // 3) Create product
    const createPayload = {
      name,
      description: description || undefined,
      locationId,
      productType,
      availableInStore,
      // Collections
      collectionIds: [resolvedCollectionId],
      // Images
      image: image || undefined,
      medias: mediasPayload,
    };

    // Best-effort SEO (if your tenant supports it)
    if (seoTitle) createPayload.seoTitle = seoTitle;
    if (seoDescription) createPayload.seoDescription = seoDescription;

    const created = await ghlFetch(`/products/`, { method: "POST", json: createPayload });

    const productId =
      created?.product?._id ||
      created?.product?.id ||
      created?._id ||
      created?.id;

    if (!productId) {
      return res.status(500).json({
        ok: false,
        build: BUILD_MARKER,
        error: "Created product but could not find productId in response",
        created,
      });
    }

    // 4) Enforce store toggle + collection via PUT (FULL REQUIRED PAYLOAD)
    // Your tenant rejects partial PUT. Always include name/locationId/productType.
    let enforced = null;
    try {
      enforced = await putProduct(String(productId), {
        name,
        description: description || undefined,
        locationId,
        productType,
        availableInStore,
        collectionIds: [resolvedCollectionId],
        image: image || undefined,
        medias: mediasPayload,
      });
    } catch (e) {
      enforced = { __error: true, status: e?.status || 500, details: e?.data || null };
    }

    // 5) Create price (if provided)
    let priceResp = null;
    if (priceAmount !== null && priceAmount !== undefined && String(priceAmount).trim() !== "") {
      const amountNum = Number(priceAmount);
      if (!Number.isFinite(amountNum) || amountNum < 0) {
        return res.status(400).json({
          ok: false,
          build: BUILD_MARKER,
          error: "Invalid price. Provide a numeric price >= 0.",
        });
      }

      const pricePayload = {
        product: String(productId),
        locationId,
        name: `${name} - Price`,
        type: priceType,
        currency,
        amount: amountNum,
        description: description || undefined,
      };

      try {
        priceResp = await createPrice(String(productId), pricePayload);
      } catch (e) {
        priceResp = { __error: true, status: e?.status || 500, details: e?.data || null };
      }
    }

    // 6) Verify
    const verified = await getProduct(String(productId));
    const productObj = verified?.product || verified || null;

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      productId: String(productId),
      collection: { name: matched?.name || collectionName, id: resolvedCollectionId },
      store: {
        availableInStoreRequested: availableInStore,
        availableInStoreSeenOnGet: productObj?.availableInStore ?? null,
      },
      price: priceResp,
      verified: productObj,
      debug: {
        tokenPrefix,
        locationId,
        productType,
        ghlUrlSample: withTenantParams(`${API_BASE}/products/${productId}`),
      },
      created,
      enforced,
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      ok: false,
      build: BUILD_MARKER,
      error: err?.message || "Unknown error",
      status,
      details: err?.data || null,
      debug: {
        tokenPrefix,
        locationId,
        altType,
        apiBase: API_BASE,
        version: VERSION,
        ghlUrl: err?.url || null,
      },
    });
  }
}
