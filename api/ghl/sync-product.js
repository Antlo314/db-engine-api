// File: /api/ghl/sync-product.js
// DB ENGINE CANONICAL v10 + OPTIONAL UPSERT (SKU/externalId) + MULTI-IMAGE SUPPORT BASE
//
// Baseline behavior unchanged unless you pass: { upsert: true, sku: "..."} (or externalId)
// - If upsert is NOT true -> always creates a new product (exactly like v10)
// - If upsert IS true and a key exists -> updates existing product + price instead of creating duplicates
// - Optional mapping store using Vercel KV (@vercel/kv). If not configured, we fallback to a "tagged name" strategy.
//   Recommended: set KV_REST_API_URL + KV_REST_API_TOKEN in Vercel env (from Vercel KV / Upstash)

let kv = null;
async function getKV() {
  if (kv) return kv;
  try {
    // Lazy import so this file still deploys even if @vercel/kv isn't installed yet
    const mod = await import("@vercel/kv");
    kv = mod.kv;
    return kv;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const BUILD_MARKER =
    "DB_ENGINE_API_BUILD_2026-01-20_CANONICAL_v10_QP_LOCATIONID__UPSERT_SKU_v1";

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API is live. Use POST with JSON body.",
      upsert: {
        supported: true,
        note: "Pass { upsert:true, sku:'...', externalId:'...' } to prevent duplicates.",
      },
    });
  }

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, error: "Method not allowed", build: BUILD_MARKER });
  }

  // --- Safe body parsing ---
  let body = {};
  try {
    body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
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
    return res
      .status(500)
      .json({ ok: false, build: BUILD_MARKER, error: "Missing env var: GHL_TOKEN" });
  }
  if (!locationId) {
    return res.status(400).json({
      ok: false,
      build: BUILD_MARKER,
      error:
        "Missing locationId. Provide locationId in JSON body or set env var GHL_LOCATION_ID.",
    });
  }

  // Tenant requirement:
  // - altId + altType MUST be query params
  // - locationId MUST ALSO be on query params
  const altType = "location";
  const altId = locationId;

  const tokenPrefix = String(token).slice(0, 12);

  function withTenantParams(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
    u.searchParams.set("locationId", locationId); // CRITICAL FIX
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
    if (!hit) return null;

    const id = normalizeCollectionId(hit);
    return id ? { ...hit, __resolvedId: String(id) } : { ...hit, __resolvedId: null };
  }

  // ---------- Product update (full payload required on your tenant) ----------
  async function putProduct(productId, payload) {
    return await ghlFetch(`/products/${productId}`, { method: "PUT", json: payload });
  }

  async function createProduct(payload) {
    return await ghlFetch(`/products/`, { method: "POST", json: payload });
  }

  // ---------- Price create / update ----------
  async function createPrice(productId, pricePayload) {
    return await ghlFetch(`/products/${productId}/price`, {
      method: "POST",
      json: pricePayload,
    });
  }

  // Some tenants expose PUT /products/:productId/price/:priceId. If your tenant rejects it,
  // we will fallback to creating a new price (but that can create duplicates).
  async function putPrice(productId, priceId, payload) {
    return await ghlFetch(`/products/${productId}/price/${priceId}`, {
      method: "PUT",
      json: payload,
    });
  }

  async function listPrices(productId) {
    // Best-effort: some tenants support GET /products/:productId/price
    // If unsupported, it will throw; we'll handle upstream.
    return await ghlFetch(`/products/${productId}/price`, { method: "GET" });
  }

  async function getProduct(productId) {
    return await ghlFetch(`/products/${productId}`, { method: "GET" });
  }

  // ---------- Inputs ----------
  const rawName = String(body.name || "").trim();
  const description = String(body.description || "").trim(); // plain text only, no HTML
  const collectionName = String(body.collectionName || body.collection || "").trim();

  // Single-image legacy
  const image = String(body.image || body.imageUrl || "").trim();

  // Multi-image support (optional, non-breaking)
  // Accept: images: [url1,url2,...] or medias: [{url,title,type,isFeatured}, ...]
  const imagesArr = Array.isArray(body.images)
    ? body.images.map((u) => String(u || "").trim()).filter(Boolean)
    : [];

  const providedMedias = Array.isArray(body.medias) ? body.medias : null;

  const availableInStore = body.availableInStore === false ? false : true; // default true
  const productType = String(body.productType || "PHYSICAL").trim().toUpperCase();

  // Price inputs: allow { price: { amount, compareAt, currency, sku, ... } } OR legacy flat price/amount
  const priceObj =
    body && typeof body.price === "object" && body.price !== null ? body.price : null;

  const priceAmount =
    priceObj?.amount ?? body.price ?? body.amount ?? null;

  const compareAt =
    priceObj?.compareAt ?? body.compareAt ?? body.compareAtPrice ?? null;

  const currency = String(priceObj?.currency || body.currency || "USD").trim();
  const priceType = String(priceObj?.type || body.priceType || "one_time").trim();

  // Optional SEO best-effort (tenant dependent)
  const seoTitle = String(body.seoTitle || "").trim();
  const seoDescription = String(body.seoDescription || "").trim();

  // --- UPSERT controls (optional) ---
  const upsert = body.upsert === true;

  // Upsert keys
  const sku = String(body.sku || priceObj?.sku || "").trim();
  const externalId = String(body.externalId || body.upc || body.upsertKey || "").trim();

  // Dedupe key priority: sku > externalId
  const dedupeKeyRaw = sku || externalId;
  const dedupeKey = dedupeKeyRaw ? dedupeKeyRaw.toLowerCase() : "";

  if (!rawName) {
    return res.status(400).json({
      ok: false,
      build: BUILD_MARKER,
      error: "Missing required field: name",
    });
  }
  if (!collectionName) {
    return res.status(400).json({
      ok: false,
      build: BUILD_MARKER,
      error: "Missing required field: collectionName",
    });
  }

  // If user requests upsert but provides no key, fail early (to avoid accidental duplicates)
  if (upsert && !dedupeKey) {
    return res.status(400).json({
      ok: false,
      build: BUILD_MARKER,
      error:
        "Upsert requested but no dedupe key provided. Include sku or externalId (or upc/upsertKey).",
    });
  }

  // ---- Name strategy for fallback (no KV) ----
  // Only used when upsert:true AND KV is not available/configured.
  // We do NOT change user-facing names in baseline create mode.
  const TAG_PREFIX = "DBE";
  const taggedName = dedupeKey ? `[${TAG_PREFIX}:${dedupeKey}] ${rawName}` : rawName;

  // ---- Optional: list products + find by taggedName (fallback) ----
  async function listProductsByNameSearch(searchTerm) {
    // Best-effort endpoint: /products?search=... (not guaranteed on every tenant).
    // If not supported, this will throw. We'll handle upstream.
    const u = new URL(`${API_BASE}/products/`);
    u.searchParams.set("search", String(searchTerm || "").slice(0, 64));
    // Inject tenant params via withTenantParams
    const url = withTenantParams(u.toString());

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: VERSION,
        "Content-Type": "application/json",
      },
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
    const arr = data?.products || data?.data || data?.items || (Array.isArray(data) ? data : []);
    return Array.isArray(arr) ? arr : [];
  }

  function normalizeProductId(p) {
    return p?._id || p?.id || p?.productId || null;
  }

  // ---- Media building ----
  function buildMediasPayload() {
    // Priority order:
    // 1) if medias array provided -> normalize and keep
    // 2) else if images[] provided -> convert
    // 3) else if legacy image -> single featured
    if (providedMedias && providedMedias.length) {
      const cleaned = providedMedias
        .map((m, idx) => {
          const url = String(m?.url || "").trim();
          if (!url) return null;
          const isFeatured = m?.isFeatured === true || idx === 0;
          return {
            id: String(m?.id || crypto.randomUUID()),
            title: String(m?.title || rawName).trim() || rawName,
            url,
            type: String(m?.type || "image").trim(),
            isFeatured,
          };
        })
        .filter(Boolean);

      return cleaned.length ? cleaned : undefined;
    }

    if (imagesArr.length) {
      return imagesArr.map((url, idx) => ({
        id: crypto.randomUUID(),
        title: rawName,
        url,
        type: "image",
        isFeatured: idx === 0,
      }));
    }

    if (image) {
      return [
        {
          id: crypto.randomUUID(),
          title: rawName,
          url: image,
          type: "image",
          isFeatured: true,
        },
      ];
    }

    return undefined;
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

    const mediasPayload = buildMediasPayload();
    const featuredImageUrl =
      mediasPayload?.find((m) => m?.isFeatured)?.url || image || imagesArr[0] || "";

    // 2) Build product payload (baseline: v10)
    // IMPORTANT: your tenant requires FULL payload on PUT.
    const baseProductPayload = {
      name: rawName,
      description: description || undefined,
      locationId,
      productType,
      availableInStore,
      collectionIds: [resolvedCollectionId],
      image: featuredImageUrl || undefined,
      medias: mediasPayload,
    };

    if (seoTitle) baseProductPayload.seoTitle = seoTitle;
    if (seoDescription) baseProductPayload.seoDescription = seoDescription;

    // 3) UPSERT RESOLUTION
    // Strategy:
    // - If upsert:true, attempt KV lookup -> update existing
    // - Else fallback search by tagged name -> update existing (only if we previously created tagged products)
    // - Else create new product (v10 baseline)
    const kvClient = await getKV();

    const kvKey = dedupeKey ? `dbe:map:${locationId}:${dedupeKey}` : null;

    async function kvGetMap() {
      if (!kvClient || !kvKey) return null;
      try {
        const val = await kvClient.get(kvKey);
        // expected: { productId, priceId }
        if (val && typeof val === "object") return val;
        return null;
      } catch {
        return null;
      }
    }

    async function kvSetMap(obj) {
      if (!kvClient || !kvKey) return false;
      try {
        // Persist indefinitely. You can add TTL later if desired.
        await kvClient.set(kvKey, obj);
        return true;
      } catch {
        return false;
      }
    }

    let mode = "create";
    let map = null;
    let existingProductId = null;
    let existingPriceId = null;

    if (upsert) {
      map = await kvGetMap();
      existingProductId = map?.productId ? String(map.productId) : null;
      existingPriceId = map?.priceId ? String(map.priceId) : null;

      if (!existingProductId && !kvClient) {
        // Fallback: attempt to find by tagged name
        try {
          const products = await listProductsByNameSearch(`[${TAG_PREFIX}:${dedupeKey}]`);
          const hit =
            products.find((p) => String(p?.name || "").includes(`[${TAG_PREFIX}:${dedupeKey}]`)) ||
            products.find((p) => String(p?.name || "").trim() === taggedName) ||
            null;

          const pid = hit ? normalizeProductId(hit) : null;
          if (pid) existingProductId = String(pid);
        } catch {
          // ignore search failure; we will create
        }
      }

      if (existingProductId) mode = "update";
    }

    // 4) Create or Update product
    let created = null;
    let enforced = null;
    let productId = null;

    if (mode === "update") {
      productId = existingProductId;

      // Update product (PUT full payload). Name behavior:
      // - If KV-backed update, we keep the clean name (rawName).
      // - If fallback-tagged update (no KV), we keep tagged name to remain searchable.
      const putPayload =
        !kvClient
          ? { ...baseProductPayload, name: taggedName }
          : { ...baseProductPayload, name: rawName };

      try {
        enforced = await putProduct(String(productId), putPayload);
      } catch (e) {
        enforced = { __error: true, status: e?.status || 500, details: e?.data || null };
      }
    } else {
      // CREATE MODE (baseline v10). Name remains clean unless:
      // - upsert:true AND no KV configured -> we create taggedName so we can find it later
      const createPayload =
        upsert && !kvClient
          ? { ...baseProductPayload, name: taggedName }
          : { ...baseProductPayload, name: rawName };

      created = await createProduct(createPayload);

      productId =
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

      // Enforce store toggle + collection via PUT (FULL REQUIRED PAYLOAD)
      try {
        enforced = await putProduct(String(productId), {
          ...(upsert && !kvClient ? { ...baseProductPayload, name: taggedName } : baseProductPayload),
        });
      } catch (e) {
        enforced = { __error: true, status: e?.status || 500, details: e?.data || null };
      }
    }

    // 5) Price create / update (if provided)
    let priceResp = null;
    let priceAction = "none";

    const hasPrice =
      priceAmount !== null &&
      priceAmount !== undefined &&
      String(priceAmount).trim() !== "";

    if (hasPrice) {
      const amountNum = Number(priceAmount);
      if (!Number.isFinite(amountNum) || amountNum < 0) {
        return res.status(400).json({
          ok: false,
          build: BUILD_MARKER,
          error: "Invalid price. Provide a numeric price >= 0.",
        });
      }

      const compareAtNum =
        compareAt !== null && compareAt !== undefined && String(compareAt).trim() !== ""
          ? Number(compareAt)
          : null;

      if (compareAtNum !== null && (!Number.isFinite(compareAtNum) || compareAtNum < 0)) {
        return res.status(400).json({
          ok: false,
          build: BUILD_MARKER,
          error: "Invalid compareAt price. Provide a numeric compareAt >= 0.",
        });
      }

      // Build price payload
      const pricePayload = {
        product: String(productId),
        locationId,
        name: `${rawName} - Price`,
        type: priceType,
        currency,
        amount: amountNum,
        description: description || undefined,
      };

      // sku is supported on price objects; include when provided
      if (sku) pricePayload.sku = sku;

      // compareAt support is tenant-dependent; include only if provided
      if (compareAtNum !== null) pricePayload.compareAt = compareAtNum;

      if (mode === "update" && existingPriceId) {
        // Try to update existing price
        priceAction = "update";
        try {
          priceResp = await putPrice(String(productId), String(existingPriceId), pricePayload);
        } catch (e) {
          // Fallback: try to locate a price by SKU (if listing is supported)
          let foundPriceId = null;
          if (sku) {
            try {
              const prices = await listPrices(String(productId));
              const arr = prices?.prices || prices?.data || prices?.items || (Array.isArray(prices) ? prices : []);
              const list = Array.isArray(arr) ? arr : [];
              const hit =
                list.find((p) => String(p?.sku || "").trim().toLowerCase() === sku.toLowerCase()) ||
                null;
              const pid = hit?._id || hit?.id || null;
              if (pid) foundPriceId = String(pid);
            } catch {
              // ignore
            }
          }

          if (foundPriceId) {
            try {
              priceResp = await putPrice(String(productId), String(foundPriceId), pricePayload);
              existingPriceId = foundPriceId;
              priceAction = "update_by_sku";
            } catch (e2) {
              // Final fallback: create new price (may create duplicates if tenant doesn't support price update)
              try {
                priceResp = await createPrice(String(productId), pricePayload);
                priceAction = "create_fallback_after_failed_update";
              } catch (e3) {
                priceResp = { __error: true, status: e3?.status || 500, details: e3?.data || null };
                priceAction = "failed";
              }
            }
          } else {
            // Create as fallback
            try {
              priceResp = await createPrice(String(productId), pricePayload);
              priceAction = "create_fallback_after_failed_update";
            } catch (e3) {
              priceResp = { __error: true, status: e3?.status || 500, details: e3?.data || null };
              priceAction = "failed";
            }
          }
        }
      } else {
        // Create price (v10 baseline)
        priceAction = "create";
        try {
          priceResp = await createPrice(String(productId), pricePayload);
        } catch (e) {
          priceResp = { __error: true, status: e?.status || 500, details: e?.data || null };
          priceAction = "failed";
        }
      }
    }

    // 6) Persist mapping (KV) when upsert requested and we have a dedupe key
    // We only persist when we can confidently identify productId and (optionally) priceId.
    let mapping = null;
    let mappingSaved = false;

    if (upsert && dedupeKey) {
      // Extract priceId from responses if present
      const priceId =
        priceResp?.price?._id ||
        priceResp?.price?.id ||
        priceResp?._id ||
        priceResp?.id ||
        existingPriceId ||
        null;

      mapping = { productId: String(productId), priceId: priceId ? String(priceId) : null };

      if (kvClient) {
        mappingSaved = await kvSetMap(mapping);
      }
    }

    // 7) Verify
    const verified = await getProduct(String(productId));
    const productObj = verified?.product || verified || null;

    return res.status(mode === "update" ? 200 : 201).json({
      ok: true,
      build: BUILD_MARKER,
      mode,
      upsert: {
        enabled: upsert,
        dedupeKey: dedupeKey || null,
        usedKV: Boolean(await getKV()),
        mappingKey: kvKey || null,
        mapping,
        mappingSaved,
        priceAction,
      },
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
