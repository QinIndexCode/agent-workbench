import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

type PresenceState = 'open' | 'closed';

export function useAnimatedPresence(open: boolean, durationMs = 200): {
  mounted: boolean;
  state: PresenceState;
  reducedMotion: boolean;
} {
  const reducedMotion = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? 'open' : 'closed');

  useEffect(() => {
    const duration = reducedMotion ? 0 : durationMs;

    if (open) {
      setMounted(true);
      setState('closed');
      const raf = window.requestAnimationFrame(() => setState('open'));
      return () => window.cancelAnimationFrame(raf);
    }

    if (!mounted) {
      setState('closed');
      return undefined;
    }

    setState('closed');
    const timeout = window.setTimeout(() => {
      setMounted(false);
    }, duration);
    return () => window.clearTimeout(timeout);
  }, [durationMs, mounted, open, reducedMotion]);

  return { mounted, state, reducedMotion };
}
