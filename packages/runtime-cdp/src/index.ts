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
  onProgress?: (progress: DevtoolsCaptureProgress) => void;
  overallTimeoutMs?: number;
  quietPeriodMs?: number;
  reloadOnAttach?: boolean;
}

export interface DevtoolsCaptureProgress {
  bodyCapturedCount: number;
  bodyFailedCount: number;
  bodyPendingCount: number;
  bodySkippedCount: number;
  resourceCount: number;
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
  selectedTarget: DevtoolsTargetInfo | null;
  targets: DevtoolsTargetInfo[];
  startedAt: string;
}

export interface CaptureBrowserDevtoolsNetworkOptions {
  childIsRunning?: () => boolean;
  onProgress?: (progress: DevtoolsCaptureProgress & { activeTargets: number }) => void;
  targetFilter?: (target: DevtoolsTargetInfo) => boolean;
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
  let lastProgressAt = 0;
  let pageDocument: DevtoolsPageDocument | null = null;

  const emitProgress = (force = false) => {
    if (!options.onProgress) {
      return;
    }

    const now = Date.now();

    if (!force && now - lastProgressAt < 2000) {
      return;
    }

    lastProgressAt = now;
    let bodyCapturedCount = 0;
    let bodyFailedCount = 0;
    let bodyPendingCount = 0;
    let bodySkippedCount = 0;

    for (const resource of resources.values()) {
      if (resource.bodyState === "captured") {
        bodyCapturedCount += 1;
      } else if (resource.bodyState === "failed") {
        bodyFailedCount += 1;
      } else if (resource.bodyState === "pending") {
        bodyPendingCount += 1;
      } else if (resource.bodyState === "skipped") {
        bodySkippedCount += 1;
      }
    }

    options.onProgress({
      bodyCapturedCount,
      bodyFailedCount,
      bodyPendingCount,
      bodySkippedCount,
      resourceCount: resources.size,
    });
  };

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
      emitProgress();
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
      emitProgress();
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
        emitProgress();
        return;
      }

      existing.bodyState = "pending";
      resources.set(requestId, existing);
      emitProgress();

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
          emitProgress();
        })
        .catch((error: unknown) => {
          const resource = resources.get(requestId);

          if (!resource) {
            return;
          }

          resource.bodyError = error instanceof Error ? error.message : String(error);
          resource.bodyState = "failed";
          resources.set(requestId, resource);
          emitProgress();
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
      emitProgress();
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
    emitProgress(true);
  } finally {
    unsubscribe();
    await connection.close();
  }

  return {
    finishedAt: new Date().toISOString(),
    pageDocument,
    quietPeriodMs,
    resources: [...resources.values()].sort((left, right) => left.finalUrl.localeCompare(right.finalUrl)),
    selectedTarget: null,
    startedAt,
    targets: [],
  };
}

