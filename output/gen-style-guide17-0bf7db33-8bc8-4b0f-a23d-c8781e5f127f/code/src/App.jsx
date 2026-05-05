import { useState, useEffect, useCallback, useRef } from 'react';

/*
  Image asset descriptions:
  ─────────────────────────
  • air-france-11-logo-png-transparent.png (2400×259) — The official Air France brand logo
    in a wide horizontal layout featuring the iconic winged seahorse emblem and
    "AIR FRANCE" wordmark on a transparent background. Used inverted to white on the
    dark navy header bar.

  • Air_france_airbus_a350_f-htya.jpg (1600×1086) — An Air France Airbus A350-900
    (registration F-HTYA) photographed in the airline's signature livery with the
    navy-blue fuselage and red accent tail. Used as the hero visual for the New York route.

  • view-outside-the-plane-window-and-view-of-business-class-cabin-on-air-france-
    airline-review-12.jpg (1200×794) — A dual-perspective image combining the view
    from a cabin window at altitude alongside the refined Air France business-class
    interior with lie-flat seats and ambient lighting. Hero visual for the Tokyo route.

  • ST_Air_France_B777.jpg (1200×800) — An Air France Boeing 777-300ER captured in
    flight in the airline's current livery, showcasing the widebody long-haul fleet.
    Hero visual for the Dubaï route.

  • 218a2f8bee2329a6759b75c06e32bcb2.jpg (453×604) — A portrait-format lifestyle
    image evoking the premium Air France cabin experience. Used as a small accent
    thumbnail labelled "Classe Affaires".

  • 94f9bd7a2c6c23bdac2a0eb93326de98.jpg (3637×2437) — A wide scenic destination
    photograph conveying wanderlust and the thrill of discovery. Used as a small
    accent thumbnail labelled "La Première".
*/

const CYCLE_MS = 4000;

const destinations = [
  {
    city: 'New York',
    image: './Air_france_airbus_a350_f-htya.jpg',
    price: 432,
    oldPrice: 665,
    discount: 35,
  },
  {
    city: 'Tokyo',
    image:
      './view-outside-the-plane-window-and-view-of-business-class-cabin-on-air-france-airline-review-12.jpg',
    price: 589,
    oldPrice: 982,
    discount: 40,
  },
  {
    city: 'Dubaï',
    image: './ST_Air_France_B777.jpg',
    price: 399,
    oldPrice: 532,
    discount: 25,
  },
];

