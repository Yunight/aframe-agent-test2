import { useState, useMemo, useCallback, useEffect } from 'react';

/* ─── data ─── */
const DEALS = [
  { threshold: '49€', discount: '5€', label: 'offerts' },
  { threshold: '99€', discount: '10€', label: 'offerts' },
  { threshold: '149€', discount: '15€', label: 'offerts' },
];

const CONFETTI_COLORS = ['#FFF200', '#EE1C25', '#015AA2', '#FFD700', '#4CAF50', '#FFFFFF'];

/* ─── Confetti component ─── */
function Confetti() {
  const particles = useMemo(
    () =>
      Array.from({ length: 45 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.7,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        w: 4 + Math.random() * 7,
        h: 3 + Math.random() * 5,
        duration: 1.1 + Math.random() * 0.9,
      })),
    []
  );

  return (
    <div className="absolute inset-0 pointer-events-none z-50 overflow-hidden">
      {particles.map((p) => (
        <div
          key={p.id}
          style={{
            position: 'absolute',
            left: `${p.left}%`,
            top: '-14px',
            width: `${p.w}px`,
            height: `${p.h}px`,
            backgroundColor: p.color,
            borderRadius: '1.5px',
            animation: `confettiFall ${p.duration}s ${p.delay}s ease-in forwards`,
          }}
        />
      ))}
    </div>
  );
}

