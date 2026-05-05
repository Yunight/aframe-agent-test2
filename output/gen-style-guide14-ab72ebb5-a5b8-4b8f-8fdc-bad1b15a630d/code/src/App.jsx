import { useState, useEffect, useCallback, useRef } from 'react';

/*
 * ===== ASSET DESCRIPTIONS =====
 *
 * LOGOS:
 * - house-of-the-dragon-logo-01.png (2200x2200): Main circular House of the Dragon
 *   emblem featuring the iconic three-headed Targaryen dragon sigil rendered in
 *   gold/bronze tones with the show title in decorative blackletter beneath.
 *   Used as the prominent central hero logo of the ad.
 *
 * - house-of-the-dragon-logo-02.png (2200x2200): Alternate variant of the HOTD
 *   emblem, slightly different tone or contrast treatment compared to logo-01.
 *   Used as a very subtle large background watermark texture to add depth.
 *
 * - hbo_houseofdragon_logo_v034__00000__1.png (2560x1440): Alternate HBO + HOTD
 *   logo lockup variant, compact horizontal layout with HBO wordmark.
 *   Used as the bottom credit mark in the revealed (phase 1) state.
 *
 * - 02_hbo_houseofdragon_logo_v040__00000_.png (3840x2160): High-resolution
 *   latest iteration of the HBO + HOTD combined branding mark.
 *   Used as the footer branding mark in the teaser (phase 0) state.
 *
 * PRODUCT IMAGES:
 * - House-of-the-Dragon-Season-3-Update-HBO-Happy-With-Show.jpg (1600x900):
 *   Season 3 promotional still showing dramatic character confrontation with
 *   moody cinematic lighting and rich color grading. Primary hero background.
 *
 * - kWcmUaH6yh7SxX7oy8undN.jpg (1920x1080): Dramatic scene still featuring
 *   an intense character moment with dark atmospheric grading. Hero BG rotation.
 *
 * - ptvYmXSf2wtEPHL8sS4rwi.jpg (1920x1080): Epic cinematic scene still with
 *   high production value, dragons or battlefield panorama. Hero BG rotation.
 *
 * - maxresdefault.jpg (1280x720): Wide promotional still with vivid color
 *   grading and dramatic composition of core cast. Hero BG rotation.
 *
 * - 71mOWQcuxgL.jpg (715x1068): Portrait Season 3 key art/poster showing
 *   main characters amid dragon imagery with show title branding.
 *   Used as poster thumbnail in the revealed CTA area.
 */

const HEROES = [
  './House-of-the-Dragon-Season-3-Update-HBO-Happy-With-Show.jpg',
  './kWcmUaH6yh7SxX7oy8undN.jpg',
  './ptvYmXSf2wtEPHL8sS4rwi.jpg',
  './maxresdefault.jpg',
];

const EMBER_COLORS = ['#C5A55A', '#7C1009', '#480800', '#927556'];
const CIRC = 2 * Math.PI * 23;

