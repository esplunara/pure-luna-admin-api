var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
var GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
var REQUIRED_CONTENT_FIELDS = [];
var ROUTE_META_FIELDS = /* @__PURE__ */ new Set([
  "id",
  "route_id",
  "route",
  "slug",
  "path",
  "url",
  "url_path",
  "language",
  "lang",
  "locale",
  "audience",
  "audience_id",
  "product",
  "product_id",
  "product_slug",
  "status",
  "template",
  "page_type",
  "content",
  "seo",
  "metadata",
  "created_at",
  "updated_at"
]);
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(jsonResponse, "jsonResponse");
function unauthorized() {
  return jsonResponse(
    {
      ok: false,
      error: "Unauthorized"
    },
    401
  );
}
__name(unauthorized, "unauthorized");
function forbiddenMethod() {
  return jsonResponse(
    {
      ok: false,
      error: "Method not allowed"
    },
    405
  );
}
__name(forbiddenMethod, "forbiddenMethod");
function notFound() {
  return jsonResponse(
    {
      ok: false,
      error: "Not found"
    },
    404
  );
}
__name(notFound, "notFound");
function requireEnv(env, key) {
  const value = env[key];
  if (!value || typeof value !== "string") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
__name(requireEnv, "requireEnv");
function base64UrlEncode(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(base64UrlEncode, "base64UrlEncode");
function pemToArrayBuffer(pem) {
  const normalizedPem = pem.replace(/\\n/g, "\n").trim();
  const base64 = normalizedPem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
__name(pemToArrayBuffer, "pemToArrayBuffer");
async function createGoogleJwt(env) {
  const clientEmail = requireEnv(env, "GOOGLE_CLIENT_EMAIL");
  const privateKey = requireEnv(env, "GOOGLE_PRIVATE_KEY");
  const now = Math.floor(Date.now() / 1e3);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const payload = {
    iss: clientEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const keyData = pemToArrayBuffer(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
__name(createGoogleJwt, "createGoogleJwt");
async function getGoogleAccessToken(env) {
  const jwt = await createGoogleJwt(env);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token request failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Google token response did not include access_token");
  }
  return data.access_token;
}
__name(getGoogleAccessToken, "getGoogleAccessToken");
async function fetchBundleJsonString(env) {
  const sheetId = requireEnv(env, "GOOGLE_SHEETS_ID");
  const accessToken = await getGoogleAccessToken(env);
  const range = env.GOOGLE_SHEET_RANGE || "export_json_bundle!A2:A2";
  const encodedRange = encodeURIComponent(range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodedRange}?majorDimension=ROWS`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Sheets request failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  const rawJson = data.values?.[0]?.[0];
  if (!rawJson || typeof rawJson !== "string") {
    throw new Error(`No JSON bundle found at range ${range}`);
  }
  return rawJson;
}
__name(fetchBundleJsonString, "fetchBundleJsonString");
function getContentSource(routeRecord) {
  if (routeRecord.content && typeof routeRecord.content === "object" && !Array.isArray(routeRecord.content)) {
    return routeRecord.content;
  }
  const contentSource = {};
  for (const [key, value] of Object.entries(routeRecord)) {
    if (!ROUTE_META_FIELDS.has(key)) {
      contentSource[key] = value;
    }
  }
  return contentSource;
}
__name(getContentSource, "getContentSource");
function validateBundle(bundle, env) {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Bundle is not an object");
  }
  const record = bundle;
  const expectedVersion = env.EXPECTED_BUNDLE_VERSION || "mvp-v1";
  const expectedRouteCount = Number(env.EXPECTED_ROUTE_COUNT || "6");
  const expectedContentFieldCount = Number(env.EXPECTED_CONTENT_FIELD_COUNT || "27");
  if (record.version !== expectedVersion) {
    throw new Error(`Invalid bundle version. Expected ${expectedVersion}`);
  }
  const routes = record.routes;
  if (!Array.isArray(routes)) {
    throw new Error("Bundle routes is not an array");
  }
  if (routes.length !== expectedRouteCount) {
    throw new Error(`Invalid route count. Expected ${expectedRouteCount}, got ${routes.length}`);
  }
  const declaredRouteCount = record.route_count;
  if (typeof declaredRouteCount === "number" && declaredRouteCount !== expectedRouteCount) {
    throw new Error(
      `Invalid declared route_count. Expected ${expectedRouteCount}, got ${declaredRouteCount}`
    );
  }
  const contentSources = [];
  for (const [index, route] of routes.entries()) {
    if (!route || typeof route !== "object") {
      throw new Error(`Route at index ${index} is not an object`);
    }
    const routeRecord = route;
    if (routeRecord.status !== "active") {
      throw new Error(`Route at index ${index} is not active`);
    }
    const contentSource = getContentSource(routeRecord);
    contentSources.push(contentSource);
  }
  if (contentSources.length === 0) {
    throw new Error("Bundle has no content sources to validate");
  }
  if (REQUIRED_CONTENT_FIELDS.length > 0) {
    if (REQUIRED_CONTENT_FIELDS.length !== expectedContentFieldCount) {
      throw new Error(
        `REQUIRED_CONTENT_FIELDS must contain exactly ${expectedContentFieldCount} fields. Current count: ${REQUIRED_CONTENT_FIELDS.length}`
      );
    }
    for (const [index, contentSource] of contentSources.entries()) {
      for (const field of REQUIRED_CONTENT_FIELDS) {
        if (!(field in contentSource)) {
          throw new Error(`Route at index ${index} is missing required field: ${field}`);
        }
        const value = contentSource[field];
        if (value === null || value === void 0 || value === "") {
          throw new Error(`Route at index ${index} has empty required field: ${field}`);
        }
      }
    }
    return;
  }
  const firstContentSource = contentSources[0];
  const discoveredFields = Object.keys(firstContentSource).filter((field) => {
    const value = firstContentSource[field];
    return value !== null && value !== void 0 && value !== "";
  });
  if (discoveredFields.length !== expectedContentFieldCount) {
    throw new Error(
      `Invalid discovered content field count. Expected ${expectedContentFieldCount}, got ${discoveredFields.length}. Fields: ${discoveredFields.join(", ")}`
    );
  }
  for (const [index, contentSource] of contentSources.entries()) {
    const currentFields = Object.keys(contentSource).filter((field) => {
      const value = contentSource[field];
      return value !== null && value !== void 0 && value !== "";
    });
    for (const field of discoveredFields) {
      if (!(field in contentSource)) {
        throw new Error(`Route at index ${index} is missing discovered field: ${field}`);
      }
      const value = contentSource[field];
      if (value === null || value === void 0 || value === "") {
        throw new Error(`Route at index ${index} has empty discovered field: ${field}`);
      }
    }
    const extraFields = currentFields.filter((field) => !discoveredFields.includes(field));
    if (extraFields.length > 0) {
      throw new Error(
        `Route at index ${index} has unexpected extra content fields: ${extraFields.join(", ")}`
      );
    }
  }
}
__name(validateBundle, "validateBundle");
async function handleContentBundle(request, env) {
  if (request.method !== "GET") {
    return forbiddenMethod();
  }
  const expectedToken = requireEnv(env, "PURE_LUNA_BUILD_TOKEN");
  const authorization = request.headers.get("Authorization") || "";
  const expectedAuthorization = `Bearer ${expectedToken}`;
  if (authorization !== expectedAuthorization) {
    return unauthorized();
  }
  const rawJson = await fetchBundleJsonString(env);
  let bundle;
  try {
    bundle = JSON.parse(rawJson);
  } catch {
    throw new Error("JSON bundle from Google Sheets is not valid JSON");
  }
  validateBundle(bundle, env);
  return new Response(JSON.stringify(bundle), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(handleContentBundle, "handleContentBundle");
var src_default = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/content-bundle") {
        return await handleContentBundle(request, env);
      }
      return notFound();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return jsonResponse(
        {
          ok: false,
          error: message
        },
        500
      );
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-nqRiga/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-nqRiga/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
