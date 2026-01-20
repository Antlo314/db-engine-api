// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-19_v2";

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
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = {};
  }

  // --- ENV ---
  const API_BASE = "https://services.leadconnectorhq.com";
  const VERSION = "2021-07-28";

  // Token comes from env OR Authorization header (helps ReqBin testing)
  const envToken = process.env.GHL_TOKEN || "";
  const headerAuth = String(req.headers.authorization || "").trim();
  const headerToken = headerAuth.toLowerCase().startsWith("bearer ")
    ? headerAuth.slice(7).trim()
    : "";

  const token = String(envToken || headerToken || "").trim();
  const envLocationId = process.env.GHL_LOCATION_ID;

  // Prefer request locationId if provided; otherwise env
  const locationId = String(body.locationId || envLocationId || "").trim();

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "Missing token. Set env var GHL_TOKEN or pass Authorization: Bearer <token>.",
      build: BUILD_MARKER,
    });
  }
  if (!locationId) {
    return res.status(400).json({
      ok: false,
      error:
        "Missing locationId. Provide locationId in JSON body or set env var GHL_LOCATION_ID.",
      build: BUILD_MARKER,
    });
  }

  const altType = "location";
  const altId = String(locationId);

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
      err.ghlUrl = url; // very useful debug
      throw err;
    }

    return data;
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

  async function fetchCollections() {
    const data = await ghlFetch(`/products/collections`, { method: "GET" });
    const arr =
      data?.collections ||
      data?.data ||
      data?.items ||
      (Array.isArray(data) ? data : []);
    return Array.isArray(arr) ? arr : [];
  }

  function findCollectionByName(collections, collectionName) {
    const target = String(collectionName || "").trim().toLowerCase();
    if (!target) return null;

    let hit =
      collections.find(
        (c) => String(c?.name || "").trim().toLowerCase() === target
      ) || null;

    if (!hit) {
      hit =
        collections.find((c) =>
          String(c?.name || "").trim().toLowerCase().includes(target)
        ) || null;
    }
    return hit;
  }

  async function enforceCollection(productId, collectionId) {
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

  // --- Inputs ---
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || body.imageUrl || "").trim();
  const collectionName = String(body.collectionName || "").trim();
  const sku = body.sku ? String(body.sku).trim() : null;

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Missing required field: name",
      build: BUILD_MARKER,
    });
  }
  if (!collectionName) {
    return res.status(400).json({
      ok: false,
      error: "Missing required field: collectionName",
      build: BUILD_MARKER,
    });
  }

  try {
    // 1) Resolve collection
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
          collectionsSeen: collections.slice(0, 10).map((c) => ({
            id: c?.id,
            name: c?.name,
          })),
        },
      });
    }

    const resolvedCollectionId = String(matched.id);

    // 2) Create product
    const createPayload = {
      name,
      description: description || undefined,
      image: image || undefined,
      sku: sku || undefined,
      collectionId: resolvedCollectionId,
      assignedCollectionId: resolvedCollectionId,
      collectionIds: [resolvedCollectionId],
    };

    const created = await ghlFetch(`/products/`, {
      method: "POST",
      json: createPayload,
    });

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
    const enforcedResponse = await enforceCollection(
      String(productId),
      resolvedCollectionId
    );

    // 4) Verify
    const verifiedProduct = await ghlFetch(`/products/${productId}`, {
      method: "GET",
    });

    const assigned = pickAssignedCollectionId(verifiedProduct);
    const verified = String(assigned || "") === String(resolvedCollectionId);

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      ghlProductId: String(productId),
      collection: {
        resolvedCollectionId,
        collectionName,
      },
      enforced: true,
      verified,
      assignedCollectionIdSeenOnGet: assigned || null,
      debug: {
        tokenPrefix,
        locationId,
        altType,
        apiBase: API_BASE,
        version: VERSION,
      },
      created,
      enforcedResponse,
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
        ghlUrl: err?.ghlUrl || null,
      },
    });
  }
}
