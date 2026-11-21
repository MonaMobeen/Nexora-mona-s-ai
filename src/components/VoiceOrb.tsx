import { useEffect, useRef } from 'react';
import type { OrbState } from '../types/nexora';
import type { VoiceAudioEngine } from '../voice/audioEngine';

interface VoiceOrbProps {
  state: OrbState;
  audioEngine: VoiceAudioEngine;
  compact?: boolean;
  onPrimaryClick?: () => void;
}

const STATE_LABELS: Record<OrbState, string> = {
  idle: 'Ready for voice or text',
  listening: 'Listening to microphone',
  processing: 'Reasoning & executing tools',
  speaking: 'Speaking response',
  interrupted: 'Interrupted — listening',
  error: 'Voice connection error',
};

export function VoiceOrb({ state, audioEngine, compact = false, onPrimaryClick }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bins = new Uint8Array(64);
    let animId = 0;
    let phase = 0;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = compact ? 136 : 212;
      if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, size, size);

      const cx = size / 2;
      const cy = size / 2;
      const currentState = stateRef.current;

      let energy = 0;
      if (currentState === 'listening') {
        energy = audioEngine.getVisualizationData(bins, 'input');
      } else if (currentState === 'speaking') {
        energy = audioEngine.getVisualizationData(bins, 'output');
      } else {
        bins.fill(0);
      }

      phase += prefersReducedMotion ? 0 : currentState === 'processing' ? 0.045 : 0.018;

      const baseRadius = compact ? 36 : 56;
      const pulse =
        currentState === 'idle'
          ? Math.sin(phase) * 1.5
          : currentState === 'processing'
            ? Math.sin(phase * 2) * 3.5
            : currentState === 'interrupted'
              ? -4
              : energy * (compact ? 14 : 22);

      // Palette strictly aligned with dark obsidian + electric blue + subtle violet
      let primaryRgb = '59, 130, 246'; // electric blue
      let secondaryRgb = '139, 92, 246'; // violet
      if (currentState === 'error') {
        primaryRgb = '239, 68, 68';
        secondaryRgb = '249, 115, 22';
      } else if (currentState === 'interrupted') {
        primaryRgb = '245, 158, 11';
        secondaryRgb = '139, 92, 246';
      } else if (currentState === 'speaking') {
        primaryRgb = '96, 165, 250';
        secondaryRgb = '167, 139, 250';
      }

      // Outer atmospheric halo
      const haloRadius = baseRadius + 30 + pulse;
      const halo = ctx.createRadialGradient(cx, cy, baseRadius * 0.4, cx, cy, haloRadius);
      halo.addColorStop(0, `rgba(${primaryRgb}, ${currentState === 'idle' ? 0.16 : 0.32})`);
      halo.addColorStop(0.6, `rgba(${secondaryRgb}, ${currentState === 'idle' ? 0.06 : 0.14})`);
      halo.addColorStop(1, 'rgba(9, 11, 16, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      // Acoustic waveform ring driven by actual AnalyserNode bins
      const points = 48;
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const binIndex = i % 32;
        const binAmp = (bins[binIndex] ?? 0) / 255;
        const harmonic =
          currentState === 'processing'
            ? Math.sin(angle * 4 + phase * 3) * 4
            : currentState === 'listening' || currentState === 'speaking'
              ? binAmp * (compact ? 14 : 24)
              : Math.sin(angle * 3 + phase) * 1.2;

        const r = baseRadius + pulse * 0.45 + harmonic;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(${primaryRgb}, ${currentState === 'idle' ? 0.45 : 0.9})`;
      ctx.lineWidth = currentState === 'idle' ? 1.5 : 2.2;
      ctx.stroke();

      // Secondary precision orbital arc when processing
      if (currentState === 'processing') {
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius + 14, phase * 1.4, phase * 1.4 + Math.PI * 0.85);
        ctx.strokeStyle = `rgba(${secondaryRgb}, 0.85)`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Inner luminous core
      const coreGrad = ctx.createRadialGradient(
        cx - baseRadius * 0.22,
        cy - baseRadius * 0.22,
        4,
        cx,
        cy,
        baseRadius + pulse * 0.35,
      );
      coreGrad.addColorStop(0, `rgba(226, 232, 240, ${currentState === 'idle' ? 0.24 : 0.48})`);
      coreGrad.addColorStop(0.55, `rgba(${primaryRgb}, ${currentState === 'idle' ? 0.35 : 0.72})`);
      coreGrad.addColorStop(1, `rgba(${secondaryRgb}, ${currentState === 'idle' ? 0.2 : 0.45})`);

      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(12, baseRadius - 6 + pulse * 0.25), 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [audioEngine, compact]);

  const sizeClass = compact ? 'w-[136px] h-[136px]' : 'w-[212px] h-[212px]';

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <button
        type="button"
        onClick={onPrimaryClick}
        aria-label={STATE_LABELS[state]}
        className={`relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6] transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98] ${sizeClass}`}
      >
        <canvas ref={canvasRef} className={`${sizeClass} block`} />
      </button>
      <p
        className={`text-xs font-medium tracking-wide ${
          state === 'error'
            ? 'text-rose-400'
            : state === 'interrupted'
              ? 'text-amber-400'
              : state === 'speaking' || state === 'listening'
                ? 'text-blue-300'
                : 'text-slate-400'
        }`}
      >
        {STATE_LABELS[state]}
      </p>
    </div>
  );
}
