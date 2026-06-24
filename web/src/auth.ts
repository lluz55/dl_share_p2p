// Relay login session (SPEC §4.3).
//
// The Go data relay (file bytes through the server) requires a prior login with
// a shared password. This module exchanges that password for a session token via
// POST /login and caches it (in memory + sessionStorage so it survives reloads).
// Direct P2P and the serverless path never touch this module.

import { LOGIN_URL } from "./config.js";

const STORAGE_KEY = "p2pshare.relayAuth";
// Safety margin so we don't present a token that is about to expire mid-request.
const EXPIRY_MARGIN_MS = 5000;

interface StoredAuth {
  token: string;
  expiresAt: number; // unix seconds
}

let current: StoredAuth | null = loadFromStorage();

function loadFromStorage(): StoredAuth | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    if (current) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // sessionStorage unavailable (private mode / disabled) — keep in-memory only.
  }
}

/** Whether we currently hold a non-expired relay session token. */
export function hasValidToken(): boolean {
  if (!current) return false;
  return current.expiresAt * 1000 - Date.now() > EXPIRY_MARGIN_MS;
}

/** The current valid token, or null if none/expired. */
export function getToken(): string | null {
  return hasValidToken() ? current!.token : null;
}

/** Forget the current session (e.g. after the server rejects it). */
export function clear(): void {
  current = null;
  persist();
}

/**
 * Exchange the shared password for a relay session token. Throws on bad
 * credentials (401) or any other failure.
 */
export async function login(password: string): Promise<void> {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (res.status === 401) {
    throw new Error("Incorrect password");
  }
  if (!res.ok) {
    throw new Error(`Login failed (${res.status})`);
  }

  const data = (await res.json()) as { token?: string; expiresAt?: number };
  if (!data.token || typeof data.expiresAt !== "number") {
    throw new Error("Login failed: invalid server response");
  }

  current = { token: data.token, expiresAt: data.expiresAt };
  persist();
}
