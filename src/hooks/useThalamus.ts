import { useState, useEffect, useCallback, useMemo } from 'react';
import { ThalamusClient, type CompressionMetrics, type EngineStatus } from '../services/ThalamusClient';

export type { CompressionMetrics, EngineStatus };

export interface UseThalamusReturn {
  isEngineReady: boolean;
  engineStatus: EngineStatus | null;
  isLoading: boolean;
  error: string | null;
  compressPrompt: (prompt: string) => Promise<CompressionMetrics>;
  checkHealth: () => Promise<boolean>;
}

/**
 * Bridge to the local compression engine: a thin state wrapper around
 * ThalamusClient + a 5-second health poll.
 */
export const useThalamus = (): UseThalamusReturn => {
  const client = useMemo(() => new ThalamusClient(), []);
  const [isEngineReady, setIsEngineReady] = useState<boolean>(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Checks the status of the Rust engine
   */
  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const status = await client.checkEngineStatus();
      setEngineStatus(status);
      setIsEngineReady(status.is_ready);
      return status.is_ready;
    } catch {
      setIsEngineReady(false);
      return false;
    }
  }, [client]);

  useEffect(() => {
    const tick = () => { if (!document.hidden) checkHealth(); };
    tick();
    const interval = setInterval(tick, 20000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  /**
   * Compresses the prompt and produces real metrics
   */
  const compressPrompt = useCallback(
    async (prompt: string): Promise<CompressionMetrics> => {
      if (!prompt.trim()) {
        return {
          original_prompt: '',
          processed_prompt: '',
          is_compressed: false,
          original_tokens: 0,
          compressed_tokens: 0,
          saved_tokens: 0,
          savings_percentage: 0,
          execution_time_ms: 0,
        };
      }

      setIsLoading(true);
      setError(null);

      try {
        const vetoOverride = localStorage.getItem('tlm_dev_veto_override') === 'true';
        const metrics = await client.compressPrompt(prompt, vetoOverride);
        setIsLoading(false);
        return metrics;
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'An error occurred during prompt compression.';
        setError(errorMessage);
        setIsLoading(false);
        throw err;
      }
    },
    [client]
  );

  return {
    isEngineReady,
    engineStatus,
    isLoading,
    error,
    compressPrompt,
    checkHealth,
  };
};
