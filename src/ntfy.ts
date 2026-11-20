export interface NtfyConfig {
  server: string;
  topic: string;
}

export interface Notification {
  title: string;
  message: string;
  priority: 3 | 4 | 5;
  tags: string[];
}

export function validateNtfy(value: NtfyConfig): void {
  let url: URL;
  try { url = new URL(value.server); }
  catch { throw new Error('ntfy.server must be an HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('ntfy.server must be an HTTP or HTTPS URL without credentials, query, or fragment.');
  }
  if (typeof value.topic !== 'string' || (value.topic && !/^[a-zA-Z0-9_-]{1,64}$/.test(value.topic))) {
    throw new Error('ntfy.topic must use 1-64 letters, digits, underscores, or hyphens, or be empty to disable alerts.');
  }
}

/** JSON keeps Unicode camera names out of HTTP headers. */
export async function publishNtfy(
  config: NtfyConfig,
  notification: Notification,
  options: { token?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  validateNtfy(config);
  if (!config.topic) throw new Error('Configure ntfy with Start-Recorder.ps1 ntfy-setup first.');
  const timeout = AbortSignal.timeout(10_000);
  const response = await (options.fetch || fetch)(`${config.server.replace(/\/+$/, '')}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({ topic: config.topic, ...notification }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    redirect: 'error',
  });
  // Consume the response without exposing private server messages or tokens in logs.
  await response.body?.cancel();
  if (!response.ok) throw new Error(`ntfy rejected the notification (HTTP ${response.status}).`);
}
