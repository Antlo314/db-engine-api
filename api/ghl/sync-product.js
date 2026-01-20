// File: /api/ghl/sync-product.js
// DB ENGINE CANONICAL v10 + UPSERT + MULTI-IMAGE + COMPARE-AT + INVENTORY + SEO + PRICE DEDUPE
//
// Baseline preserved:
// - If upsert !== true -> behaves like v10 (always creates new product, creates new price if provided)
// - If upsert === true -> dedupe product by SKU/externalId and enforce single active price per SKU
//
// Optional KV mapping (recommended):
// - If @vercel/kv is available + KV env configured, store mapping: dedupeKey -> { productId, priceId }
// - If not, fallback to tagged product name strategy: "[DBE:<key>] <name>" so it can be found again.
//
// Tenant variability:
// - Price PUT may not be supported. In that case, we dedupe by deleting old price (if delete supported) then create.
// - Inventory fields may not be supported; we attempt best-effort fields and ignore if rejected.
// - SEO fields tenant-dependent; best-effort.

let kv = null;
async function getKV() {
  if (kv) return kv;
  try {
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
    "DB_ENGINE_API_BUILD_2026-01-20_CANONICAL_v10_QP_LOCATIONID__ALL_EXCEPT_EBAY_v1";

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl/sync-product",
      build: BUILD_MARKER,
      message: "DB Engine API is live. Use POST with JSON body.",
      features: {
        upsert: true,
        multiImages: true,
        compareAt: true,
        inventoryBestEffort: true,
        seoBestEffort: true,
        priceDedupe: true,
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

  // Tenant requirement: altId + altType + locationId MUST be query params
  const altType = "location";
  const altId = locationId;

  const tokenPrefix = String(token).slice(0, 12);

  function withTenantParams(url) {
    const u = new URL(url);
    u.searchParams.set("altId", altId);
    u.searchParams.set("altType", altType);
    u.searchParams.set("locationId", locationId);
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

  // ---------- Products ----------
  async function createProduct(payload) {
    return await ghlFetch(`/products/`, { method: "POST", json: payload });
  }
  async function putProduct(productId, payload) {
    return await ghlFetch(`/products/${productId}`, { method: "PUT", json: payload });
  }
  async function getProduct(productId) {
    return await ghlFetch(`/products/${productId}`, { method: "GET" });
  }

  // ---------- Prices ----------
  async function createPrice(productId, pricePayload) {
    return await ghlFetch(`/products/${productId}/price`, {
      method: "POST",
      json: pricePayload,
    });
  }
  async function putPrice(productId, priceId, payload) {
    return await ghlFetch(`/products/${productId}/price/${priceId}`, {
      method: "PUT",
      json: payload,
    });
  }
  async function listPrices(productId) {
    return await ghlFetch(`/products/${productId}/price`, { method: "GET" });
  }
  async function deletePrice(productId, priceId) {
    // Tenant-dependent. If unsupported, it will throw.
    return await ghlFetch(`/products/${productId}/price/${priceId}`, {
      method: "DELETE",
    });
  }

  // ---------- Fallback product search (no KV) ----------
  const TAG_PREFIX = "DBE";
  async function listProductsByNameSearch(searchTerm) {
    const u = new URL(`${API_BASE}/products/`);
    u.searchParams.set("search", String(searchTerm || "").slice(0, 64));
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

    const arr =
      data?.products || data?.data || data?.items || (Array.isArray(data) ? data : []);
    return Array.isArray(arr) ? arr : [];
  }
  function normalizeProductId(p) {
    return p?._id || p?.id || p?.productId || null;
  }

  // ---------- Inputs ----------
  const rawName = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const collectionName = String(body.collectionName || body.collection || "").trim();

  // media inputs
  const image = String(body.image || body.imageUrl || "").trim();
  const imagesArr = Array.isArray(body.images)
    ? body.images.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  const providedMedias = Array.isArray(body.medias) ? body.medias : null;

  const availableInStore = body.availableInStore === false ? false : true;
  const productType = String(body.productType || "PHYSICAL").trim().toUpperCase();

  // SEO best-effort
  const seoTitle = String(body.seoTitle || "").trim();
  const seoDescription = String(body.seoDescription || "").trim();
  const seoSlug = String(body.seoSlug || body.slug || "").trim();

  // Inventory best-effort
  // (Different tenants use different fields; we try a safe set and ignore if rejected)
  const trackInventory =
    body.trackInventory === true || body.inventoryTracking === true;
  const availableQty =
    body.availableQty ?? body.qty ?? body.inventory ?? body.stock ?? null;

  // Pricing
  const priceObj =
    body && typeof body.price === "object" && body.price !== null ? body.price : null;

  const priceAmount =
    priceObj?.amount ?? body.price ?? body.amount ?? null;
  const compareAt =
    priceObj?.compareAt ?? body.compareAt ?? body.compareAtPrice ?? null;
  const currency = String(priceObj?.currency || body.currency || "USD").trim();
  const priceType = String(priceObj?.type || body.priceType || "one_time").trim();

  // Upsert controls
  const upsert = body.upsert === true;
  const sku = String(body.sku || priceObj?.sku || "").trim();
  const externalId = String(body.externalId || body.upc || body.upsertKey || "").trim();

  const dedupeKeyRaw = sku || externalId;
  const dedupeKey = dedupeKeyRaw ? dedupeKeyRaw.toLowerCase() : "";

  if (!rawName) {
    return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing required field: name" });
  }
  if (!collectionName) {
    return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Missing required field: collectionName" });
  }
  if (upsert && !dedupeKey) {
    return res.status(400).json({
      ok: false,
      build: BUILD_MARKER,
      error: "Upsert requested but no dedupe key provided. Include sku or externalId (or upc/upsertKey).",
    });
  }

  const taggedName = dedupeKey ? `[${TAG_PREFIX}:${dedupeKey}] ${rawName}` : rawName;

  function buildMediasPayload() {
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
        { id: crypto.randomUUID(), title: rawName, url: image, type: "image", isFeatured: true },
      ];
    }

    return undefined;
  }

  // Helper: find existing price by SKU in returned list
  function normalizePriceId(p) {
    return p?._id || p?.id || p?.priceId || null;
  }
  function extractPricesArray(pricesResp) {
    const arr =
      pricesResp?.prices || pricesResp?.data || pricesResp?.items || (Array.isArray(pricesResp) ? pricesResp : []);
    return Array.isArray(arr) ? arr : [];
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
          collectionsSeen: collections.slice(0, 25).map((c) => ({ name: c?.name, id: normalizeCollectionId(c) })),
        },
      });
    }

    const resolvedCollectionId = matched.__resolvedId;

    // 2) Media + featured image
    const mediasPayload = buildMediasPayload();
    const featuredImageUrl =
      mediasPayload?.find((m) => m?.isFeatured)?.url || image || imagesArr[0] || "";

    // 3) Build product payload (FULL payload for PUT)
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

    // SEO best-effort fields
    if (seoTitle) baseProductPayload.seoTitle = seoTitle;
    if (seoDescription) baseProductPayload.seoDescription = seoDescription;
    if (seoSlug) baseProductPayload.seoSlug = seoSlug;

    // Inventory best-effort fields on product (tenant dependent)
    // We do NOT hard-fail if tenant rejects these; they simply won't apply.
    if (trackInventory === true) baseProductPayload.trackInventory = true;
    if (availableQty !== null && availableQty !== undefined && String(availableQty).trim() !== "") {
      const q = Number(availableQty);
      if (Number.isFinite(q) && q >= 0) {
        baseProductPayload.availableQuantity = q;
        baseProductPayload.quantity = q; // some tenants use "quantity"
      }
    }

    // 4) UPSERT RESOLUTION
    const kvClient = await getKV();
    const kvKey = dedupeKey ? `dbe:map:${locationId}:${dedupeKey}` : null;

    async function kvGetMap() {
      if (!kvClient || !kvKey) return null;
      try {
        const val = await kvClient.get(kvKey);
        if (val && typeof val === "object") return val;
        return null;
      } catch {
        return null;
      }
    }
    async function kvSetMap(obj) {
      if (!kvClient || !kvKey) return false;
      try {
        await kvClient.set(kvKey, obj);
        return true;
      } catch {
        return false;
      }
    }

    let mode = "create";
    let map = null;
    let productId = null;
    let existingPriceId = null;

    if (upsert) {
      map = await kvGetMap();
      if (map?.productId) {
        productId = String(map.productId);
        existingPriceId = map?.priceId ? String(map.priceId) : null;
        mode = "update";
      } else if (!kvClient) {
        // fallback search by tagged name
        try {
          const products = await listProductsByNameSearch(`[${TAG_PREFIX}:${dedupeKey}]`);
          const hit =
            products.find((p) => String(p?.name || "").includes(`[${TAG_PREFIX}:${dedupeKey}]`)) ||
            products.find((p) => String(p?.name || "").trim() === taggedName) ||
            null;

          const pid = hit ? normalizeProductId(hit) : null;
          if (pid) {
            productId = String(pid);
            mode = "update";
          }
        } catch {
          // ignore
        }
      }
    }

    // 5) Create/Update product
    let created = null;
    let enforced = null;

    if (mode === "update") {
      const putPayload = !kvClient ? { ...baseProductPayload, name: taggedName } : baseProductPayload;
      try {
        enforced = await putProduct(String(productId), putPayload);
      } catch (e) {
        enforced = { __error: true, status: e?.status || 500, details: e?.data || null };
      }
    } else {
      const createPayload =
        upsert && !kvClient ? { ...baseProductPayload, name: taggedName } : baseProductPayload;

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

      // enforce with PUT (full payload)
      try {
        enforced = await putProduct(String(productId), createPayload);
      } catch (e) {
        enforced = { __error: true, status: e?.status || 500, details: e?.data || null };
      }
    }

    // 6) Price logic + de-dupe
    let priceResp = null;
    let priceAction = "none";
    let priceDedupe = { attempted: false, deleted: [], errors: [] };

    const hasPrice =
      priceAmount !== null && priceAmount !== undefined && String(priceAmount).trim() !== "";

    if (hasPrice) {
      const amountNum = Number(priceAmount);
      if (!Number.isFinite(amountNum) || amountNum < 0) {
        return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Invalid price. Provide a numeric price >= 0." });
      }

      const compareAtNum =
        compareAt !== null && compareAt !== undefined && String(compareAt).trim() !== ""
          ? Number(compareAt)
          : null;

      if (compareAtNum !== null && (!Number.isFinite(compareAtNum) || compareAtNum < 0)) {
        return res.status(400).json({ ok: false, build: BUILD_MARKER, error: "Invalid compareAt price. Provide a numeric compareAt >= 0." });
      }

      const pricePayload = {
        product: String(productId),
        locationId,
        name: `${rawName} - Price`,
        type: priceType,
        currency,
        amount: amountNum,
        description: description || undefined,
      };
      if (sku) pricePayload.sku = sku;
      if (compareAtNum !== null) pricePayload.compareAt = compareAtNum;

      if (upsert && sku) {
        // Always enforce single active price per SKU in upsert mode
        priceDedupe.attempted = true;

        // List prices and delete duplicates (best-effort)
        let existingPrices = [];
        try {
          const pricesResp = await listPrices(String(productId));
          existingPrices = extractPricesArray(pricesResp);
        } catch (e) {
          priceDedupe.errors.push({
            stage: "listPrices",
            status: e?.status || 500,
            details: e?.data || null,
          });
          existingPrices = [];
        }

        const skuLower = sku.toLowerCase();
        const matches = existingPrices.filter(
          (p) => String(p?.sku || "").trim().toLowerCase() === skuLower
        );

        // Delete every matching price (we will recreate the latest one).
        // This avoids needing PUT support for price update on restrictive tenants.
        for (const p of matches) {
          const pid = normalizePriceId(p);
          if (!pid) continue;
          try {
            await deletePrice(String(productId), String(pid));
            priceDedupe.deleted.push(String(pid));
          } catch (e) {
            priceDedupe.errors.push({
              stage: "deletePrice",
              priceId: String(pid),
              status: e?.status || 500,
              details: e?.data || null,
            });
          }
        }

        // Create fresh price
        priceAction = "dedupe_delete_then_create";
        try {
          priceResp = await createPrice(String(productId), pricePayload);
        } catch (e) {
          priceResp = { __error: true, status: e?.status || 500, details: e?.data || null };
          priceAction = "failed";
        }
      } else if (mode === "update" && existingPriceId) {
        // Try to update mapped priceId (if tenant supports PUT)
        priceAction = "update";
        try {
          priceResp = await putPrice(String(productId), String(existingPriceId), pricePayload);
        } catch (e) {
          // Fallback create
          try {
            priceResp = await createPrice(String(productId), pricePayload);
            priceAction = "create_fallback_after_failed_update";
          } catch (e2) {
            priceResp = { __error: true, status: e2?.status || 500, details: e2?.data || null };
            priceAction = "failed";
          }
        }
      } else {
        // Baseline create
        priceAction = "create";
        try {
          priceResp = await createPrice(String(productId), pricePayload);
        } catch (e) {
          priceResp = { __error: true, status: e?.status || 500, details: e?.data || null };
          priceAction = "failed";
        }
      }
    }

    // 7) Persist mapping (KV) if upsert and key present
    let mapping = null;
    let mappingSaved = false;

    if (upsert && dedupeKey) {
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

    // 8) Verify
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
      media: {
        featured: featuredImageUrl || null,
        count: Array.isArray(mediasPayload) ? mediasPayload.length : 0,
      },
      inventory: {
        trackInventoryRequested: trackInventory === true,
        qtyRequested: availableQty ?? null,
      },
      seo: {
        seoTitleRequested: seoTitle || null,
        seoDescriptionRequested: seoDescription || null,
        seoSlugRequested: seoSlug || null,
      },
      priceDedupe,
      price: priceResp,
      verified: productObj,
      debug: {
        tokenPrefix,
        locationId,
        productType,
        ghlUrlSample: withTenantParams(`${API_BASE}/products/${productId}`),
      },
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
