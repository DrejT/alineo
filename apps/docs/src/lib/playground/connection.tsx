"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PlaygroundClient, HOSTED_ENDPOINT, type CapacityInfo } from "./client";

export type ConnectionStatus = "idle" | "checking" | "online" | "offline";

interface ConnectionValue {
  endpoint: string;
  setEndpoint: (endpoint: string) => void;
  resetEndpoint: () => void;
  client: PlaygroundClient;
  status: ConnectionStatus;
  capacity: CapacityInfo | null;
  error: string | null;
  /** Re-run the health + capacity check now. */
  refresh: () => Promise<void>;
}

const STORAGE_KEY = "alineo-playground-endpoint";

const ConnectionContext = createContext<ConnectionValue | null>(null);

function readStoredEndpoint(): string {
  if (typeof window === "undefined") return HOSTED_ENDPOINT;
  try {
    return window.localStorage.getItem(STORAGE_KEY) || HOSTED_ENDPOINT;
  } catch {
    return HOSTED_ENDPOINT;
  }
}

export function PlaygroundProvider({ children }: { children: React.ReactNode }) {
  const [endpoint, setEndpointState] = useState<string>(HOSTED_ENDPOINT);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [capacity, setCapacity] = useState<CapacityInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from localStorage after mount — the static export ships the default, so
  // reading storage during render would desync SSR and client markup.
  useEffect(() => {
    setEndpointState(readStoredEndpoint());
  }, []);

  const client = useMemo(() => new PlaygroundClient(endpoint), [endpoint]);

  const setEndpoint = useCallback((next: string) => {
    const trimmed = next.trim().replace(/\/+$/, "");
    setEndpointState(trimmed || HOSTED_ENDPOINT);
    try {
      window.localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* private mode — endpoint just won't persist */
    }
  }, []);

  const resetEndpoint = useCallback(() => {
    setEndpointState(HOSTED_ENDPOINT);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const runId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++runId.current;
    setStatus("checking");
    setError(null);
    try {
      const ok = await client.health();
      if (id !== runId.current) return;
      if (!ok) {
        setStatus("offline");
        setCapacity(null);
        setError(`No response from ${client.base}`);
        return;
      }
      const cap = await client.capacity();
      if (id !== runId.current) return;
      setCapacity(cap);
      setStatus("online");
    } catch (err) {
      if (id !== runId.current) return;
      setStatus("offline");
      setCapacity(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: ConnectionValue = {
    endpoint,
    setEndpoint,
    resetEndpoint,
    client,
    status,
    capacity,
    error,
    refresh,
  };

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error("useConnection must be used within <PlaygroundProvider>");
  }
  return ctx;
}
