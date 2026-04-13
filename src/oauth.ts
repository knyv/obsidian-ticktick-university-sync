import { requestUrl } from 'obsidian';
import { TICKTICK_OAUTH_AUTHORIZE, TICKTICK_OAUTH_TOKEN } from './constants';

export function extractAuthCode(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('Empty auth code input.');

  // full redirect URL
  if (raw.includes('://') || raw.includes('?')) {
    try {
      const url = new URL(raw);
      const code = url.searchParams.get('code');
      if (code) return code;
    } catch {
      // continue
    }
  }

  // fallback: treat as code
  return raw;
}

export function buildOAuthAuthorizeUrl(clientId: string, scopes: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    state: `obsidian-${Date.now()}`,
    redirect_uri: redirectUri,
    response_type: 'code',
  });
  return `${TICKTICK_OAUTH_AUTHORIZE}?${q.toString()}`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${btoa(raw)}`;
}

export async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  codeInput: string;
  scopes: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken: string; tokenExpiryMs: number }> {
  const code = extractAuthCode(args.codeInput);

  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    scope: args.scopes,
    redirect_uri: args.redirectUri,
  });

  const res = await requestUrl({
    url: TICKTICK_OAUTH_TOKEN,
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(args.clientId, args.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    throw: false,
  });

  if (res.status < 200 || res.status >= 300) {
    console.error('[TickTick University Sync] exchange code failed:', res.status, res.text);
    throw new Error(`Token exchange failed (${res.status}). Check client settings/redirect URI.`);
  }

  const data = res.json as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data?.access_token) throw new Error('No access_token in TickTick response.');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    tokenExpiryMs: Date.now() + ((data.expires_in ?? 3600) * 1000 * 0.9),
  };
}

export async function refreshToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string;
}): Promise<{ accessToken: string; refreshToken: string; tokenExpiryMs: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    scope: args.scopes,
  });

  const res = await requestUrl({
    url: TICKTICK_OAUTH_TOKEN,
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(args.clientId, args.clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    throw: false,
  });

  if (res.status < 200 || res.status >= 300) {
    console.error('[TickTick University Sync] refresh failed:', res.status, res.text);
    throw new Error(`Token refresh failed (${res.status}).`);
  }

  const data = res.json as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data?.access_token) throw new Error('No access_token returned on refresh.');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? args.refreshToken,
    tokenExpiryMs: Date.now() + ((data.expires_in ?? 3600) * 1000 * 0.9),
  };
}
