// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-20_FINAL_v7_QP_LOCATIONID";

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API live (v7 query includes locationId).",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = {};
  }

  const API_BASE = "https://services.leadconnectorhq.com";
  const VERSION = "2021-07-28";

  const envToken = process.env.GHL_TOKEN || "";
  const headerAuth = String(req.headers.authorization || "");
  const headerToken = headerAuth.startsWith("Bearer ") ? headerAuth.slice(7) : "";
  const token = String(envToken || headerToken).trim();

  const envLocationId = process.env.GHL_LOCATION_ID;
  const locationId = String(body.locationId || envLocationId || "").trim();

  if (!token) return res.status(500).json({ ok: false, build: BUILD_MARKER, error: "Missing GHL token" });
  if (!locationId) return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing locationId" });

  const altId = String(locationId);
  const altType = "location";
  const tokenPrefix = token.slice(0, 10);

  // IMPORTANT: this tenant requires locationId in query params too
  function withTenantQuery(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
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
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!resp.ok) {
      const err = new Error(`GHL ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      err.url = url;
      throw err;
    }
    return data;
  }

  function extractCollectionId(c) {
    return c?.id || c?._id || c?.collectionId || c?.collection_id || c?.uuid || null;
  }

  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || "").trim();
  const collectionName = String(body.collectionName || "").trim();
  const sku = body.sku ? String(body.sku).trim() : null;
  const productType = String(body.productType || "PHYSICAL").trim();

  if (!name) return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing name" });
  if (!collectionName) return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing collectionName" });

  try {
    // 1) Resolve collection
    const colRes = await ghlFetch("/products/collections");
    const collections = colRes?.collections || colRes?.data || colRes || [];

    const matched = (Array.isArray(collections) ? collections : []).find(
      (c) => String(c?.name || "").trim().toLowerCase() === collectionName.toLowerCase()
    );

    const resolvedCollectionId = extractCollectionId(matched);
    if (!resolvedCollectionId) {
      return res.status(404).json({
        ok: false,
        build: BUILD_MARKER,
        error: `Collection not found: ${collectionName}`,
        debug: {
          tokenPrefix,
          locationId,
          collectionsSeen: (Array.isArray(collections) ? collections : []).map((c) => ({
            name: c?.name,
            id: extractCollectionId(c),
          })),
        },
      });
    }

    // 2) Create product (include locationId + productType)
    const created = await ghlFetch("/products/", {
      method: "POST",
      json: {
        locationId,
        productType,
        name,
        description: description || undefined,
        image: image || undefined,
        sku: sku || undefined,
        // attempt collection attach at create time
        collectionId: String(resolvedCollectionId),
        assignedCollectionId: String(resolvedCollectionId),
        collectionIds: [String(resolvedCollectionId)],
      },
    });

    const productId = created?.product?.id || created?.product?._id || created?.id || created?._id;
    if (!productId) {
      return res.status(500).json({ ok: false, build: BUILD_MARKER, error: "Created product but ID missing", created });
    }

    // 3) Verify (this is where you were failing; now includes locationId in query)
    const verified = await ghlFetch(`/products/${productId}`, { method: "GET" });

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      productId: String(productId),
      collection: { name: collectionName, id: String(resolvedCollectionId) },
      debug: { tokenPrefix, locationId, productType },
      verified,
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
