export interface DevtoolsVersionInfo {
  browser: string;
  protocolVersion: string;
  userAgent: string;
  v8Version: string;
  webKitVersion: string;
  webSocketDebuggerUrl: string | null;
}

export interface DevtoolsTargetInfo {
  attached: boolean;
  browserContextId?: string;
  description: string;
  devtoolsFrontendUrl: string;
  faviconUrl?: string;
  id: string;
  parentId?: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string | null;
}

export interface DevtoolsTargetQuery {
  titleIncludes?: string;
  type?: string;
  urlIncludes?: string;
}

export interface WaitForDevtoolsOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface DevtoolsBodyResult {
  base64Encoded: boolean;
  body: Uint8Array;
}

export interface DevtoolsCapturedResource {
  bodyError: string | null;
  bodyState: "captured" | "failed" | "missing" | "pending" | "skipped";
  contentType: string | null;
  encodedDataLength: number | null;
  finalUrl: string;
  fromDiskCache: boolean;
  headers: Record<string, unknown>;
  requestId: string;
  resourceType: string;
  status: number | null;
  url: string;
  body: Uint8Array | null;
}

export interface CaptureDevtoolsNetworkOptions {
  captureUntilClose?: boolean;
  overallTimeoutMs?: number;
  quietPeriodMs?: number;
  reloadOnAttach?: boolean;
}

export interface DevtoolsPageDocument {
  contentType: string | null;
  finalUrl: string;
  html: string;
}

export interface DevtoolsNetworkCapture {
  finishedAt: string;
  pageDocument: DevtoolsPageDocument | null;
  quietPeriodMs: number;
  resources: DevtoolsCapturedResource[];
  startedAt: string;
}

export async function getDevtoolsVersion(baseUrl: string): Promise<DevtoolsVersionInfo> {
  const payload = await fetchDevtoolsJson<{
    Browser?: string;
    ProtocolVersion?: string;
    UserAgent?: string;
    V8Version?: string;
    WebKitVersion?: string;
    webSocketDebuggerUrl?: string;
  }>(baseUrl, "/json/version");

  return {
    browser: payload.Browser ?? "unknown",
    protocolVersion: payload.ProtocolVersion ?? "unknown",
    userAgent: payload.UserAgent ?? "unknown",
    v8Version: payload.V8Version ?? "unknown",
    webKitVersion: payload.WebKitVersion ?? "unknown",
    webSocketDebuggerUrl: payload.webSocketDebuggerUrl ?? null,
  };
}

export async function listDevtoolsTargets(baseUrl: string): Promise<DevtoolsTargetInfo[]> {
  const payload = await fetchDevtoolsJson<Array<{
    attached?: boolean;
    browserContextId?: string;
    description?: string;
    devtoolsFrontendUrl?: string;
    faviconUrl?: string;
    id?: string;
    parentId?: string;
    title?: string;
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }>>(baseUrl, "/json/list");

  return payload
    .filter((target) => target.id && target.type)
    .map((target) => ({
      attached: target.attached ?? false,
      browserContextId: target.browserContextId,
      description: target.description ?? "",
      devtoolsFrontendUrl: target.devtoolsFrontendUrl ?? "",
      faviconUrl: target.faviconUrl,
      id: target.id as string,
      parentId: target.parentId,
      title: target.title ?? "",
      type: target.type as string,
      url: target.url ?? "",
      webSocketDebuggerUrl: target.webSocketDebuggerUrl ?? null,
    }));
}

export async function waitForDevtoolsVersion(
  baseUrl: string,
  options: WaitForDevtoolsOptions = {},
): Promise<DevtoolsVersionInfo> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await getDevtoolsVersion(baseUrl);
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`timed out waiting for devtools endpoint: ${lastError.message}`);
  }

  throw new Error("timed out waiting for devtools endpoint");
}

