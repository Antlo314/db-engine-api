// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-20_CANONICAL_v9_STORE_PRICE_MEDIA";

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
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // --- Safe body parsing (Vercel can pass string) ---
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

  // Prefer request locationId if provided; otherwise env
  const locationId = String(body.locationId || envLocationId || "").trim();

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "Missing env var: GHL_TOKEN",
      build: BUILD_MARKER,
    });
  }
  if (!locationId) {
    return res.status(400).json({
      ok: false,
      error: "Missing locationId. Provide locationId in JSON body or set env var GHL_LOCATION_ID.",
      build: BUILD_MARKER,
    });
  }

  // GHL requirement you already proved: altId/altType MUST be query params
  const altType = "location";
  const altId = locationId;

  // --- Helpers ---
  const tokenPrefix = String(token).slice(0, 12);

  function withAlt(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
    return u.toString();
  }

  async function ghlFetch(path, { method = "GET", json } = {}) {
    const url = withAlt(`${API_BASE}${path}`);
    const headers = {
      Authorization: `Bearer ${token}`,
      Version: VERSION,
      "Content-Type": "application/json",
    };

    const resp = await fetch(url, {
      method,
      headers,
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
      throw err;
    }

    return data;
  }

  async function fetchCollections() {
    const data = await ghlFetch(`/products/collections`, { method: "GET" });

    const arr =
      data?.collections ||
      data?.data ||
      data?.items ||
      (Array.isArray(data) ? data : []);

    return Array.isArray(arr) ? arr : [];
  }

  function normalizeCollectionId(c) {
    return c?.id || c?._id || c?.collectionId || null;
  }

  function findCollectionByName(collections, collectionName) {
    const target = String(collectionName || "").trim().toLowerCase();
    if (!target) return null;

    // Exact match
    let hit =
      collections.find(
        (c) => String(c?.name || "").trim().toLowerCase() === target
      ) || null;

    // Fallback: includes match
    if (!hit) {
      hit =
        collections.find((c) =>
          String(c?.name || "").trim().toLowerCase().includes(target)
        ) || null;
    }

    if (!hit) return null;

    const id = normalizeCollectionId(hit);
    return id ? { ...hit, __resolvedId: String(id) } : { ...hit, __resolvedId: null };
  }

  async function enforceProductUpdate(productId, payload) {
    // IMPORTANT: GHL update endpoint often validates required fields.
    // So we always include name/locationId/productType when we PUT.
    return await ghlFetch(`/products/${productId}`, {
      method: "PUT",
      json: payload,
    });
  }

  async function createPrice(productId, pricePayload) {
    // Official Prices endpoint: POST /products/:productId/price
    return await ghlFetch(`/products/${productId}/price`, {
      method: "POST",
      json: pricePayload,
    });
  }

  async function getProduct(productId) {
    return await ghlFetch(`/products/${productId}`, { method: "GET" });
  }

  // --- Inputs (plain text description; NO HTML) ---
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim(); // user requirement: plain text only
  const collectionName = String(body.collectionName || body.collection || "").trim();

  // optional
  const image = String(body.image || body.imageUrl || "").trim();
  const medias = Array.isArray(body.medias) ? body.medias : null;

  // optional price
  const priceAmount = body.price ?? body.amount ?? null; // number
  const currency = String(body.currency || "USD").trim();
  const priceType = String(body.priceType || "one_time").trim(); // one_time | recurring

  // optional SEO best-effort (tenant dependent)
  const seoTitle = String(body.seoTitle || "").trim();
  const seoDescription = String(body.seoDescription || "").trim();

  if (!name) {
    return res.status(400).json({ ok: false, error: "Missing required field: name", build: BUILD_MARKER });
  }
  if (!collectionName) {
    return res.status(400).json({ ok: false, error: "Missing required field: collectionName", build: BUILD_MARKER });
  }

  // GHL doc calls this "availableInStore"
  const availableInStore = body.availableInStore === false ? false : true; // default true

  // Product type: PHYSICAL is your default use case
  const productType = String(body.productType || "PHYSICAL").trim();

  // --- Run ---
  try {
    // 1) Resolve collection id by name
    const collections = await fetchCollections();
    const matched = findCollectionByName(collections, collectionName);

    if (!matched?.__resolvedId) {
      return res.status(404).json({
        ok: false,
        error: `Collection not found (or missing id) for name: "${collectionName}"`,
        build: BUILD_MARKER,
        debug: {
          tokenPrefix,
          locationId,
          altType,
          collectionsSeen: collections.slice(0, 25).map((c) => ({
            id: normalizeCollectionId(c),
            name: c?.name,
          })),
        },
      });
    }

    const resolvedCollectionId = matched.__resolvedId;

    // 2) Build medias payload (official format)
    // If user gave medias array, use it; otherwise build from image.
    const mediasPayload =
      (Array.isArray(medias) && medias.length)
        ? medias
        : (image
            ? [
                {
                  id: crypto.randomUUID(),
                  title: name,
                  url: image,
                  type: "image",
                  isFeatured: true,
                },
              ]
            : undefined);

    // 3) Create product
    const createPayload = {
      name,
      description: description || undefined,
      locationId,
      productType,
      availableInStore, // << key for “Include in Online store” :contentReference[oaicite:3]{index=3}
      image: image || undefined,
      medias: mediasPayload,
      // collections may or may not persist on create, but we still send them:
      collectionIds: [resolvedCollectionId],
    };

    // best-effort SEO fields (ignored if unsupported)
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
        error: "Created product but could not find productId in response",
        build: BUILD_MARKER,
        created,
      });
    }

    // 4) Enforce collection + availableInStore via PUT (include required fields)
    // NOTE: update endpoint can be strict; include name/locationId/productType.
    let enforced = null;
    try {
      enforced = await enforceProductUpdate(String(productId), {
        name,
        locationId,
        productType,
        availableInStore,
        collectionIds: [resolvedCollectionId],
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

      // Per HighLevel support article, these are core fields :contentReference[oaicite:4]{index=4}
      const pricePayload = {
        product: String(productId),
        locationId,
        name: `${name} - Price`,
        type: priceType,     // one_time | recurring
        currency,            // USD
        amount: amountNum,   // numeric
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

    const finalCollectionIds =
      verified?.product?.collectionIds ||
      verified?.collectionIds ||
      [];

    const isInCollection = Array.isArray(finalCollectionIds)
      ? finalCollectionIds.map(String).includes(String(resolvedCollectionId))
      : false;

    const finalAvailable =
      verified?.product?.availableInStore ??
      verified?.availableInStore ??
      null;

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      productId: String(productId),
      collection: { name: collectionName, id: resolvedCollectionId },
      store: { availableInStoreRequested: availableInStore, availableInStoreSeenOnGet: finalAvailable },
      verified: { isInCollection },
      price: priceResp,
      debug: { tokenPrefix, locationId, productType },
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
      debug: { tokenPrefix, locationId, altType, apiBase: API_BASE, version: VERSION },
    });
  }
}
