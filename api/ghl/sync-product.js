// File: /api/ghl/sync-product.js
const BUILD_MARKER = "DB_ENGINE_API_BUILD_2026-01-19_v1";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Version, Accept");

  if (req.method === "OPTIONS") return res.status(204).end();

  // GET healthcheck
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API is live. Use POST with JSON body."
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed. Use POST.", build: BUILD_MARKER });
  }

  const API_BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/+$/, "");
  const VERSION = process.env.GHL_API_VERSION || "2021-07-28";
  const TOKEN = process.env.GHL_TOKEN;

  const tokenPrefix = TOKEN ? TOKEN.slice(0, 12) : null;

  if (!TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing env var: GHL_TOKEN",
      build: BUILD_MARKER,
      debug: { tokenPrefix, apiBase: API_BASE, version: VERSION }
    });
  }

  // Safe body parsing
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    body = {};
  }

  // Inputs
  const locationId = body.locationId || body.subAccountId || body.location_id || null;
  const name = body.name || body.title || null;
  const description = body.description || "";
  const productType = body.productType || body.type || "PHYSICAL";
  const availableInStore = typeof body.availableInStore === "boolean" ? body.availableInStore : true;

  const image = body.image || body.featuredImage || body.featured_image || "";
  const medias = Array.isArray(body.medias) ? body.medias : (Array.isArray(body.media) ? body.media : []);

  const collectionIdProvided =
    body.collectionId || body.collection_id || body.assignedCollectionId || null;

  const collectionName =
    body.collectionName || body.collection || body.collection_name || null;

  // REQUIRED by your account (based on 422)
  const altId = String(body.altId || body.externalId || body.external_id || `db-${Date.now()}`);
  const requestedAltType = String(body.altType || body.alt_type || "").trim();

  if (!locationId) {
    return res.status(400).json({
      ok: false,
      error: "Missing required field: locationId",
      build: BUILD_MARKER,
      debug: { tokenPrefix, locationId: null, apiBase: API_BASE, version: VERSION }
    });
  }
  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Missing required field: name",
      build: BUILD_MARKER,
      debug: { tokenPrefix, locationId, apiBase: API_BASE, version: VERSION }
    });
  }

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Version: VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  async function fetchJson(url, options = {}) {
    const resp = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });

    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status} ${resp.statusText}`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function normalizeString(s) {
    return String(s || "").trim().toLowerCase();
  }

  async function resolveCollectionId() {
    if (collectionIdProvided) return String(collectionIdProvided);
    if (!collectionName) return null;

    const target = normalizeString(collectionName);

    let limit = 100;
    let offset = 0;

    for (let page = 0; page < 10; page++) {
      const url = new URL(`${API_BASE}/products/collections`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("locationId", String(locationId));

      const data = await fetchJson(url.toString(), { method: "GET" });

      const list = data?.collections || data?.productCollections || data?.data || data?.items || [];
      const collections = Array.isArray(list) ? list : [];

      const found = collections.find((c) => {
        const n = c?.name || c?.title || c?.collectionName || c?.label || "";
        return normalizeString(n) === target;
      });

      if (found) return String(found._id || found.id || found.collectionId);
      if (!collections.length) break;

      const total =
        data?.total ||
        data?.count ||
        (typeof data?.meta?.total === "number" ? data.meta.total : null);

      offset += limit;
      if (typeof total === "number" && offset >= total) break;
    }

    return null;
  }

  async function createWithAltTypes(basePayload) {
    const candidates = [
      ...(requestedAltType ? [requestedAltType] : []),
      "CUSTOM",
      "EXTERNAL",
      "SKU",
      "BARCODE",
      "OTHER",
    ].filter(Boolean);

    let lastErr = null;

    for (const t of candidates) {
      try {
        const created = await fetchJson(`${API_BASE}/products/`, {
          method: "POST",
          body: JSON.stringify({
            ...basePayload,
            altId,
            altType: t,
          }),
        });
        return { created, usedAltType: t };
      } catch (err) {
        lastErr = err;
        const msg = err?.data?.message;
        const joined = Array.isArray(msg) ? msg.join(" | ") : String(msg || "");
        const isAltError =
          err?.status === 422 &&
          (joined.toLowerCase().includes("altid") || joined.toLowerCase().includes("alttype"));
        if (!isAltError) throw err;
      }
    }

    throw lastErr || new Error("Unable to create product: altType not accepted.");
  }

  try {
    const resolvedCollectionId = await resolveCollectionId();

    const baseCreatePayload = {
      name,
      description,
      locationId,
      availableInStore,
      productType,
      image,
      medias,
      ...(resolvedCollectionId
        ? {
            assignedCollectionId: resolvedCollectionId,
            collectionId: resolvedCollectionId,
            collectionIds: [resolvedCollectionId],
          }
        : {}),
    };

    // CREATE
    const { created, usedAltType } = await createWithAltTypes(baseCreatePayload);

    const productId =
      created?._id ||
      created?.id ||
      created?.product?._id ||
      created?.product?.id ||
      created?.productId;

    if (!productId) {
      return res.status(500).json({
        ok: false,
        error: "Create succeeded but productId was not returned in a recognizable field.",
        build: BUILD_MARKER,
        created,
        debug: { tokenPrefix, locationId, apiBase: API_BASE, version: VERSION }
      });
    }

    // If no collection target, done.
    if (!resolvedCollectionId) {
      return res.status(201).json({
        ok: true,
        ghlProductId: String(productId),
        enforced: false,
        verified: false,
        collection: null,
        alt: { altId, altType: usedAltType },
        build: BUILD_MARKER,
        created,
        debug: { tokenPrefix, locationId, apiBase: API_BASE, version: VERSION }
      });
    }

    // ENFORCE collection post-create
    const enforcedResponse = await fetchJson(`${API_BASE}/products/${encodeURIComponent(String(productId))}`, {
      method: "PUT",
      body: JSON.stringify({
        locationId,
        assignedCollectionId: resolvedCollectionId,
        collectionId: resolvedCollectionId,
        collectionIds: [resolvedCollectionId],
      }),
    });

    // VERIFY
    const verifiedProduct = await fetchJson(`${API_BASE}/products/${encodeURIComponent(String(productId))}`, {
      method: "GET",
    });

    const assigned =
      verifiedProduct?.assignedCollectionId ||
      verifiedProduct?.collectionId ||
      (Array.isArray(verifiedProduct?.collectionIds) ? verifiedProduct.collectionIds[0] : null) ||
      verifiedProduct?.product?.assignedCollectionId ||
      verifiedProduct?.product?.collectionId ||
      (Array.isArray(verifiedProduct?.product?.collectionIds) ? verifiedProduct.product.collectionIds[0] : null) ||
      null;

    const verified = String(assigned || "") === String(resolvedCollectionId);

    return res.status(201).json({
      ok: true,
      ghlProductId: String(productId),
      collection: {
        resolvedCollectionId: String(resolvedCollectionId),
        collectionName: collectionName || null,
      },
      enforced: true,
      verified,
      assignedCollectionIdSeenOnGet: assigned || null,
      alt: { altId, altType: usedAltType },
      build: BUILD_MARKER,
      created,
      enforcedResponse,
      verifiedProduct,
      debug: { tokenPrefix, locationId, apiBase: API_BASE, version: VERSION }
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "Unknown error",
      status,
      details: err?.data || null,
      build: BUILD_MARKER,
      debug: { tokenPrefix, locationId: locationId || null, apiBase: API_BASE, version: VERSION }
    });
  }
}