export function findDevtoolsTargets(
  targets: DevtoolsTargetInfo[],
  query: DevtoolsTargetQuery,
): DevtoolsTargetInfo[] {
  return targets.filter((target) => {
    if (query.type && target.type !== query.type) {
      return false;
    }

    if (query.titleIncludes && !target.title.includes(query.titleIncludes)) {
      return false;
    }

    if (query.urlIncludes && !target.url.includes(query.urlIncludes)) {
      return false;
    }

    return true;
  });
}

export function pickPreferredDevtoolsTarget(targets: DevtoolsTargetInfo[]): DevtoolsTargetInfo | null {
  const pageTargets = targets.filter((target) => target.type === "page");

  if (pageTargets.length === 0) {
    return null;
  }

  const discordAppTarget = pageTargets.find((target) => target.url.includes("discord.com"));

  return discordAppTarget ?? pageTargets[0];
}

export async function captureDevtoolsNetwork(
  webSocketDebuggerUrl: string,
  options: CaptureDevtoolsNetworkOptions = {},
): Promise<DevtoolsNetworkCapture> {
  const connection = await createCdpConnection(webSocketDebuggerUrl);
  const captureUntilClose = options.captureUntilClose === true;
  const quietPeriodMs = options.quietPeriodMs ?? 3000;
  const overallTimeoutMs = options.overallTimeoutMs ?? 15000;
  const resources = new Map<string, MutableCapturedResource>();
  const pendingBodies = new Set<Promise<void>>();
  const startedAt = new Date().toISOString();
  let lastActivityAt = Date.now();
  let pageDocument: DevtoolsPageDocument | null = null;

  const unsubscribe = connection.onEvent((method, params) => {
    lastActivityAt = Date.now();

    if (method === "Network.requestWillBeSent") {
      const requestId = asString(params.requestId);

      if (!requestId) {
        return;
      }

      const existing = resources.get(requestId);
      const request = asRecord(params.request);
      const requestUrl = asString(request.url) ?? existing?.url ?? "";

      resources.set(requestId, {
        body: existing?.body ?? null,
        bodyError: existing?.bodyError ?? null,
        bodyState: existing?.bodyState ?? "missing",
        contentType: existing?.contentType ?? null,
        encodedDataLength: existing?.encodedDataLength ?? null,
        finalUrl: requestUrl,
        fromDiskCache: existing?.fromDiskCache ?? false,
        headers: existing?.headers ?? {},
        requestId,
        resourceType: asString(params.type) ?? existing?.resourceType ?? "other",
        status: existing?.status ?? null,
        url: requestUrl,
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = asString(params.requestId);

      if (!requestId) {
        return;
      }

      const existing = resources.get(requestId);
      const response = asRecord(params.response);
      const responseUrl = asString(response.url) ?? existing?.finalUrl ?? existing?.url ?? "";

      resources.set(requestId, {
        body: existing?.body ?? null,
        bodyError: existing?.bodyError ?? null,
        bodyState: existing?.bodyState ?? "missing",
        contentType: asString(response.mimeType) ?? null,
        encodedDataLength: existing?.encodedDataLength ?? null,
        finalUrl: responseUrl,
        fromDiskCache: asBoolean(response.fromDiskCache),
        headers: asHeaders(response.headers),
        requestId,
        resourceType: asString(params.type) ?? existing?.resourceType ?? "other",
        status: asNumber(response.status),
        url: existing?.url ?? responseUrl,
      });
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = asString(params.requestId);

      if (!requestId) {
        return;
      }

      const existing = resources.get(requestId);

      if (!existing) {
        return;
      }

      existing.encodedDataLength = asNumber(params.encodedDataLength);
      resources.set(requestId, existing);

      if (!shouldCaptureBody(existing)) {
        existing.bodyState = "skipped";
        resources.set(requestId, existing);
        return;
      }

      existing.bodyState = "pending";
      resources.set(requestId, existing);

      const pendingBody = connection
        .send<{ base64Encoded?: boolean; body?: string }>("Network.getResponseBody", { requestId })
        .then((result) => {
          const resource = resources.get(requestId);

          if (!resource || typeof result.body !== "string") {
            return;
          }

          const body = decodeBody(result.body, result.base64Encoded === true);
          resource.body = body;
          resource.bodyError = null;
          resource.bodyState = "captured";
          resources.set(requestId, resource);
        })
        .catch((error: unknown) => {
          const resource = resources.get(requestId);

          if (!resource) {
            return;
          }

          resource.bodyError = error instanceof Error ? error.message : String(error);
          resource.bodyState = "failed";
          resources.set(requestId, resource);
        })
        .finally(() => {
          pendingBodies.delete(pendingBody);
        });

      pendingBodies.add(pendingBody);
      return;
    }

    if (method === "Network.requestServedFromCache") {
      const requestId = asString(params.requestId);

      if (!requestId) {
        return;
      }

      const existing = resources.get(requestId);

      if (!existing) {
        return;
      }

      existing.fromDiskCache = true;
      resources.set(requestId, existing);
    }
  });

  try {
    await connection.send("Page.enable");
    await connection.send("Network.enable");
    await connection.send("Runtime.enable");
    await connection.send("Network.setCacheDisabled", { cacheDisabled: true });

    if (options.reloadOnAttach !== false) {
      await connection.send("Page.reload", { ignoreCache: true });
    }

    pageDocument = await capturePageDocument(connection).catch(() => null);

    if (captureUntilClose) {
      await connection.waitUntilClosed();
    } else {
      const startedAtMs = Date.now();

      while (Date.now() - startedAtMs < overallTimeoutMs) {
        if (Date.now() - lastActivityAt >= quietPeriodMs) {
          break;
        }

        await sleep(200);
      }
    }

    if (pendingBodies.size > 0) {
      await Promise.allSettled([...pendingBodies]);
    }
  } finally {
    unsubscribe();
    await connection.close();
  }

  return {
    finishedAt: new Date().toISOString(),
    pageDocument,
    quietPeriodMs,
    resources: [...resources.values()].sort((left, right) => left.finalUrl.localeCompare(right.finalUrl)),
    startedAt,
  };
}

function normalizeDevtoolsUrl(baseUrl: string, pathname: string): URL {
  let normalizedBase = baseUrl.trim();

  if (!/^https?:\/\//i.test(normalizedBase)) {
    normalizedBase = `http://${normalizedBase}`;
  }

  const url = new URL(normalizedBase);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchDevtoolsJson<T>(baseUrl: string, pathname: string): Promise<T> {
  const url = normalizeDevtoolsUrl(baseUrl, pathname);
  const response = await fetch(url, {
    headers: {
      "user-agent": "discorpus/0.1.0",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`devtools request failed: ${response.status} ${url.toString()}`);
  }

  return (await response.json()) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface MutableCapturedResource extends DevtoolsCapturedResource {}

interface CdpConnection {
  close(): Promise<void>;
  onEvent(handler: (method: string, params: Record<string, unknown>) => void): () => void;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  waitUntilClosed(): Promise<void>;
}

async function createCdpConnection(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;

  if (!WebSocketCtor) {
    throw new Error("global WebSocket is not available in this Node runtime");
  }

  const socket = new WebSocketCtor(webSocketDebuggerUrl);
  const pending = new Map<number, PendingCommand>();
  const eventHandlers = new Set<(method: string, params: Record<string, unknown>) => void>();
  let nextId = 1;
  let closed = false;
  let resolveClosed: (() => void) | null = null;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event: unknown) => reject(new Error(`cdp websocket failed to open: ${String(event)}`)));
  });

  socket.addEventListener("message", (event: unknown) => {
    const messageEvent = asRecord(event);
    const rawEventData = messageEvent.data;
    const rawData = typeof rawEventData === "string"
      ? rawEventData
      : Buffer.from((rawEventData ?? new ArrayBuffer(0)) as ArrayBufferLike).toString("utf8");
    const message = JSON.parse(rawData) as {
      error?: { message?: string };
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };

    if (typeof message.id === "number") {
      const pendingCommand = pending.get(message.id);

      if (!pendingCommand) {
        return;
      }

      pending.delete(message.id);

      if (message.error) {
        pendingCommand.reject(new Error(message.error.message ?? `cdp command failed: ${pendingCommand.method}`));
        return;
      }

      pendingCommand.resolve(message.result);
      return;
    }

    if (message.method) {
      const params = asRecord(message.params);

      for (const handler of eventHandlers) {
        handler(message.method, params);
      }
    }
  });

  socket.addEventListener("close", () => {
    closed = true;
    resolveClosed?.();
    resolveClosed = null;

    for (const pendingCommand of pending.values()) {
      pendingCommand.reject(new Error("cdp websocket closed"));
    }

    pending.clear();
  });

  return {
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      });
    },
    onEvent(handler: (method: string, params: Record<string, unknown>) => void): () => void {
      eventHandlers.add(handler);

      return () => {
        eventHandlers.delete(handler);
      };
    },
    send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          method,
          reject,
          resolve: (value) => resolve(value as T),
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    waitUntilClosed(): Promise<void> {
      return closedPromise;
    },
  };
}

