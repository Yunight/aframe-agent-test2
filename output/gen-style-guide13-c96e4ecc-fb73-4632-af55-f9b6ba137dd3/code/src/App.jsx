import { useState, useEffect, useCallback } from 'react';

/* ── Card data ────────────────────────────────────────────── */
const CARDS = [
  {
    id: 0,
    title: 'Mode Coopératif',
    subtitle: "Jusqu'à 4 joueurs",
    desc: 'Affrontez la Flèche ensemble',
    image: './slay-the-spire-2-new-forces-await-players-linux-steam-deck-mac-windows-pc.jpg',
    accent: '#3CE8D4',
  },
  {
    id: 1,
    title: '5 Personnages',
    subtitle: 'Anciens & nouveaux',
    desc: 'Des stratégies uniques',
    image: './OYVVwPNvfQyWZbZqaQvNdZJ40UR2YGFMYiI9w0MVPYwNMDOsScCwy3YpzDMpp0.jpg',
    accent: '#D9A84E',
  },
  {
    id: 2,
    title: 'Enchantements',
    subtitle: 'Système inédit',
    desc: 'Profondeur stratégique',
    image: './header.jpg',
    accent: '#C2263A',
  },
];

/* ── Floating particle ────────────────────────────────────── */
function Particle({ index }) {
  const colors = ['#3CE8D4', '#D9A84E', '#7B52AB'];
  const left = (index * 47 + 13) % 100;
  const size = (index % 3) + 1.5;
  const dur = (index % 5) * 2 + 8;
  const delay = (index % 7) * 1.3;
  return (
    <div
      className="absolute rounded-full pointer-events-none animate-float"
      style={{
        left: `${left}%`,
        bottom: -4,
        width: size,
        height: size,
        background: colors[index % 3],
        animationDuration: `${dur}s`,
        animationDelay: `${delay}s`,
        opacity: 0,
      }}
    />
  );
}

