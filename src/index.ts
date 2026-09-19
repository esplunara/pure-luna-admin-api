type Env = {
  PURE_LUNA_BUILD_TOKEN: string;
  GOOGLE_SHEETS_ID: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;

  GOOGLE_SHEET_RANGE?: string;
  EXPECTED_BUNDLE_VERSION?: string;
  EXPECTED_ROUTE_COUNT?: string;
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

/**
 * Optional strict field list.
 *
 * For now this stays empty because the 27 field names are not clearly listed
 * in api_contract_v1.
 *
 * If this array is empty, the Worker will auto-discover content fields from
 * the first route and validate that all other routes have the same fields.
 */
const REQUIRED_CONTENT_FIELDS: readonly string[] = [];

const ROUTE_META_FIELDS = new Set([
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function unauthorized(): Response {
  return jsonResponse(
    {
      ok: false,
      error: "Unauthorized"
    },
    401
  );
}

function forbiddenMethod(): Response {
  return jsonResponse(
    {
      ok: false,
      error: "Method not allowed"
    },
    405
  );
}

function notFound(): Response {
  return jsonResponse(
    {
      ok: false,
      error: "Not found"
    },
    404
  );
}

function requireEnv(env: Env, key: keyof Env): string {
  const value = env[key];

  if (!value || typeof value !== "string") {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;

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

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalizedPem = pem.replace(/\\n/g, "\n").trim();

  const base64 = normalizedPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createGoogleJwt(env: Env): Promise<string> {
  const clientEmail = requireEnv(env, "GOOGLE_CLIENT_EMAIL");
  const privateKey = requireEnv(env, "GOOGLE_PRIVATE_KEY");

  const now = Math.floor(Date.now() / 1000);

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

async function getGoogleAccessToken(env: Env): Promise<string> {
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

  const data = await response.json() as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("Google token response did not include access_token");
  }

  return data.access_token;
}

async function fetchBundleJsonString(env: Env): Promise<string> {
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

  const data = await response.json() as {
    values?: string[][];
  };

  const rawJson = data.values?.[0]?.[0];

  if (!rawJson || typeof rawJson !== "string") {
    throw new Error(`No JSON bundle found at range ${range}`);
  }

  return rawJson;
}

function getContentSource(routeRecord: Record<string, unknown>): Record<string, unknown> {
  /**
   * Preferred structure:
   * route.content.field_name
   */
  if (
    routeRecord.content &&
    typeof routeRecord.content === "object" &&
    !Array.isArray(routeRecord.content)
  ) {
    return routeRecord.content as Record<string, unknown>;
  }

  /**
   * Fallback structure:
   * route.field_name
   *
   * In this case we remove known route metadata fields.
   */
  const contentSource: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(routeRecord)) {
    if (!ROUTE_META_FIELDS.has(key)) {
      contentSource[key] = value;
    }
  }

  return contentSource;
}

function validateBundle(bundle: unknown, env: Env): void {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Bundle is not an object");
  }

  const record = bundle as Record<string, unknown>;

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

  if (
    typeof declaredRouteCount === "number" &&
    declaredRouteCount !== expectedRouteCount
  ) {
    throw new Error(
      `Invalid declared route_count. Expected ${expectedRouteCount}, got ${declaredRouteCount}`
    );
  }

  const contentSources: Record<string, unknown>[] = [];

  for (const [index, route] of routes.entries()) {
    if (!route || typeof route !== "object") {
      throw new Error(`Route at index ${index} is not an object`);
    }

    const routeRecord = route as Record<string, unknown>;

    if (routeRecord.status !== "active") {
      throw new Error(`Route at index ${index} is not active`);
    }

    const contentSource = getContentSource(routeRecord);
    contentSources.push(contentSource);
  }

  if (contentSources.length === 0) {
    throw new Error("Bundle has no content sources to validate");
  }

  /**
   * Mode 1:
   * Strict manual field list exists.
   */
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

        if (value === null || value === undefined || value === "") {
          throw new Error(`Route at index ${index} has empty required field: ${field}`);
        }
      }
    }

    return;
  }

  /**
   * Mode 2:
   * Auto-discover content fields from the first route.
   *
   * This is the current recommended mode because the 27 field names are not
   * explicitly visible in api_contract_v1.
   */
  const firstContentSource = contentSources[0];

  const discoveredFields = Object.keys(firstContentSource).filter((field) => {
    const value = firstContentSource[field];
    return value !== null && value !== undefined && value !== "";
  });

  if (discoveredFields.length !== expectedContentFieldCount) {
    throw new Error(
      `Invalid discovered content field count. Expected ${expectedContentFieldCount}, got ${discoveredFields.length}. Fields: ${discoveredFields.join(", ")}`
    );
  }

  for (const [index, contentSource] of contentSources.entries()) {
    const currentFields = Object.keys(contentSource).filter((field) => {
      const value = contentSource[field];
      return value !== null && value !== undefined && value !== "";
    });

    for (const field of discoveredFields) {
      if (!(field in contentSource)) {
        throw new Error(`Route at index ${index} is missing discovered field: ${field}`);
      }

      const value = contentSource[field];

      if (value === null || value === undefined || value === "") {
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

async function handleContentBundle(request: Request, env: Env): Promise<Response> {
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

  let bundle: unknown;

  try {
    bundle = JSON.parse(rawJson);
  } catch {
    throw new Error("JSON bundle from Google Sheets is not valid JSON");
  }

  validateBundle(bundle, env);

  /**
   * API contract says this endpoint returns the raw JSON bundle.
   */
  return new Response(JSON.stringify(bundle), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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