interface PendingCommand {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

interface RuntimeEvaluateResult {
  result?: {
    subtype?: string;
    type?: string;
    value?: unknown;
  };
}

interface MinimalWebSocket {
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  close(): void;
  send(data: string): void;
}

function shouldCaptureBody(resource: MutableCapturedResource): boolean {
  if (resource.status === null || resource.status < 200 || resource.status >= 400) {
    return false;
  }

  if (resource.resourceType === "Preflight" || resource.resourceType === "WebSocket" || resource.resourceType === "EventSource" || resource.resourceType === "Manifest") {
    return false;
  }

  if (resource.finalUrl.startsWith("data:") || resource.finalUrl.startsWith("blob:")) {
    return false;
  }

  if (resource.resourceType === "Document" ||
    resource.resourceType === "Script" ||
    resource.resourceType === "Stylesheet" ||
    resource.resourceType === "XHR" ||
    resource.resourceType === "Fetch" ||
    resource.resourceType === "Image" ||
    resource.resourceType === "Font" ||
    resource.resourceType === "Media" ||
    resource.resourceType === "Other") {
    return true;
  }

  const contentType = resource.contentType?.toLowerCase() ?? "";

  return contentType.includes("javascript") ||
    contentType.includes("json") ||
    contentType.includes("css") ||
    contentType.includes("html") ||
    contentType.includes("text") ||
    contentType.includes("image/") ||
    contentType.includes("font/") ||
    contentType.includes("wasm") ||
    contentType.includes("octet-stream");
}

async function capturePageDocument(connection: CdpConnection): Promise<DevtoolsPageDocument | null> {
  const response = await connection.send<RuntimeEvaluateResult>("Runtime.evaluate", {
    awaitPromise: false,
    expression: `(() => {
      const doc = globalThis.document;
      const loc = globalThis.location;
      if (!doc || !loc) {
        return null;
      }
      return {
        contentType: typeof doc.contentType === "string" ? doc.contentType : null,
        finalUrl: String(loc.href),
        html: doc.documentElement ? doc.documentElement.outerHTML : "",
      };
    })()`,
    returnByValue: true,
  });

  const value = asRecord(response.result?.value);
  const finalUrl = asString(value.finalUrl);
  const html = asString(value.html);

  if (!finalUrl || html === null) {
    return null;
  }

  return {
    contentType: asString(value.contentType),
    finalUrl,
    html,
  };
}

function decodeBody(value: string, base64Encoded: boolean): Uint8Array {
  if (base64Encoded) {
    return Buffer.from(value, "base64");
  }

  return Buffer.from(value, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asHeaders(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