/* ── Flip card ────────────────────────────────────────────── */
function FlipCard({ card, isFlipped, onFlip, isHovered, onHover, onLeave }) {
  const [burst, setBurst] = useState(false);

  const handleClick = () => {
    if (isFlipped) return;
    setBurst(true);
    onFlip();
    setTimeout(() => setBurst(false), 650);
  };

  return (
    <div
      className={`relative ${!isFlipped ? 'cursor-pointer' : ''}`}
      style={{ perspective: 800, width: 88, height: 130 }}
      onClick={handleClick}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      {/* Energy burst */}
      {burst && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div
            className="w-5 h-5 rounded-full animate-energy-pulse"
            style={{ background: `radial-gradient(circle, ${card.accent}, transparent)` }}
          />
        </div>
      )}

      <div
        className="relative w-full h-full preserve-3d"
        style={{
          transition: 'transform 0.7s cubic-bezier(0.4, 0, 0.2, 1)',
          transform: isFlipped
            ? 'rotateY(180deg)'
            : isHovered
            ? 'rotateY(10deg) scale(1.04)'
            : 'rotateY(0deg)',
        }}
      >
        {/* ── Face-down (card back) ── */}
        <div
          className="absolute inset-0 rounded-xl overflow-hidden flex flex-col items-center justify-center backface-hidden"
          style={{
            background: 'linear-gradient(155deg, #1f2d3d 0%, #0d1117 72%)',
            border: `1px solid ${card.accent}33`,
            boxShadow: isHovered
              ? `0 12px 28px -8px rgba(0,0,0,0.65), 0 0 0 1px ${card.accent}22, 0 0 24px ${card.accent}28`
              : `0 8px 20px -10px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)`,
            transition: 'box-shadow 0.35s ease, border-color 0.35s ease',
          }}
        >
          {/* Decorative borders */}
          <div
            className="absolute inset-[6px] rounded border opacity-[0.15]"
            style={{ borderColor: card.accent }}
          />
          <div
            className="absolute inset-[10px] rounded border opacity-[0.08]"
            style={{ borderColor: card.accent }}
          />

          {/* Corner gems */}
          {[
            'top-1.5 left-1.5',
            'top-1.5 right-1.5',
            'bottom-1.5 left-1.5',
            'bottom-1.5 right-1.5',
          ].map((pos, i) => (
            <div
              key={i}
              className={`absolute ${pos} w-1 h-1 rounded-full opacity-30`}
              style={{ background: card.accent }}
            />
          ))}

          {/* Shimmer sweep */}
          <div
            className="absolute inset-0 animate-shimmer"
            style={{
              background: `linear-gradient(110deg, transparent 30%, ${card.accent}12 50%, transparent 70%)`,
              backgroundSize: '200% 100%',
            }}
          />

          {/* Centre symbol */}
          <div className="text-[26px] font-bold opacity-50" style={{ color: card.accent }}>
            ✦
          </div>
          <div
            className="text-[7px] font-semibold mt-1 uppercase tracking-[0.18em] opacity-35"
            style={{ color: card.accent }}
          >
            Révéler
          </div>
        </div>

        {/* ── Face-up (revealed) ── */}
        <div
          className="absolute inset-0 rounded-xl overflow-hidden flex flex-col backface-hidden rotate-y-180"
          style={{
            background: 'linear-gradient(180deg, #121820 0%, #0d1117 100%)',
            border: `1px solid ${card.accent}55`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 28px -8px rgba(0,0,0,0.6), 0 0 20px ${card.accent}18`,
          }}
        >
          {/* Image */}
          <div className="relative h-[56px] overflow-hidden flex-shrink-0">
            <img src={card.image} alt={card.title} className="w-full h-full object-cover" />
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(to bottom, transparent 40%, #0D1117)' }}
            />
          </div>

          {/* Content */}
          <div className="flex-1 px-2 pt-1 pb-1.5 flex flex-col justify-between">
            <div>
              <div className="text-[11px] font-bold leading-tight" style={{ color: card.accent }}>
                {card.title}
              </div>
              <div className="text-[8px] font-medium mt-0.5" style={{ color: '#E8E4DC' }}>
                {card.subtitle}
              </div>
            </div>
            <div className="text-[7px] leading-snug" style={{ color: '#6B7B8D' }}>
              {card.desc}
            </div>
          </div>

          {/* Accent bar */}
          <div
            className="h-[2px] flex-shrink-0"
            style={{
              background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Main App ─────────────────────────────────────────────── */
export default function App() {
  const [flipped, setFlipped] = useState(new Set());
  const [hoverCard, setHoverCard] = useState(null);
  const [ctaHover, setCtaHover] = useState(false);

  const allFlipped = flipped.size === CARDS.length;

  const handleFlip = useCallback((id) => {
    setFlipped((prev) => new Set([...prev, id]));
  }, []);

  return (
    <div className="relative flex w-full max-w-md flex-col items-center justify-center py-8">
      <div
        className="pointer-events-none absolute h-[min(520px,90vh)] w-[min(380px,95vw)] rounded-full bg-primary/10 blur-[100px]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-0 h-48 w-48 translate-y-1/4 rounded-full bg-secondary/10 blur-3xl"
        aria-hidden
      />

      <div className="relative">
        <div
          className="pointer-events-none absolute -inset-px rounded-[22px] bg-gradient-to-br from-primary/40 via-white/10 to-secondary/35 opacity-95"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -inset-4 rounded-[28px] bg-primary/15 blur-2xl"
          aria-hidden
        />

        <div
          className="relative overflow-hidden rounded-[21px] font-sans select-none shadow-[0_32px_100px_-28px_rgba(0,0,0,0.92)] ring-1 ring-white/[0.08]"
          data-theme="spire"
          style={{ width: 320, height: 480, background: '#0b0f14' }}
        >
          <div
            className="pointer-events-none absolute inset-0 z-30 rounded-[21px] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),inset_0_-80px_120px_-60px_rgba(0,0,0,0.55)]"
            aria-hidden
          />

          {/* ── Floating particles (reduced for cleaner look) ── */}
          {Array.from({ length: 14 }, (_, i) => (
            <Particle key={i} index={i} />
          ))}

          {/* ── Ambient glow ── */}
          <div
            className="absolute -top-16 left-1/2 z-0 h-56 w-56 -translate-x-1/2 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, #3CE8D4, transparent 72%)', opacity: 0.07 }}
          />
          <div
            className="absolute -bottom-20 right-0 z-0 h-44 w-44 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, #7B52AB, transparent 72%)', opacity: 0.06 }}
          />

          {/* ── Hero section ── */}
          <div className="relative z-10 h-[158px] overflow-hidden">
            <img
              src="./2e41754acc7e3176f5a2d5eeeeb89132.jpg"
              alt="Slay the Spire 2 — scène atmosphérique du jeu de cartes roguelike"
              className="h-full w-full scale-[1.02] object-cover"
              style={{ opacity: 0.52 }}
            />
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(7,10,14,0.2) 0%, rgba(11,15,20,0.65) 55%, #0b0f14 100%)',
              }}
            />
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(135deg, rgba(60,232,212,0.06) 0%, transparent 48%, rgba(123,82,171,0.07) 100%)',
              }}
            />
            <div
              className="absolute inset-0 mix-blend-soft-light"
              style={{
                background: 'radial-gradient(ellipse 90% 70% at 50% 0%, rgba(232,228,220,0.12) 0%, transparent 55%)',
              }}
            />

            <div className="absolute left-2.5 top-2.5 z-10 rounded-lg bg-base-100/35 px-2 py-1.5 shadow-lg ring-1 ring-white/10 backdrop-blur-md">
              <img
                src="./30245736-mega-crit-games-llc.png"
                alt="Mega Crit Games — logo du studio indépendant de Seattle"
                className="h-[20px] w-auto"
                style={{ filter: 'brightness(1.15) contrast(1.05)' }}
              />
            </div>

            <div className="absolute right-2.5 top-2.5 z-10 overflow-hidden rounded-lg bg-base-100/30 shadow-lg ring-1 ring-primary/20 backdrop-blur-md">
              <img
                src="./sts2_key_art_16x9_no_logo_new_hub399507e6f37fdfddf2fec2393bae4e3_11044172_380x380_fit_lanczos_3.png"
                alt="Slay the Spire 2 — illustration clé du monde du jeu"
                className="block h-[30px] w-auto"
              />
            </div>

            <div className="absolute bottom-3 left-0 right-0 z-10 px-3 text-center">
              <p className="mb-1 font-mono text-[8px] font-medium uppercase tracking-[0.35em] text-base-content/45">
                Roguelike deckbuilder
              </p>
              <h1 className="font-display text-[22px] font-extrabold leading-none tracking-[0.11em] text-spire-cream drop-shadow-[0_2px_24px_rgba(0,0,0,0.65)] animate-title-glow">
                SLAY THE SPIRE 2
              </h1>
              <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
                La Flèche s&apos;est réveillée
              </p>
            </div>
          </div>

          <div
            className="relative z-10 mx-8 mt-2 h-px"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(60,232,212,0.35) 20%, rgba(217,168,78,0.35) 50%, rgba(194,38,58,0.25) 80%, transparent 100%)',
            }}
          />

          <p className="relative z-10 mx-6 mb-2 mt-2.5 text-center text-[8px] font-semibold uppercase tracking-[0.28em] text-base-content/50">
            Révélez votre destin
          </p>

          <div className="relative z-10 flex justify-center gap-[10px] px-3">
            {CARDS.map((card) => (
              <FlipCard
                key={card.id}
                card={card}
                isFlipped={flipped.has(card.id)}
                onFlip={() => handleFlip(card.id)}
                isHovered={hoverCard === card.id}
                onHover={() => !flipped.has(card.id) && setHoverCard(card.id)}
                onLeave={() => setHoverCard(null)}
              />
            ))}
          </div>

          {/* ── Progress dots ── */}
          <div className="relative z-10 mt-3 flex items-center justify-center gap-1.5">
            {CARDS.map((card) => (
              <div
                key={card.id}
                className="rounded-full transition-all duration-500 ease-out"
                style={{
                  width: flipped.has(card.id) ? 18 : 6,
                  height: 6,
                  background: flipped.has(card.id) ? card.accent : '#1A2838',
                  boxShadow: flipped.has(card.id) ? `0 0 8px ${card.accent}55` : 'none',
                }}
              />
            ))}
          </div>

          {/* ── Reveal bonus scene — gameplay combat scene showing card-based battles ── */}
          {allFlipped && (
            <div
              className="relative z-10 mx-4 mt-2.5 overflow-hidden rounded-lg ring-1 ring-primary/15 animate-fade-in-up"
              style={{ height: 34 }}
            >
              <img
                src="./slay-the-spire-2-dev-outlines-first-big-post-launch-patch-hu_w58f.640.jpg"
                alt="Slay the Spire 2 — aperçu du gameplay de combat avec cartes"
                className="h-full w-full object-cover"
                style={{ opacity: 0.55 }}
              />
              <div
                className="pointer-events-none absolute inset-0 bg-gradient-to-t from-base-100/80 to-transparent"
                aria-hidden
              />
            </div>
          )}

          {/* ── Bottom CTA area ── */}
          <div className="absolute bottom-0 left-0 right-0 z-20 px-4 pb-3">
            <button
              type="button"
              className={`btn btn-block h-9 min-h-0 border-0 text-[10px] font-bold uppercase tracking-[0.14em] shadow-lg transition-all duration-500 ${
                allFlipped ? 'animate-cta-glow ring-2 ring-secondary/40 ring-offset-2 ring-offset-base-100' : 'opacity-95'
              }`}
              style={{
                background: allFlipped
                  ? 'linear-gradient(135deg, #e4bc63 0%, #c2263a 100%)'
                  : 'linear-gradient(180deg, #1f2d3d 0%, #141c26 100%)',
                color: allFlipped ? '#0b0f14' : '#8a9aac',
                borderRadius: 10,
                transform: ctaHover && allFlipped ? 'scale(1.03)' : 'scale(1)',
                boxShadow: allFlipped ? '0 12px 28px -8px rgba(194,38,58,0.35)' : '0 8px 20px -10px rgba(0,0,0,0.5)',
              }}
              onMouseEnter={() => setCtaHover(true)}
              onMouseLeave={() => setCtaHover(false)}
            >
              {allFlipped ? 'Jouer maintenant' : `Cartes révélées : ${flipped.size} / ${CARDS.length}`}
            </button>

            <div className="mt-2 flex items-center justify-between">
              <p className="text-[7px] font-mono uppercase tracking-wider text-base-content/45">
                Accès anticipé · Steam · 2026
              </p>
              <img
                src="./scrupf.png"
                alt="Scrupf — logo partenaire"
                className="h-[10px] w-auto opacity-50"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