export async function captureBrowserDevtoolsNetwork(
  browserWebSocketDebuggerUrl: string,
  options: CaptureBrowserDevtoolsNetworkOptions = {},
): Promise<DevtoolsNetworkCapture> {
  const connection = await createCdpConnection(browserWebSocketDebuggerUrl);
  const startedAt = new Date().toISOString();
  const sessions = new Map<string, BrowserCaptureSession>();
  const targets = new Map<string, DevtoolsTargetInfo>();
  let lastProgressAt = 0;
  let selectedTarget: DevtoolsTargetInfo | null = null;

  const isRelevantTarget = (target: DevtoolsTargetInfo): boolean => {
    if (target.type !== "page") {
      return false;
    }

    return options.targetFilter ? options.targetFilter(target) : true;
  };

  const emitProgress = (force = false) => {
    if (!options.onProgress) {
      return;
    }

    const now = Date.now();

    if (!force && now - lastProgressAt < 2000) {
      return;
    }

    lastProgressAt = now;
    let resourceCount = 0;
    let bodyCapturedCount = 0;
    let bodyFailedCount = 0;
    let bodyPendingCount = 0;
    let bodySkippedCount = 0;

    for (const session of sessions.values()) {
      if (!session.relevant) {
        continue;
      }

      resourceCount += session.resources.size;

      for (const resource of session.resources.values()) {
        if (resource.bodyState === "captured") {
          bodyCapturedCount += 1;
        } else if (resource.bodyState === "failed") {
          bodyFailedCount += 1;
        } else if (resource.bodyState === "pending") {
          bodyPendingCount += 1;
        } else if (resource.bodyState === "skipped") {
          bodySkippedCount += 1;
        }
      }
    }

    options.onProgress({
      activeTargets: [...sessions.values()].filter((session) => session.relevant && !session.closed).length,
      bodyCapturedCount,
      bodyFailedCount,
      bodyPendingCount,
      bodySkippedCount,
      resourceCount,
    });
  };

  const unsubscribe = connection.onEvent((method, params, sessionId) => {
    if (method === "Target.attachedToTarget") {
      const targetInfo = toTargetInfo(asRecord(params.targetInfo));
      const attachedSessionId = asString(params.sessionId);

      if (!targetInfo || !attachedSessionId) {
        return;
      }

      targets.set(targetInfo.id, targetInfo);
      const relevant = isRelevantTarget(targetInfo);
      sessions.set(attachedSessionId, {
        closed: false,
        pageDocument: null,
        pendingBodies: new Set<Promise<void>>(),
        relevant,
        resources: new Map<string, MutableCapturedResource>(),
        sessionId: attachedSessionId,
        target: targetInfo,
      });

      if (relevant && (!selectedTarget || isBetterSelectedTarget(targetInfo, selectedTarget))) {
        selectedTarget = targetInfo;
      }

      void initializeAttachedTarget(connection, attachedSessionId, relevant, sessions, emitProgress);
      return;
    }

    if (method === "Target.targetInfoChanged") {
      const targetInfo = toTargetInfo(asRecord(params.targetInfo));

      if (!targetInfo) {
        return;
      }

      targets.set(targetInfo.id, targetInfo);

      for (const session of sessions.values()) {
        if (session.target.id !== targetInfo.id) {
          continue;
        }

        session.target = targetInfo;
        session.relevant = isRelevantTarget(targetInfo);

        if (session.relevant && (!selectedTarget || isBetterSelectedTarget(targetInfo, selectedTarget))) {
          selectedTarget = targetInfo;
        }
      }

      emitProgress();
      return;
    }

    if (method === "Target.detachedFromTarget") {
      const detachedSessionId = asString(params.sessionId);

      if (!detachedSessionId) {
        return;
      }

      const session = sessions.get(detachedSessionId);

      if (session) {
        session.closed = true;
      }

      emitProgress();
      return;
    }

    if (!sessionId) {
      return;
    }

    const session = sessions.get(sessionId);

    if (!session || !session.relevant) {
      return;
    }

    handleSessionNetworkEvent(connection, session, method, params, emitProgress);
  });

  try {
    await connection.send("Target.setDiscoverTargets", { discover: true });
    await connection.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });

    const result = await connection.send<{ targetInfos?: unknown[] }>("Target.getTargets");
    const targetInfos = Array.isArray(result.targetInfos) ? result.targetInfos : [];

    for (const rawTargetInfo of targetInfos) {
      const targetInfo = toTargetInfo(asRecord(rawTargetInfo));

      if (!targetInfo || !isRelevantTarget(targetInfo)) {
        continue;
      }

      targets.set(targetInfo.id, targetInfo);

      try {
        await connection.send("Target.attachToTarget", {
          flatten: true,
          targetId: targetInfo.id,
        });
      } catch {
        continue;
      }
    }

    while (true) {
      const running = options.childIsRunning ? options.childIsRunning() : true;
      const activeRelevantSessions = [...sessions.values()].some((session) => session.relevant && !session.closed);

      if (!running && !activeRelevantSessions) {
        break;
      }

      emitProgress();
      await sleep(250);
    }

    const pendingBodies = [...sessions.values()].flatMap((session) => [...session.pendingBodies]);

    if (pendingBodies.length > 0) {
      await Promise.allSettled(pendingBodies);
    }

    emitProgress(true);
  } finally {
    unsubscribe();
    await connection.close();
  }

  const mergedResources = [...sessions.values()]
    .filter((session) => session.relevant)
    .flatMap((session) =>
      [...session.resources.values()].map((resource) => ({
        ...resource,
        requestId: `${session.target.id}:${resource.requestId}`,
      })),
    )
    .sort((left, right) => left.finalUrl.localeCompare(right.finalUrl));
  const pageDocument = [...sessions.values()]
    .filter((session): session is BrowserCaptureSession & { pageDocument: DevtoolsPageDocument } => session.relevant && session.pageDocument !== null)
    .sort((left, right) => scorePageDocument(left.pageDocument, selectedTarget) > scorePageDocument(right.pageDocument, selectedTarget) ? -1 : 1)[0]?.pageDocument ?? null;

  return {
    finishedAt: new Date().toISOString(),
    pageDocument,
    quietPeriodMs: 0,
    resources: mergedResources,
    selectedTarget,
    startedAt,
    targets: [...targets.values()],
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

interface BrowserCaptureSession {
  closed: boolean;
  pageDocument: DevtoolsPageDocument | null;
  pendingBodies: Set<Promise<void>>;
  relevant: boolean;
  resources: Map<string, MutableCapturedResource>;
  sessionId: string;
  target: DevtoolsTargetInfo;
}

interface CdpConnection {
  close(): Promise<void>;
  onEvent(handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void;
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  waitUntilClosed(): Promise<void>;
}

async function createCdpConnection(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;

  if (!WebSocketCtor) {
    throw new Error("global WebSocket is not available in this Node runtime");
  }

  const socket = new WebSocketCtor(webSocketDebuggerUrl);
  const pending = new Map<number, PendingCommand>();
  const eventHandlers = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
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

      const sessionId = asString((message as { sessionId?: unknown }).sessionId) ?? undefined;

      for (const handler of eventHandlers) {
        handler(message.method, params, sessionId);
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
    onEvent(handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
      eventHandlers.add(handler);

      return () => {
        eventHandlers.delete(handler);
      };
    },
    send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          method,
          reject,
          resolve: (value) => resolve(value as T),
        });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
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

async function initializeAttachedTarget(
  connection: CdpConnection,
  sessionId: string,
  relevant: boolean,
  sessions: Map<string, BrowserCaptureSession>,
  emitProgress: (force?: boolean) => void,
): Promise<void> {
  if (!relevant) {
    return;
  }

  await connection.send("Page.enable", {}, sessionId);
  await connection.send("Network.enable", {}, sessionId);
  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);

  const session = sessions.get(sessionId);

  if (!session) {
    return;
  }

  session.pageDocument = await capturePageDocumentForSession(connection, sessionId).catch(() => null);
  emitProgress();
}

function handleSessionNetworkEvent(
  connection: CdpConnection,
  session: BrowserCaptureSession,
  method: string,
  params: Record<string, unknown>,
  emitProgress: (force?: boolean) => void,
): void {
  if (method === "Network.requestWillBeSent") {
    const requestId = asString(params.requestId);

    if (!requestId) {
      return;
    }

    const existing = session.resources.get(requestId);
    const request = asRecord(params.request);
    const requestUrl = asString(request.url) ?? existing?.url ?? "";

    session.resources.set(requestId, {
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
    emitProgress();
    return;
  }

  if (method === "Network.responseReceived") {
    const requestId = asString(params.requestId);

    if (!requestId) {
      return;
    }

    const existing = session.resources.get(requestId);
    const response = asRecord(params.response);
    const responseUrl = asString(response.url) ?? existing?.finalUrl ?? existing?.url ?? "";

    session.resources.set(requestId, {
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
    emitProgress();
    return;
  }

  if (method === "Network.loadingFinished") {
    const requestId = asString(params.requestId);

    if (!requestId) {
      return;
    }

    const existing = session.resources.get(requestId);

    if (!existing) {
      return;
    }

    existing.encodedDataLength = asNumber(params.encodedDataLength);
    session.resources.set(requestId, existing);

    if (!shouldCaptureBody(existing)) {
      existing.bodyState = "skipped";
      session.resources.set(requestId, existing);
      emitProgress();
      return;
    }

    existing.bodyState = "pending";
    session.resources.set(requestId, existing);
    emitProgress();

    const pendingBody = connection
      .send<{ base64Encoded?: boolean; body?: string }>("Network.getResponseBody", { requestId }, session.sessionId)
      .then((result) => {
        const resource = session.resources.get(requestId);

        if (!resource || typeof result.body !== "string") {
          return;
        }

        resource.body = decodeBody(result.body, result.base64Encoded === true);
        resource.bodyError = null;
        resource.bodyState = "captured";
        session.resources.set(requestId, resource);
        emitProgress();
      })
      .catch((error: unknown) => {
        const resource = session.resources.get(requestId);

        if (!resource) {
          return;
        }

        resource.bodyError = error instanceof Error ? error.message : String(error);
        resource.bodyState = "failed";
        session.resources.set(requestId, resource);
        emitProgress();
      })
      .finally(() => {
        session.pendingBodies.delete(pendingBody);
      });

    session.pendingBodies.add(pendingBody);
    return;
  }

  if (method === "Network.requestServedFromCache") {
    const requestId = asString(params.requestId);

    if (!requestId) {
      return;
    }

    const existing = session.resources.get(requestId);

    if (!existing) {
      return;
    }

    existing.fromDiskCache = true;
    session.resources.set(requestId, existing);
    emitProgress();
  }
}

async function capturePageDocumentForSession(connection: CdpConnection, sessionId: string): Promise<DevtoolsPageDocument | null> {
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
  }, sessionId);

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

function toTargetInfo(target: Record<string, unknown>): DevtoolsTargetInfo | null {
  const id = asString(target.targetId) ?? asString(target.id);
  const type = asString(target.type);

  if (!id || !type) {
    return null;
  }

  return {
    attached: asBoolean(target.attached),
    browserContextId: asString(target.browserContextId) ?? undefined,
    description: asString(target.description) ?? "",
    devtoolsFrontendUrl: asString(target.devtoolsFrontendUrl) ?? "",
    faviconUrl: asString(target.faviconUrl) ?? undefined,
    id,
    parentId: asString(target.parentId) ?? undefined,
    title: asString(target.title) ?? "",
    type,
    url: asString(target.url) ?? "",
    webSocketDebuggerUrl: asString(target.webSocketDebuggerUrl),
  };
}

function isBetterSelectedTarget(candidate: DevtoolsTargetInfo, current: DevtoolsTargetInfo): boolean {
  if (isRemoteDiscordUrl(candidate.url) && !isRemoteDiscordUrl(current.url)) {
    return true;
  }

  if (isRemoteDiscordUrl(candidate.url) === isRemoteDiscordUrl(current.url)) {
    return candidate.url.localeCompare(current.url) < 0;
  }

  return false;
}

function scorePageDocument(
  pageDocument: DevtoolsPageDocument,
  selectedTarget: DevtoolsTargetInfo | null,
): number {
  let score = 0;

  if (isRemoteDiscordUrl(pageDocument.finalUrl)) {
    score += 100;
  }

  if (selectedTarget && isSameOrigin(pageDocument.finalUrl, selectedTarget.url)) {
    score += 25;
  }

  if (pageDocument.contentType?.toLowerCase().includes("html")) {
    score += 10;
  }

  if (!pageDocument.finalUrl.startsWith("file:")) {
    score += 5;
  }

  return score;
}

function isRemoteDiscordUrl(url: string): boolean {
  return url.startsWith("https://discord.com") ||
    url.startsWith("https://ptb.discord.com") ||
    url.startsWith("https://canary.discord.com");
}

function isSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
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