/* ─── FlipCard component ─── */
function FlipCard({ deal, index, isFlipped, onFlip }) {
  return (
    <div
      className="w-full cursor-pointer select-none"
      role="button"
      tabIndex={0}
      aria-label={`Révéler l'offre ${index + 1}`}
      onClick={() => onFlip(index)}
      onKeyDown={(e) => e.key === 'Enter' && onFlip(index)}
      style={{
        perspective: '800px',
        height: '52px',
        animation: `fadeInUp 0.45s ${0.55 + index * 0.13}s ease-out both`,
      }}
    >
      <div
        className="relative w-full h-full"
        style={{
          transformStyle: 'preserve-3d',
          transform: isFlipped ? 'rotateX(180deg)' : 'rotateX(0)',
          transition: 'transform 0.55s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Front face */}
        <div
          className="absolute inset-0 rounded-xl flex items-center justify-between px-3"
          style={{
            backfaceVisibility: 'hidden',
            background: 'linear-gradient(135deg, #F5F5F5 0%, #E0E0E0 100%)',
            border: '2px dashed rgba(1,90,162,0.35)',
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#015AA2' }}
            >
              <span
                style={{
                  color: '#FFFFFF',
                  fontWeight: 700,
                  fontSize: '14px',
                  fontFamily: "'Lidl Font Pro', Arial, sans-serif",
                }}
              >
                ?
              </span>
            </div>
            <span
              style={{
                color: '#015AA2',
                fontWeight: 600,
                fontSize: '13px',
                fontFamily: "'Lidl Font Pro', Arial, sans-serif",
              }}
            >
              Offre n°{index + 1}
            </span>
          </div>
          <div className="flex items-center gap-1" style={{ animation: index === 0 ? 'shake 1.8s 1.5s ease-in-out infinite' : 'none' }}>
            <span style={{ color: '#015AA2', fontSize: '10px', opacity: 0.6 }}>Touchez</span>
            <span style={{ fontSize: '15px' }}>👆</span>
          </div>
        </div>

        {/* Back face */}
        <div
          className="absolute inset-0 rounded-xl flex items-center px-3 gap-2.5"
          style={{
            backfaceVisibility: 'hidden',
            transform: 'rotateX(180deg)',
            background: 'linear-gradient(135deg, #FFF200 0%, #FFD700 100%)',
            boxShadow: '0 3px 14px rgba(255,242,0,0.35)',
          }}
        >
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: '#EE1C25' }}
          >
            <span
              style={{
                color: '#FFFFFF',
                fontWeight: 700,
                fontSize: '11px',
                fontFamily: "'Lidl Font Pro', Arial, sans-serif",
              }}
            >
              -{deal.discount}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div
              style={{
                color: '#000000',
                fontWeight: 700,
                fontSize: '14px',
                lineHeight: 1.2,
                fontFamily: "'Lidl Font Pro', Arial, sans-serif",
              }}
            >
              {deal.discount} {deal.label}
            </div>
            <div
              style={{
                color: '#1A1A2E',
                fontSize: '10.5px',
                fontWeight: 400,
                fontFamily: "'Lidl Font Pro', Arial, sans-serif",
              }}
            >
              dès {deal.threshold} d'achat
            </div>
          </div>
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: '#4CAF50' }}
          >
            <span style={{ color: '#FFFFFF', fontSize: '12px', fontWeight: 700 }}>✓</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Main App ─── */
export default function App() {
  const [flipped, setFlipped] = useState([false, false, false]);
  const [allRevealed, setAllRevealed] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);

  const handleFlip = useCallback(
    (index) => {
      if (flipped[index]) return;
      setFlipped((prev) => {
        const next = [...prev];
        next[index] = true;
        if (next.every(Boolean)) {
          setAllRevealed(true);
          setShowConfetti(true);
          setTimeout(() => setShowConfetti(false), 2600);
        }
        return next;
      });
    },
    [flipped]
  );

  const revealedCount = flipped.filter(Boolean).length;

  return (
    <div
      className="w-[320px] h-[480px] relative overflow-hidden rounded-2xl"
      style={{
        fontFamily: "'Lidl Font Pro', Arial, sans-serif",
        background: 'linear-gradient(175deg, #002395 0%, #015AA2 28%, #015AA2 100%)',
        boxShadow: '0 16px 50px rgba(0,0,0,0.3)',
      }}
    >
      {showConfetti && <Confetti />}

      {/* ═══ HEADER BAR ═══ */}
      <div
        className="flex items-center gap-2 px-3 pt-2.5 pb-1.5"
        style={{ animation: 'fadeInDown 0.4s ease-out both' }}
      >
        {/* Lidl square logo – 500×500 transparent PNG, the iconic Lidl brand mark with blue/red/yellow ring and 'Lidl' wordmark */}
        <img
          src="./li6200l956-lidl-logo-lidl-square-logo-transparent-png-stickpng.png"
          alt="Logo Lidl"
          className="rounded-lg object-contain"
          style={{
            width: '42px',
            height: '42px',
            backgroundColor: 'rgba(255,255,255,0.95)',
            padding: '3px',
            animation: 'bounceIn 0.6s ease-out both',
          }}
        />
        <div className="flex-1">
          <div
            style={{
              fontSize: '20px',
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              background: 'linear-gradient(90deg, #FFF200, #FFFFFF, #FFF200)',
              backgroundSize: '200% auto',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              animation: 'shimmer 2.5s linear infinite',
            }}
          >
            FRENCH DAYS
          </div>
          <div
            style={{
              fontSize: '10px',
              color: 'rgba(255,255,255,0.8)',
              fontWeight: 300,
              marginTop: '1px',
            }}
          >
            Du 29 avril au 5 mai 2026
          </div>
        </div>
        <div
          className="badge border-0"
          style={{
            backgroundColor: '#EE1C25',
            color: '#FFFFFF',
            fontSize: '8.5px',
            fontWeight: 700,
            padding: '0 8px',
            height: '20px',
            minHeight: '20px',
            animation: 'pulse 2s ease-in-out infinite',
          }}
        >
          EN COURS
        </div>
      </div>

      {/* ═══ HERO IMAGE ═══ */}
      {/* French-Days-1024x576.png – A promotional French Days banner (1024×576) showing the official French Days branding and promotional visuals */}
      <div
        className="relative mx-2.5 rounded-xl overflow-hidden"
        style={{
          height: '118px',
          animation: 'fadeInUp 0.45s 0.2s ease-out both',
        }}
      >
        <img
          src="./French-Days-1024x576.png"
          alt="French Days – Offres exceptionnelles chez Lidl"
          className="w-full h-full object-cover"
        />
        {/* gradient overlay */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, rgba(0,35,149,0.75) 0%, rgba(0,35,149,0.2) 45%, transparent 70%)',
          }}
        />
        <div className="absolute bottom-2 left-3 right-3 flex justify-between items-end">
          <div>
            <div
              style={{
                color: '#FFFFFF',
                fontSize: '12px',
                fontWeight: 700,
                lineHeight: 1.2,
                textShadow: '0 1px 3px rgba(0,0,0,0.4)',
              }}
            >
              Des offres engagées
            </div>
            <div
              style={{
                color: '#FFF200',
                fontSize: '9.5px',
                fontWeight: 400,
                textShadow: '0 1px 2px rgba(0,0,0,0.3)',
              }}
            >
              pour votre pouvoir d'achat
            </div>
          </div>
          <div
            className="px-2 py-1 rounded-lg"
            style={{
              backgroundColor: '#FFF200',
              animation: 'badgeBounce 2.2s ease-in-out infinite',
            }}
          >
            <span
              style={{
                color: '#EE1C25',
                fontWeight: 700,
                fontSize: '14px',
                fontFamily: "'Lidl Font Pro', Arial, sans-serif",
              }}
            >
              -15€
            </span>
          </div>
        </div>
      </div>

      {/* ═══ INTERACTIVE SECTION TITLE ═══ */}
      <div
        className="text-center pt-2.5 pb-1 px-3"
        style={{ animation: 'fadeInUp 0.4s 0.38s ease-out both' }}
      >
        <div
          style={{
            color: '#FFF200',
            fontSize: '12px',
            fontWeight: 700,
            letterSpacing: '0.04em',
          }}
        >
          🎁 RÉVÉLEZ VOS REMISES 🎁
        </div>
        {/* progress indicator */}
        <div className="flex items-center justify-center gap-1.5 mt-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-full"
              style={{
                width: '7px',
                height: '7px',
                backgroundColor: flipped[i] ? '#4CAF50' : 'rgba(255,255,255,0.25)',
                transition: 'all 0.35s ease',
                transform: flipped[i] ? 'scale(1.25)' : 'scale(1)',
                boxShadow: flipped[i] ? '0 0 6px rgba(76,175,80,0.5)' : 'none',
              }}
            />
          ))}
          <span
            style={{
              color: 'rgba(255,255,255,0.55)',
              fontSize: '10px',
              fontWeight: 400,
              marginLeft: '4px',
            }}
          >
            {revealedCount}/3
          </span>
        </div>
      </div>

      {/* ═══ DEAL FLIP CARDS ═══ */}
      <div className="px-3 flex flex-col gap-1.5 mt-1">
        {DEALS.map((deal, i) => (
          <FlipCard
            key={i}
            deal={deal}
            index={i}
            isFlipped={flipped[i]}
            onFlip={handleFlip}
          />
        ))}
      </div>

      {/* ═══ CTA BUTTON ═══ */}
      <div
        className="px-3 mt-2.5"
        style={{ animation: 'fadeInUp 0.4s 0.95s ease-out both' }}
      >
        <button
          className="btn btn-block border-2 rounded-full no-animation"
          style={{
            backgroundColor: '#EE1C25',
            borderColor: allRevealed ? '#FFF200' : 'rgba(255,242,0,0.6)',
            color: '#FFFFFF',
            fontWeight: 700,
            fontFamily: "'Lidl Font Pro', Arial, sans-serif",
            fontSize: allRevealed ? '13.5px' : '12.5px',
            animation: allRevealed ? 'glowPulse 1.4s ease-in-out infinite' : 'none',
            transition: 'all 0.5s ease',
            minHeight: '40px',
            height: '40px',
            textTransform: 'none',
            letterSpacing: '0',
          }}
        >
          {allRevealed ? "🔥 J'en profite sur lidl.fr !" : 'Découvrir toutes les offres →'}
        </button>
      </div>

      {/* ═══ FOOTER ═══ */}
      <div
        className="absolute bottom-0 left-0 right-0 text-center py-1"
        style={{
          backgroundColor: 'rgba(0,0,0,0.22)',
          backdropFilter: 'blur(4px)',
        }}
      >
        <span
          style={{
            color: 'rgba(255,255,255,0.65)',
            fontSize: '8px',
            fontWeight: 300,
            fontFamily: "'Lidl Font Pro', Arial, sans-serif",
          }}
        >
          🚚 Livraison offerte avec Lidl Plus • lidl.fr
        </span>
      </div>
    </div>
  );
}
