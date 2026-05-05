import { useState, useEffect, useCallback, useRef } from 'react';

/*
  IMAGE DESCRIPTIONS (for integration context):
  ────────────────────────────────────────────
  • Ikea-Logo-PNG-Photo.png — The iconic IKEA wordmark logo: bold white
    "IKEA" lettering on a blue-and-yellow oval shield. Used in the header
    as the brand signature across every slide.

  • chair2_e95113c67d.jpg — IKEA PS 2026 Inflatable Easy Chair. Rich
    emerald-green fabric-wrapped air cushions bulging through a sleek
    tubular chrome/carbon-steel frame, creating a playful balloon-trapped
    silhouette. Hero product visual on the chair slide.

  • ikea-ps-collection-milan-design-week-2026-rocking-bench-nordroom.jpg —
    IKEA PS 2026 Rocking Bench in solid pine. A sculptural bench that sways
    side-to-side with reversed wood-grain construction for strength, fully
    recyclable. Hero visual on the bench slide.

  • lex-pott-designed-flexible-colorful-floor-lamp-ikea-ps-collection-2026-nordroom.jpg —
    Lex Pott's three-directional floor lamp for IKEA PS 2026. A trumpet-
    shaped shade on a slender stem with a wide conical base, shown in a
    saturated colorway. Hero visual on the lamp slide.

  • nm4YEj99BQSUGPowz8GFp9.jpg — Lifestyle/collection hero shot for IKEA
    PS 2026 showing the products in a styled interior environment. Used as
    a cinematic background on the opening hero slide.

  • yellow-ikea-lamp-designed-by-lex-pott-milan-design-week-ikea-ps-collection-2026-nordroom.jpg —
    The same Lex Pott floor lamp in its chartreuse-yellow colourway,
    emphasising the range of finishes. Shown as an inset colour-variant
    badge on the lamp slide.
*/

const SLIDE_DURATION = 4200;

const slides = [
  {
    type: 'hero',
    bgImage: './nm4YEj99BQSUGPowz8GFp9.jpg',
    bg: '#0051BA',
    text: '#FFFFFF',
    accent: '#FFDA1A',
  },
  {
    type: 'product',
    image: './chair2_e95113c67d.jpg',
    name: 'Fauteuil Gonflable',
    designer: 'Mikael Axelsson',
    tagline: 'Le confort, réinventé.',
    detail: 'Gonflé à la main — léger, durable',
    bg: '#046A38',
    text: '#FFFFFF',
    accent: '#FFDA1A',
  },
  {
    type: 'product',
    image: './ikea-ps-collection-milan-design-week-2026-rocking-bench-nordroom.jpg',
    name: 'Banc à Bascule',
    designer: 'Marta Krupińska',
    tagline: 'Basculez vers la joie.',
    detail: 'Pin massif — 100\u202F% recyclable',
    bg: '#1A1A2E',
    text: '#FFFFFF',
    accent: '#C8A97E',
  },
  {
    type: 'product',
    image: './lex-pott-designed-flexible-colorful-floor-lamp-ikea-ps-collection-2026-nordroom.jpg',
    altImage: './yellow-ikea-lamp-designed-by-lex-pott-milan-design-week-ikea-ps-collection-2026-nordroom.jpg',
    name: 'Lampadaire Flexible',
    designer: 'Lex Pott',
    tagline: 'La lumière, libérée.',
    detail: '3 directions — couleurs vibrantes',
    bg: '#E8D44D',
    text: '#111111',
    accent: '#0051BA',
  },
];

