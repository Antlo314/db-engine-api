// File: /api/ghl/sync-product.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-20_FINAL_v4";

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API live (final v4).",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Parse body safely
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = {};
  }

  const API_BASE = "https://services.leadconnectorhq.com";
  const VERSION = "2021-07-28";

  // Token: env first, then header
  const envToken = process.env.GHL_TOKEN || "";
  const headerAuth = String(req.headers.authorization || "");
  const headerToken = headerAuth.startsWith("Bearer ")
    ? headerAuth.slice(7)
    : "";
  const token = String(envToken || headerToken).trim();

  const envLocationId = process.env.GHL_LOCATION_ID;
  const locationId = String(body.locationId || envLocationId || "").trim();

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "Missing GHL token (env GHL_TOKEN or Authorization header).",
      build: BUILD_MARKER,
    });
  }

  if (!locationId) {
    return res.status(400).json({
      ok: false,
      error: "Missing locationId (body.locationId or env GHL_LOCATION_ID).",
      build: BUILD_MARKER,
    });
  }

  const altId = String(locationId);
  const altType = "location";
  const tokenPrefix = token.slice(0, 10);

  function withAlt(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
    return u.toString();
  }

  async function ghlFetch(path, { method = "GET", json } = {}) {
    const url = withAlt(`${API_BASE}${path}`);
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
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
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

  function extractCollectionId(c) {
    return (
      c?.id ||
      c?._id ||
      c?.collectionId ||
      c?.collection_id ||
      c?.uuid ||
      null
    );
  }

  // Inputs
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const image = String(body.image || "").trim();
  const collectionName = String(body.collectionName || "").trim();
  const sku = body.sku ? String(body.sku).trim() : null;

  // Tenant-required field: productType (allow override; default PHYSICAL)
  const productType = String(body.productType || "PHYSICAL").trim();

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
    // 1) Fetch collections
    const colRes = await ghlFetch("/products/collections");
    const collections = colRes?.collections || colRes?.data || colRes || [];

    const matched = collections.find(
      (c) =>
        String(c?.name || "").trim().toLowerCase() ===
        collectionName.toLowerCase()
    );

    const resolvedCollectionId = extractCollectionId(matched);

    if (!resolvedCollectionId) {
      return res.status(404).json({
        ok: false,
        error: `Collection not found: ${collectionName}`,
        build: BUILD_MARKER,
        debug: {
          tokenPrefix,
          locationId,
          collectionsSeen: (Array.isArray(collections) ? collections : []).map(
            (c) => ({
              name: c?.name,
              id: extractCollectionId(c),
            })
          ),
        },
      });
    }

    // 2) Create product (tenant requires locationId + productType)
    const created = await ghlFetch("/products/", {
      method: "POST",
      json: {
        locationId,
        productType,
        name,
        description: description || undefined,
        image: image || undefined,
        sku: sku || undefined,
      },
    });

    const productId =
      created?.product?.id ||
      created?.product?._id ||
      created?.id ||
      created?._id;

    if (!productId) {
      return res.status(500).json({
        ok: false,
        build: BUILD_MARKER,
        error: "Product created but ID missing in response.",
        created,
      });
    }

    // 3) Enforce collection assignment
    // IMPORTANT: your tenant requires name on PUT, so include it.
    await ghlFetch(`/products/${productId}`, {
      method: "PUT",
      json: {
        locationId,
        productType,
        name, // REQUIRED by your tenant on PUT
        description: description || undefined,
        image: image || undefined,
        sku: sku || undefined,
        collectionIds: [String(resolvedCollectionId)],
      },
    });

    // 4) Verify (best-effort)
    const verified = await ghlFetch(`/products/${productId}`, { method: "GET" });

    return res.status(201).json({
      ok: true,
      build: BUILD_MARKER,
      productId: String(productId),
      collection: {
        name: collectionName,
        id: String(resolvedCollectionId),
      },
      debug: {
        tokenPrefix,
        locationId,
        productType,
      },
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