export default function App() {
  const containerRef = useRef(null);
  const holdRef = useRef(null);
  const autoRef = useRef(null);
  const uidRef = useRef(0);

  const [phase, setPhase] = useState(0);
  const [progress, setProgress] = useState(0);
  const [heroIdx, setHeroIdx] = useState(0);
  const [embers, setEmbers] = useState([]);
  const [sparks, setSparks] = useState([]);

  /* ── Ember particle system ── */
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      setEmbers(prev => {
        let arr = prev
          .map(e => ({
            ...e,
            y: e.y - e.vy,
            x: e.x + Math.sin(now * 0.0008 + e.seed) * 0.32,
            opacity: e.opacity - 0.007,
          }))
          .filter(e => e.opacity > 0);
        while (arr.length < 24) {
          uidRef.current++;
          arr.push({
            id: uidRef.current,
            x: Math.random() * 320,
            y: 485 + Math.random() * 20,
            size: Math.random() * 2.5 + 0.8,
            vy: Math.random() * 0.8 + 0.3,
            opacity: Math.random() * 0.5 + 0.2,
            seed: Math.random() * 999,
            color: EMBER_COLORS[Math.floor(Math.random() * 4)],
          });
        }
        return arr;
      });
    }, 50);
    return () => clearInterval(iv);
  }, []);

  /* ── Hero image rotation after reveal ── */
  useEffect(() => {
    if (phase !== 1) return;
    const iv = setInterval(() => setHeroIdx(i => (i + 1) % HEROES.length), 3500);
    return () => clearInterval(iv);
  }, [phase]);

  /* ── Auto-reveal fallback (7 s) ── */
  useEffect(() => {
    autoRef.current = setTimeout(() => {
      setPhase(1);
      setProgress(100);
    }, 7000);
    return () => clearTimeout(autoRef.current);
  }, []);

  /* ── Hold-to-reveal interaction ── */
  const startHold = useCallback(() => {
    if (phase === 1) return;
    holdRef.current = setInterval(() => {
      setProgress(p => {
        if (p + 2 >= 100) {
          clearInterval(holdRef.current);
          clearTimeout(autoRef.current);
          setPhase(1);
          return 100;
        }
        return p + 2;
      });
    }, 25);
  }, [phase]);

  const endHold = useCallback(() => {
    if (holdRef.current) clearInterval(holdRef.current);
  }, []);

  /* ── Tap fire-spark effect ── */
  const addSpark = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    const y = (e.touches?.[0]?.clientY ?? e.clientY) - rect.top;
    const id = Date.now() + Math.random();
    setSparks(prev => [...prev.slice(-4), { id, x, y }]);
    setTimeout(() => setSparks(prev => prev.filter(s => s.id !== id)), 700);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-[480px] w-[320px] shrink-0 overflow-hidden select-none cursor-pointer shadow-[0_24px_80px_-20px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
      style={{ background: '#0C0C14' }}
      onMouseDown={e => { startHold(); addSpark(e); }}
      onMouseUp={endHold}
      onMouseLeave={endHold}
      onTouchStart={e => { startHold(); addSpark(e); }}
      onTouchEnd={endHold}
    >
      {/* ═══ BACKGROUND DRAGON WATERMARK (logo-02) ═══ */}
      <img
        src="./house-of-the-dragon-logo-02.png"
        alt=""
        className="pointer-events-none absolute bottom-0 left-1/2 w-64 max-w-[90%] -translate-x-1/2 translate-y-1/4 object-contain"
        style={{
          opacity: phase === 0 ? 0.028 : 0.01,
          filter: 'brightness(0.35)',
          transition: 'opacity 2s',
        }}
      />

      {/* ═══ HERO BACKGROUND IMAGES (crossfade rotation) ═══ */}
      {HEROES.map((src, i) => (
        <div
          key={src}
          className="absolute inset-0 bg-cover bg-no-repeat"
          style={{
            backgroundImage: `url('${src}')`,
            /* Ancrer le cadrage vers le haut : les visages restent plus bas, sous le logo */
            backgroundPosition: phase === 1 ? '50% 18%' : '50% 50%',
            opacity: phase === 1 ? (heroIdx === i ? 0.42 : 0) : 0.06,
            transform: phase === 1 ? 'scale(1.05)' : 'scale(1)',
            transition: 'opacity 2s ease, transform 10s ease-out',
          }}
        />
      ))}

      {/* ═══ GRADIENT OVERLAY ═══ */}
      <div
        className="absolute inset-0 transition-all duration-[1500ms]"
        style={{
          background: phase === 1
            ? 'linear-gradient(180deg, rgba(6,5,8,0.92) 0%, rgba(12,12,20,0.5) 22%, rgba(72,8,0,0.14) 42%, rgba(124,16,9,0.08) 58%, rgba(12,12,20,0.92) 100%)'
            : 'linear-gradient(180deg, rgba(12,12,20,0.97) 0%, rgba(12,12,20,0.93) 50%, rgba(12,12,20,0.97) 100%)',
        }}
      />

      {/* Zone lisible derrière le logo (évite collision visuelle avec les visages) */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-[8] h-[200px] transition-opacity duration-[1500ms]"
        style={{
          opacity: phase === 1 ? 1 : 0.35,
          background:
            'linear-gradient(180deg, rgba(4,3,6,0.94) 0%, rgba(8,7,12,0.55) 45%, transparent 100%)',
        }}
      />

      {/* ═══ BOTTOM FIRE GLOW ═══ */}
      <div
        className="absolute bottom-0 inset-x-0 h-32 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at 50% 100%, rgba(124,16,9,0.3) 0%, transparent 60%)',
          opacity: phase === 1 ? 1 : Math.max(0, progress / 150),
          transition: 'opacity 800ms',
        }}
      />

      {/* ═══ EMBER PARTICLES ═══ */}
      {embers.map(e => (
        <div
          key={e.id}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: e.x,
            top: e.y,
            width: e.size,
            height: e.size,
            backgroundColor: e.color,
            opacity: e.opacity,
            boxShadow: `0 0 ${e.size * 2.5}px ${e.color}`,
          }}
        />
      ))}

      {/* ═══ TAP FIRE SPARKS ═══ */}
      {sparks.map(s => (
        <div
          key={s.id}
          className="absolute pointer-events-none animate-spark"
          style={{
            left: s.x - 25,
            top: s.y - 25,
            width: 50,
            height: 50,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(197,165,90,0.6) 0%, rgba(124,16,9,0.2) 40%, transparent 70%)',
          }}
        />
      ))}

      {/* ═══════════════ CONTENT LAYER ═══════════════ */}
      <div className="relative z-10 flex flex-col items-center h-full">
        {/* ── Top gold accent line ── */}
        <div
          className="w-full h-px"
          style={{
            background: 'linear-gradient(90deg, transparent 5%, #C5A55A 50%, transparent 95%)',
            opacity: phase === 1 ? 0.4 : 0.1,
            transition: 'opacity 1s',
          }}
        />

        {/* ── MAIN LOGO (logo-01) — ancré en haut pour laisser les visages dans le tiers moyen du fond ── */}
        <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-start px-3 pt-5">
          <div
            className="relative flex flex-col items-center"
            style={{
              transform: phase === 1 ? 'translateY(0)' : 'translateY(4px)',
              transition: 'transform 1s ease-out',
            }}
          >
            {/* Ambient glow pulse — recentré au-dessus du bloc logo */}
            <div
              className="pointer-events-none absolute h-52 w-52 rounded-full animate-glow-pulse"
              style={{
                background: 'radial-gradient(circle, rgba(197,165,90,0.18) 0%, transparent 62%)',
                top: '38%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
              }}
            />

            <img
              src="./house-of-the-dragon-logo-01.png"
              alt="House of the Dragon"
              className="relative z-10 max-h-[118px] w-[min(240px,78vw)] object-contain object-top"
              style={{
                filter: `drop-shadow(0 0 ${phase === 1 ? 18 : 12}px rgba(197,165,90,${phase === 1 ? 0.55 : 0.28})) drop-shadow(0 4px 2px rgba(0,0,0,0.9)) drop-shadow(0 14px 24px rgba(0,0,0,0.65))`,
                transition: 'filter 1.2s',
              }}
            />

          {/* SAISON 3 divider */}
          <div
            className="mt-2 flex items-center gap-2"
            style={{
              opacity: phase === 1 ? 1 : 0,
              transform: phase === 1 ? 'translateY(0) scaleX(1)' : 'translateY(5px) scaleX(0.6)',
              transition: 'all 600ms ease-out',
              transitionDelay: phase === 1 ? '450ms' : '0ms',
            }}
          >
            <div className="h-px w-7" style={{ backgroundColor: '#C5A55A' }} />
            <span
              className="font-display text-[11px] font-bold tracking-[0.32em]"
              style={{
                color: '#F2E6C4',
                textShadow: '0 1px 2px rgba(0,0,0,0.95), 0 0 18px rgba(197,165,90,0.35)',
              }}
            >
              SAISON 3
            </span>
            <div className="h-px w-7" style={{ backgroundColor: '#C5A55A' }} />
          </div>
          </div>
        </div>

        {/* ══════ BOTTOM INTERACTION AREA ══════ */}
        <div className="relative w-full h-[158px] mb-1">
          {/* ── PHASE 0: Hold-to-reveal prompt ── */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1.5"
            style={{
              opacity: phase === 0 ? 1 : 0,
              transform: phase === 0 ? 'scale(1)' : 'scale(0.85)',
              transition: 'all 400ms ease',
              pointerEvents: phase === 0 ? 'auto' : 'none',
            }}
          >
            {/* Circular progress ring */}
            <div className="relative w-14 h-14">
              <svg viewBox="0 0 56 56" className="w-full h-full -rotate-90">
                <circle
                  cx="28" cy="28" r="23"
                  fill="none" stroke="#28251F" strokeWidth="1.5"
                />
                <circle
                  cx="28" cy="28" r="23"
                  fill="none" stroke="#C5A55A" strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={CIRC * (1 - progress / 100)}
                  style={{ transition: 'stroke-dashoffset 40ms linear' }}
                />
              </svg>
              {/* Breathing fire icon */}
              <div className="absolute inset-0 flex items-center justify-center animate-breath">
                <svg viewBox="0 0 24 24" className="w-5 h-5">
                  <path d="M12 2c-4 5-8 8-8 12a8 8 0 0016 0c0-4-4-7-8-12z" fill="#C5A55A" />
                  <path d="M12 9c-2 3-4 5-4 7a4 4 0 008 0c0-2-2-4-4-7z" fill="#480800" />
                </svg>
              </div>
            </div>

            <p
              className="font-body text-[9px] font-semibold uppercase tracking-[0.14em]"
              style={{
                color: '#E8DCC4',
                textShadow: '0 1px 3px rgba(0,0,0,0.95), 0 0 12px rgba(0,0,0,0.6)',
              }}
            >
              Maintenez pour réveiller le dragon
            </p>

            {/* Phase 0 footer branding (logo v040) */}
            <img
              src="./02_hbo_houseofdragon_logo_v040__00000_.png"
              alt="HBO"
              className="h-2.5 object-contain mt-1"
              style={{ opacity: 0.25, filter: 'brightness(1.5)' }}
            />
          </div>

          {/* ── PHASE 1: Revealed content ── */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            style={{
              opacity: phase === 1 ? 1 : 0,
              transform: phase === 1 ? 'translateY(0)' : 'translateY(20px)',
              transition: 'all 800ms ease-out',
              transitionDelay: phase === 1 ? '600ms' : '0ms',
              pointerEvents: phase === 1 ? 'auto' : 'none',
            }}
          >
            {/* Tagline */}
            <p
              className="font-accent text-[16px] italic leading-snug"
              style={{
                color: '#F8EFD2',
                textShadow: '0 2px 4px rgba(0,0,0,0.95), 0 0 20px rgba(197,165,90,0.25)',
              }}
            >
              « Feu et Sang »
            </p>

            {/* Info row with poster thumbnail */}
            <div
              className="flex max-w-[288px] items-center gap-3 rounded-md px-2.5 py-2"
              style={{
                background: 'linear-gradient(135deg, rgba(0,0,0,0.72) 0%, rgba(20,12,10,0.55) 100%)',
                border: '1px solid rgba(197,165,90,0.28)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
              }}
            >
              <img
                src="./71mOWQcuxgL.jpg"
                alt="House of the Dragon Saison 3 Affiche"
                className="h-[56px] w-10 shrink-0 rounded-sm object-cover"
                style={{
                  border: '1px solid rgba(197,165,90,0.35)',
                  filter: 'brightness(0.92)',
                }}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <p
                  className="font-body text-[10px] font-bold uppercase leading-tight tracking-[0.1em]"
                  style={{
                    color: '#FAFAFA',
                    textShadow: '0 1px 2px rgba(0,0,0,0.9)',
                  }}
                >
                  Première le 21 juin 2026
                </p>
                <p
                  className="font-body text-[8px] font-semibold uppercase leading-snug tracking-[0.08em]"
                  style={{
                    color: '#E8D4B0',
                    textShadow: '0 1px 2px rgba(0,0,0,0.85)',
                  }}
                >
                  Chaque dimanche sur HBO & Max
                </p>
              </div>
            </div>

            {/* CTA Button */}
            <button
              type="button"
              className="btn btn-sm min-h-0 h-9 animate-cta-glow rounded-sm border border-[#C5A55A]/35 px-9 font-display text-[11px] font-bold uppercase tracking-[0.18em] shadow-lg transition-transform duration-200 hover:brightness-110 active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #9a160d, #3a0804)',
                color: '#F2E6C4',
                textShadow: '0 1px 2px rgba(0,0,0,0.85)',
              }}
            >
              Regarder
            </button>

            {/* Phase 1 footer branding (logo v034) */}
            <img
              src="./hbo_houseofdragon_logo_v034__00000__1.png"
              alt="HBO"
              className="h-[10px] object-contain"
              style={{ opacity: 0.3, filter: 'brightness(1.5)' }}
            />
          </div>
        </div>

        {/* ── Bottom red accent line ── */}
        <div
          className="w-full h-px"
          style={{
            background: 'linear-gradient(90deg, transparent 5%, #7C1009 50%, transparent 95%)',
            opacity: phase === 1 ? 0.4 : 0.08,
            transition: 'opacity 1s',
          }}
        />
      </div>

      {/* ═══ VIGNETTE ═══ */}
      <div
        className="pointer-events-none absolute inset-0 z-20"
        style={{ boxShadow: 'inset 0 0 40px rgba(12,12,20,0.28)' }}
      />
    </div>
  );
}