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
