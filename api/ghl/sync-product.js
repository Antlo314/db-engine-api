// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Version");

  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-20_INCLUDE_IN_STORE";

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

  // GHL requirement: altId + altType must be on QUERY PARAMS
  const altType = "location";
  const altId = locationId;

  // --- Helpers ---
  const tokenPrefix = String(token).slice(0, 12);

  function withAlt(url) {
    const u = new URL(url);
    u.searchParams.set("altId", String(altId));
    u.searchParams.set("altType", String(altType));
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
      const err = new Error(`HTTP ${resp.status} ${resp.statusText}`);
      err.status = resp.status;
      err.data = data;
      err.url = url;
      throw err;
    }

    return data;
  }

  function normalizeArrayPayload(data) {
    return (
      data?.collections ||
      data?.data ||
      data?.items ||
      (Array.isArray(data) ? data : [])
    );
  }

  async function fetchCollections() {
    // GET /products/collections
    const data = await ghlFetch(`/products/collections`, { method: "GET" });
    const arr = normalizeArrayPayload(data);
    return Array.isArray(arr) ? arr : [];
  }

  function findCollectionByName(collections, collectionName) {
    const target = String(collectionName || "").trim().toLowerCase();
    if (!target) return null;

    // exact match
    let hit = collections.find(
      (c) => String(c?.name || "").trim().toLowerCase() === target
    );

    // fallback includes match
    if (!hit) {
      hit = collections.find((c) =>
        String(c?.name || "").trim().toLowerCase().includes(target)
      );
    }

    return hit || null;
  }

  function pickAssignedCollectionId(productPayload) {
    const p = productPayload?.product || productPayload || {};
    return (
      p.assignedCollectionId ||
      p.collectionId ||
      (Array.isArray(p.collectionIds) ? p.collectionIds[0] : null) ||
      (Array.isArray(p.collectionIds?.data) ? p.collectionIds.data[0] : null) ||
      null
    );
  }

  async function enforceCollection(productId, collectionId) {
    // Try multiple accepted shapes across tenants
    const attempts = [
      { collectionIds: [String(collectionId)] },
      { collectionId: String(collectionId) },
      { assignedCollectionId: String(collectionId) },
    ];

    let lastErr = null;
    for (const payload of attempts) {
      try {
        return await ghlFetch(`/products/${productId}`, {
          method: "PUT",
          json: payload,
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Failed to enforce collection assignment");
  }

  async function enforceIncludeInOnlineStore(productId) {
    // We do NOT assume the exact field name. We try common variants.
    const attempts = [
      { availableInStore: true },
      { isAvailableInStore: true },
      { includedInStore: true },
      { isIncludedInStore: true },
      { isVisibleInStore: true },
      { visibleInStore: true },
    ];

    let lastErr = null;
    for (const payload of attempts) {
      try {
        return await ghlFetch(`/products/${productId}`, {
          method: "PUT",
          json: payload,
        });
      } catch (e) {
        lastErr = e;
      }
    }

    // If none of the flags work in your tenant, we don't fail the whole sync.
    // We just report that store-inclusion enforcement could not be confirmed.
    return { ok: false, note: "Could not set include-in-store flags via PUT", lastErr: lastErr?.data || null };
  }

  // --- Inputs ---
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || body.imageUrl || "").trim();

  // IMPORTANT: match your request contract
  const collectionName = String(body.collectionName || body.collection || "").trim();

  // Optional
  const sku = body.sku ? String(body.sku).trim() : undefined;

  // Product Type: you already discovered GHL requires a valid enum value in some cases
  // PHYSICAL is known-good for your tenant based on your successful response.
  const productType = String(body.productType || "PHYSICAL").trim().toUpperCase();

  if (!name) {
    return res.status(400).json({ ok: false, error: "Missing required field: name", build: BUILD_MARKER });
  }
  if (!collectionName) {
    return res.status(400).json({ ok: false, error: "Missing required field: collectionName", build: BUILD_MARKER });
  }

  try {
    // 1) Resolve collection by name -> id
    const collections = await fetchCollections();
    const matched = findCollectionByName(collections, collectionName);

    if (!matched?.id) {
      return res.status(404).json({
        ok: false,
        error: `Collection not found for name: "${collectionName}"`,
        build: BUILD_MARKER,
        debug: {
          tokenPrefix,
          locationId,
          altType,
          collectionsSeen: collections.slice(0, 25).map((c) => ({ id: c?.id, name: c?.name })),
        },
      });
    }

    const resolvedCollectionId = String(matched.id);

    // 2) Create product
    const createPayload = {
      name,
      description: description || undefined,
      image: image || undefined,
      sku,
      productType,              // key for your tenant
      // Collection fields included but we still enforce after create:
      collectionId: resolvedCollectionId,
      assignedCollectionId: resolvedCollectionId,
      collectionIds: [resolvedCollectionId],
    };

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

    // 3) Enforce collection AFTER create
    const enforcedCollectionResp = await enforceCollection(String(productId), resolvedCollectionId);

    // 4) Enforce "Include in Online Store" (best-effort via PUT)
    const enforcedStoreResp = await enforceIncludeInOnlineStore(String(productId));

    // 5) Verify final state via GET
    const verifiedProduct = await ghlFetch(`/products/${productId}`, { method: "GET" });
    const assigned = pickAssignedCollectionId(verifiedProduct);

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      ghlProductId: String(productId),
      collection: {
        resolvedCollectionId,
        collectionName: matched?.name || collectionName,
      },
      verified: {
        collectionAssigned: String(assigned || "") === String(resolvedCollectionId),
        product: verifiedProduct?.product || verifiedProduct || null,
      },
      enforcement: {
        collection: true,
        includeInOnlineStore: enforcedStoreResp || null,
      },
      debug: {
        tokenPrefix,
        locationId,
        altType,
        apiBase: API_BASE,
        version: VERSION,
        ghlUrlSample: withAlt(`${API_BASE}/products/${productId}`),
      },
      created,
      enforcedCollectionResp,
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