export default function App() {
  const [activeIdx, setActiveIdx] = useState(0);
  const [displayPrice, setDisplayPrice] = useState(destinations[0].price);
  const [hovering, setHovering] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [ctaHover, setCtaHover] = useState(false);
  const [progressKey, setProgressKey] = useState(0);
  const priceRef = useRef(destinations[0].price);
  const boxRef = useRef(null);

  const cur = destinations[activeIdx];

  /* ── auto-cycle ── */
  useEffect(() => {
    if (hovering) return;
    const id = setInterval(() => {
      setActiveIdx((p) => (p + 1) % destinations.length);
      setProgressKey((k) => k + 1);
    }, CYCLE_MS);
    return () => clearInterval(id);
  }, [hovering]);

  /* ── animate price counter ── */
  useEffect(() => {
    const target = destinations[activeIdx].price;
    const start = priceRef.current;
    const diff = target - start;
    if (diff === 0) return;
    const dur = 480;
    let t0 = null;
    let raf;
    const step = (ts) => {
      if (!t0) t0 = ts;
      const p = Math.min((ts - t0) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const v = Math.round(start + diff * e);
      setDisplayPrice(v);
      priceRef.current = v;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => raf && cancelAnimationFrame(raf);
  }, [activeIdx]);

  /* ── mouse parallax ── */
  const onMove = useCallback((e) => {
    if (!boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setMousePos({
      x: ((e.clientX - r.left) / r.width - 0.5) * 2,
      y: ((e.clientY - r.top) / r.height - 0.5) * 2,
    });
  }, []);

  const pick = (i) => {
    if (i !== activeIdx) {
      setActiveIdx(i);
      setProgressKey((k) => k + 1);
    }
  };

  /* ── font stacks (style-guide families with web fallbacks) ── */
  const fNeo = '"Neo Sans", Montserrat, system-ui, sans-serif';
  const fFru = 'Frutiger, "Source Sans 3", system-ui, sans-serif';

  return (
    <div
      ref={boxRef}
      onMouseMove={onMove}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false);
        setMousePos({ x: 0, y: 0 });
      }}
      className="relative overflow-hidden flex flex-col select-none"
      style={{
        width: 320,
        height: 480,
        background: '#002157',
        borderRadius: 12,
        boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
      }}
    >
      {/* ═══════ HEADER ═══════ */}
      <div
        className="flex-shrink-0 flex items-center justify-center relative z-30"
        style={{ height: 44, background: '#002157' }}
      >
        <img
          src="./air-france-11-logo-png-transparent.png"
          alt="Air France"
          draggable={false}
          style={{
            height: 18,
            objectFit: 'contain',
            filter: 'brightness(0) invert(1)',
          }}
        />
      </div>

      {/* ═══════ TRICOLOR LINE ═══════ */}
      <div className="flex-shrink-0 flex" style={{ height: 3 }}>
        <div style={{ flex: 1, background: '#002157' }} />
        <div style={{ flex: 1, background: '#FFFFFF' }} />
        <div style={{ flex: 1, background: '#F71D25' }} />
      </div>

      {/* ═══════ HERO IMAGE CAROUSEL ═══════ */}
      <div
        className="relative flex-shrink-0 overflow-hidden"
        style={{ height: 190 }}
      >
        {destinations.map((d, i) => (
          <div
            key={i}
            className="absolute inset-0 hero-img-wrap"
            style={{
              opacity: i === activeIdx ? 1 : 0,
              transform:
                i === activeIdx
                  ? `scale(1.08) translate(${mousePos.x * -6}px, ${mousePos.y * -4}px)`
                  : 'scale(1.14)',
              transition: 'opacity 0.8s ease, transform 0.35s ease-out',
            }}
          >
            <img
              src={d.image}
              alt={d.city}
              className="w-full h-full object-cover"
              draggable={false}
            />
          </div>
        ))}

        {/* gradient overlay */}
        <div
          className="absolute inset-0 z-10 pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, rgba(0,33,87,0.12) 0%, rgba(0,33,87,0) 30%, rgba(0,33,87,0.55) 65%, rgba(0,33,87,1) 100%)',
          }}
        />

        {/* hero text */}
        <div className="absolute bottom-0 left-0 right-0 z-20 px-4 pb-3">
          <p
            style={{
              fontFamily: fFru,
              fontWeight: 300,
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: '#CCE5FF',
              marginBottom: 3,
            }}
          >
            ✈ Offres Exclusives
          </p>
          <h1
            key={activeIdx}
            className="animate-slide-up"
            style={{
              fontFamily: fNeo,
              fontWeight: 700,
              fontSize: 26,
              lineHeight: 1.1,
              color: '#FFFFFF',
              letterSpacing: '-0.02em',
            }}
          >
            Paris → {cur.city}
          </h1>
        </div>

        {/* cycle progress bar */}
        <div
          className="absolute bottom-0 left-0 right-0 z-30 overflow-hidden"
          style={{ height: 2 }}
        >
          <div
            key={progressKey}
            style={{
              height: '100%',
              background: '#F71D25',
              transformOrigin: 'left',
              animation: hovering
                ? 'none'
                : `progress-fill ${CYCLE_MS}ms linear forwards`,
            }}
          />
        </div>
      </div>

      {/* ═══════ ACCENT IMAGE STRIP ═══════ */}
      <div
        className="flex-shrink-0 flex gap-1.5 px-4"
        style={{ paddingTop: 10, paddingBottom: 6 }}
      >
        <div
          className="flex-1 rounded-md overflow-hidden relative group cursor-pointer"
          style={{ height: 36 }}
        >
          <img
            src="./218a2f8bee2329a6759b75c06e32bcb2.jpg"
            alt="Expérience premium Air France"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
            style={{ opacity: 0.6 }}
            draggable={false}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(to top, rgba(0,33,87,0.55) 0%, rgba(0,33,87,0) 100%)',
            }}
          />
          <span
            className="absolute bottom-1 left-1.5 z-10"
            style={{
              fontFamily: fFru,
              fontWeight: 600,
              fontSize: 7,
              color: '#E0E0E0',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Classe Affaires
          </span>
        </div>
        <div
          className="flex-1 rounded-md overflow-hidden relative group cursor-pointer"
          style={{ height: 36 }}
        >
          <img
            src="./94f9bd7a2c6c23bdac2a0eb93326de98.jpg"
            alt="Destination de rêve Air France"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
            style={{ opacity: 0.6 }}
            draggable={false}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(to top, rgba(0,33,87,0.55) 0%, rgba(0,33,87,0) 100%)',
            }}
          />
          <span
            className="absolute bottom-1 left-1.5 z-10"
            style={{
              fontFamily: fFru,
              fontWeight: 600,
              fontSize: 7,
              color: '#E0E0E0',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            La Première
          </span>
        </div>
      </div>

      {/* ═══════ DESTINATION TABS ═══════ */}
      <div
        className="flex-shrink-0 flex items-center justify-center gap-2 px-4"
        style={{ paddingTop: 2, paddingBottom: 6 }}
      >
        {destinations.map((d, i) => (
          <button
            key={i}
            onClick={() => pick(i)}
            className="cursor-pointer rounded-full transition-all duration-300"
            style={{
              fontFamily: fFru,
              fontWeight: 600,
              fontSize: 11,
              padding: '4px 12px',
              lineHeight: '16px',
              background:
                i === activeIdx
                  ? '#F71D25'
                  : 'rgba(255,255,255,0.06)',
              color:
                i === activeIdx
                  ? '#FFFFFF'
                  : '#E0E0E0',
              border:
                i === activeIdx
                  ? '1px solid #F71D25'
                  : '1px solid rgba(255,255,255,0.1)',
              transform: i === activeIdx ? 'scale(1.08)' : 'scale(1)',
            }}
          >
            {d.city}
          </button>
        ))}
      </div>

      {/* ═══════ PRICE SECTION ═══════ */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <p
          style={{
            fontFamily: fFru,
            fontWeight: 300,
            fontSize: 12,
            color: '#CCE5FF',
            margin: 0,
          }}
        >
          Aller-retour à partir de
        </p>

        <div className="flex items-baseline gap-2" style={{ marginTop: 4 }}>
          <span
            className="line-through"
            style={{
              fontFamily: fFru,
              fontWeight: 400,
              fontSize: 15,
              color: '#E0E0E0',
              opacity: 0.4,
            }}
          >
            {cur.oldPrice}€
          </span>
          <span
            className="animate-subtle-float"
            style={{
              fontFamily: fNeo,
              fontWeight: 700,
              fontSize: 42,
              color: '#FFFFFF',
              lineHeight: 1,
              letterSpacing: '-0.02em',
            }}
          >
            {displayPrice}€
          </span>
          <span
            key={`b-${activeIdx}`}
            className="badge badge-sm animate-badge-pop"
            style={{
              background: '#F71D25',
              color: '#FFFFFF',
              border: 'none',
              fontFamily: fFru,
              fontWeight: 600,
              fontSize: 11,
              padding: '2px 7px',
            }}
          >
            -{cur.discount}%
          </span>
        </div>

        <p
          style={{
            fontFamily: fFru,
            fontWeight: 300,
            fontSize: 10,
            color: '#CCE5FF',
            opacity: 0.5,
            marginTop: 3,
          }}
        >
          Taxes et frais inclus
        </p>
      </div>

      {/* ═══════ CTA ═══════ */}
      <div className="flex-shrink-0 px-5" style={{ paddingBottom: 8 }}>
        <button
          className="btn btn-block btn-sm rounded-full border-none cta-glow transition-all duration-300"
          style={{
            background: ctaHover ? '#931116' : '#F71D25',
            color: '#FFFFFF',
            fontFamily: fFru,
            fontWeight: 600,
            fontSize: 14,
            letterSpacing: '0.02em',
            height: 40,
            minHeight: 40,
            transform: ctaHover ? 'scale(1.04)' : 'scale(1)',
          }}
          onMouseEnter={() => setCtaHover(true)}
          onMouseLeave={() => setCtaHover(false)}
        >
          Réserver maintenant ✈
        </button>
      </div>

      {/* ═══════ FINE PRINT ═══════ */}
      <div className="flex-shrink-0 text-center" style={{ paddingBottom: 10 }}>
        <p
          style={{
            fontFamily: fFru,
            fontWeight: 300,
            fontSize: 9,
            color: '#E0E0E0',
            opacity: 0.35,
            margin: 0,
          }}
        >
          Offre soumise à conditions · Flying Blue
        </p>
      </div>
    </div>
  );
}