export default function App() {
  const [current, setCurrent] = useState(0);
  const [animKey, setAnimKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef(null);
  const startTime = useRef(Date.now());

  /* ── navigation helpers ── */
  const goTo = useCallback((i) => {
    const next = ((i % slides.length) + slides.length) % slides.length;
    setCurrent(next);
    setAnimKey((k) => k + 1);
    setProgress(0);
    startTime.current = Date.now();
  }, []);

  const next = useCallback(() => goTo(current + 1), [current, goTo]);
  const prev = useCallback(() => goTo(current - 1), [current, goTo]);

  /* ── auto-advance ── */
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(next, SLIDE_DURATION);
    return () => clearTimeout(t);
  }, [current, next, paused]);

  /* ── progress bar animation ── */
  useEffect(() => {
    let raf;
    const tick = () => {
      if (!paused) {
        const elapsed = Date.now() - startTime.current;
        setProgress(Math.min(elapsed / SLIDE_DURATION, 1));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animKey, paused]);

  /* ── touch handlers ── */
  const onTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    setPaused(true);
  };
  const onTouchEnd = (e) => {
    setPaused(false);
    if (touchStartX.current === null) return;
    const diff = touchStartX.current - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 30) {
      diff > 0 ? next() : prev();
    }
    touchStartX.current = null;
  };

  /* ── click left/right ── */
  const onClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    x > 160 ? next() : prev();
  };

  const s = slides[current];
  const isLight = s.text === '#FFFFFF';

  /* helper: inline animation shorthand */
  const anim = (delay = 0) => ({
    opacity: 0,
    animation: `slideInUp 0.5s ease-out ${delay}s forwards`,
  });

  return (
    <div
      className="relative overflow-hidden select-none cursor-pointer font-noto"
      style={{
        width: 320,
        height: 480,
        borderRadius: 16,
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onClick={onClick}
    >
      {/* ═══ Background ═══ */}
      <div
        className="absolute inset-0 transition-colors duration-700 ease-in-out"
        style={{ backgroundColor: s.bg }}
      />

      {/* Hero slide BG image (collection lifestyle shot) */}
      {s.type === 'hero' && (
        <div className="absolute inset-0 z-[1]">
          <img
            src={s.bgImage}
            alt="Collection IKEA PS 2026"
            className="w-full h-full object-cover"
            style={{ opacity: 0.22 }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(180deg, ${s.bg}88 0%, ${s.bg}DD 55%, ${s.bg} 100%)`,
            }}
          />
        </div>
      )}

      {/* ═══ Decorative floating orbs ═══ */}
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          width: 90,
          height: 90,
          backgroundColor: s.accent,
          opacity: 0.07,
          top: 55,
          right: -25,
          animation: 'floatSlow 7s ease-in-out infinite',
        }}
      />
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          width: 50,
          height: 50,
          backgroundColor: s.text,
          opacity: 0.05,
          bottom: 195,
          left: -15,
          animation: 'floatSlow 9s ease-in-out 2s infinite',
        }}
      />

      {/* ═══ Progress bars (Stories-style) ═══ */}
      <div className="absolute top-0 left-0 right-0 z-50 flex gap-[3px] px-3 pt-[7px]">
        {slides.map((_, i) => (
          <div
            key={i}
            className="h-[2.5px] flex-1 rounded-full overflow-hidden"
            style={{
              backgroundColor: isLight
                ? 'rgba(255,255,255,0.22)'
                : 'rgba(0,0,0,0.10)',
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                backgroundColor: isLight
                  ? 'rgba(255,255,255,0.88)'
                  : 'rgba(0,0,0,0.48)',
                width:
                  i < current
                    ? '100%'
                    : i === current
                    ? `${progress * 100}%`
                    : '0%',
                transition: i === current ? 'none' : 'width 0.3s',
              }}
            />
          </div>
        ))}
      </div>

      {/* ═══ Header: Logo + Badge ═══ */}
      <div className="absolute top-[19px] left-0 right-0 z-40 flex items-center justify-between px-4">
        <img
          src="./Ikea-Logo-PNG-Photo.png"
          alt="IKEA"
          className="h-[18px] object-contain"
          style={{
            filter: isLight ? 'brightness(0) invert(1)' : 'none',
          }}
        />
        <span
          className="badge badge-sm font-bold tracking-wider border-none"
          style={{
            backgroundColor: s.accent,
            color: s.bg,
            fontSize: 9,
            height: 20,
            minHeight: 20,
            paddingLeft: 8,
            paddingRight: 8,
            letterSpacing: '0.1em',
          }}
        >
          PS 2026
        </span>
      </div>

      {/* ═══════════════════════════════
           HERO SLIDE (Collection Intro)
         ═══════════════════════════════ */}
      {s.type === 'hero' && (
        <div
          key={`hero-${animKey}`}
          className="absolute inset-0 z-20 flex flex-col items-center justify-center px-8 text-center"
        >
          <p
            className="font-medium uppercase mb-3"
            style={{
              ...anim(0.1),
              color: s.accent,
              fontSize: 11,
              letterSpacing: '0.22em',
            }}
          >
            Nouvelle collection
          </p>
          <h1
            className="font-extrabold leading-none mb-0"
            style={{
              ...anim(0.2),
              color: s.text,
              fontSize: 44,
              letterSpacing: '-0.03em',
            }}
          >
            IKEA PS
          </h1>
          <h2
            className="font-extrabold leading-none mb-5"
            style={{
              ...anim(0.32),
              color: s.accent,
              fontSize: 60,
              letterSpacing: '-0.04em',
            }}
          >
            2026
          </h2>
          <p
            className="font-medium mb-9"
            style={{ ...anim(0.46), color: s.text, fontSize: 17 }}
          >
            Le design qui joue.
          </p>
          <div style={anim(0.6)}>
            <button
              className="btn btn-sm px-10 font-bold tracking-wide border-none"
              style={{
                backgroundColor: '#FFDA1A',
                color: '#111111',
                borderRadius: 9999,
                fontSize: 13,
                animation: 'pulseCta 2.8s ease-in-out 1.2s infinite',
              }}
            >
              Découvrir&nbsp;→
            </button>
          </div>

          {/* Swipe hint */}
          <p
            className="flex items-center gap-1 font-medium mt-10"
            style={{
              ...anim(0.75),
              color: s.text,
              fontSize: 10,
            }}
          >
            <span style={{ opacity: 0.45 }}>Glissez pour explorer</span>
            <span
              style={{
                display: 'inline-block',
                animation: 'swipeHint 1.5s ease-in-out 1.5s infinite',
              }}
            >
              →
            </span>
          </p>
        </div>
      )}

      {/* ═══════════════════════════════
           PRODUCT SLIDES
         ═══════════════════════════════ */}
      {s.type === 'product' && (
        <>
          {/* Product image area */}
          <div
            className="absolute z-10 flex items-center justify-center"
            style={{ top: 48, left: 0, right: 0, bottom: 192 }}
          >
            <img
              key={`pimg-${animKey}`}
              src={s.image}
              alt={s.name}
              className="max-h-full object-contain"
              style={{
                maxWidth: '82%',
                opacity: 0,
                animation:
                  'fadeIn 0.55s ease-out forwards, float 4.5s ease-in-out 0.6s infinite',
                filter: 'drop-shadow(0 10px 28px rgba(0,0,0,0.22))',
              }}
            />

            {/* Colour-variant badge for lamp slide */}
            {s.altImage && (
              <div
                key={`alt-${animKey}`}
                className="absolute overflow-hidden"
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: '50%',
                  bottom: 6,
                  right: 22,
                  border: `2.5px solid ${s.accent}`,
                  boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
                  ...anim(0.55),
                }}
              >
                <img
                  src={s.altImage}
                  alt="Variante couleur jaune"
                  className="w-full h-full object-cover"
                />
              </div>
            )}
          </div>

          {/* Bottom info + CTA */}
          <div
            className="absolute bottom-0 left-0 right-0 z-20 px-5 pb-[18px]"
            style={{
              background: `linear-gradient(to top, ${s.bg} 58%, ${s.bg}DD 78%, transparent)`,
            }}
          >
            <div key={`info-${animKey}`}>
              {/* Designer label */}
              <p
                className="font-semibold uppercase mb-[3px]"
                style={{
                  ...anim(0.15),
                  color: s.accent,
                  fontSize: 10,
                  letterSpacing: '0.14em',
                }}
              >
                {s.designer}
              </p>

              {/* Tagline */}
              <h2
                className="font-bold leading-tight mb-[2px]"
                style={{
                  ...anim(0.25),
                  color: s.text,
                  fontSize: 22,
                }}
              >
                {s.tagline}
              </h2>

              {/* Product name */}
              <p
                className="font-medium mb-[2px]"
                style={{
                  ...anim(0.35),
                  color: s.text,
                  fontSize: 14,
                }}
              >
                {s.name}
              </p>

              {/* Detail */}
              <p
                className="mb-4"
                style={{
                  ...anim(0.42),
                  color: isLight ? '#E0E0E0' : '#333333',
                  fontSize: 11,
                }}
              >
                {s.detail}
              </p>
            </div>

            {/* CTA */}
            <button
              className="btn btn-sm w-full font-bold tracking-wide border-none"
              style={{
                backgroundColor: '#FFDA1A',
                color: '#111111',
                borderRadius: 9999,
                fontSize: 13,
                animation: 'pulseCta 2.8s ease-in-out 1s infinite',
              }}
            >
              Découvrir la collection&nbsp;→
            </button>

            {/* Date footer */}
            <p
              className="text-center font-medium mt-[10px]"
              style={{
                color: isLight ? '#E0E0E0' : '#333333',
                fontSize: 9,
                letterSpacing: '0.04em',
              }}
            >
              Disponible le 14 mai 2026
            </p>
          </div>
        </>
      )}
    </div>
  );
}
