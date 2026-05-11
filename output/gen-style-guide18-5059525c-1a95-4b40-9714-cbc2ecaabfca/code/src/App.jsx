import { useState, useRef, useEffect, useCallback } from 'preact/hooks'
import './App.css'

const SLIDES = [
  {
    img: './2026-dodge-charger-gas-powered-sixpack-arrives-later-this-year-4.jpg',
    name: 'Dodge Charger Sixpack',
    tag: 'Puissance brute. Style absolu.'
  },
  {
    img: './2026-dodge-charger-gas-powered-sixpack-arrives-later-this-year-5.jpg',
    name: 'Dodge Charger',
    tag: "L'audace redéfinie."
  },
  {
    img: './2026-dodge-charger-gas-powered-sixpack-arrives-later-this-year-7.jpg',
    name: 'Dodge Charger',
    tag: 'Performances. Émotions.'
  },
  {
    img: './the-2026-jeep-grand-cherokee-is-here-with-stellantis-newest-engine.jpg',
    name: 'Jeep Grand Cherokee',
    tag: "L'aventure commence ici."
  }
]

export function App() {
  const [showIntro, setShowIntro] = useState(true)
  const [current, setCurrent] = useState(0)
  const [tiltX, setTiltX] = useState(0)
  const [tiltY, setTiltY] = useState(0)
  const canvasRef = useRef(null)
  const touchXRef = useRef(null)
  const autoRef = useRef(null)

  /* ---- Intro timeout ---- */
  useEffect(() => {
    const id = setTimeout(() => setShowIntro(false), 2800)
    return () => clearTimeout(id)
  }, [])

  /* ---- Starfield ---- */
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    c.width = 320 * dpr
    c.height = 480 * dpr
    ctx.scale(dpr, dpr)

    const stars = []
    for (let i = 0; i < 50; i++) {
      stars.push({
        x: Math.random() * 320,
        y: Math.random() * 480,
        r: Math.random() * 1.3 + 0.2,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.014 + 0.003
      })
    }

    let frame = 0
    let rafId
    const draw = () => {
      frame++
      ctx.clearRect(0, 0, 320, 480)
      for (const s of stars) {
        const alpha = 0.12 + 0.42 * Math.sin(frame * s.speed + s.phase)
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(160,212,205,${alpha})`
        ctx.fill()
      }
      rafId = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(rafId)
  }, [])

  /* ---- Auto-advance ---- */
  const startAuto = useCallback(() => {
    clearInterval(autoRef.current)
    autoRef.current = setInterval(() => {
      setCurrent(c => (c + 1) % SLIDES.length)
    }, 3800)
  }, [])

  useEffect(() => {
    if (showIntro) return
    startAuto()
    return () => clearInterval(autoRef.current)
  }, [showIntro, startAuto])

  const resetAuto = () => startAuto()

  /* ---- Touch swipe ---- */
  const handleTouchStart = (e) => {
    touchXRef.current = e.touches[0].clientX
  }
  const handleTouchEnd = (e) => {
    if (touchXRef.current === null) return
    const diff = e.changedTouches[0].clientX - touchXRef.current
    if (Math.abs(diff) > 30) {
      setCurrent(c => {
        if (diff < 0) return Math.min(c + 1, SLIDES.length - 1)
        return Math.max(c - 1, 0)
      })
      resetAuto()
    }
    touchXRef.current = null
    setTiltX(0)
    setTiltY(0)
  }

  /* ---- Mouse tilt ---- */
  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const nx = (e.clientX - rect.left) / rect.width - 0.5
    const ny = (e.clientY - rect.top) / rect.height - 0.5
    setTiltX(ny * -8)
    setTiltY(nx * 8)
  }
  const handleMouseLeave = () => {
    setTiltX(0)
    setTiltY(0)
  }

  const slide = SLIDES[current]

  return (
    <div class="ad" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <canvas ref={canvasRef} class="stars" />

      {/* ===== INTRO ===== */}
      <div class={`intro ${showIntro ? 'vis' : 'hid'}`}>
        <img src="./stellantis.png" alt="Stellantis" class="intro-brand" />
        <p class="intro-text">LA NOUVELLE VAGUE</p>
        <p class="intro-year">2026</p>
      </div>

      {/* ===== MAIN ===== */}
      <div class={`main ${!showIntro ? 'vis' : 'hid'}`}>
        <header class="hd">
          <img src="./Stellantis-Logo.png" alt="Stellantis" class="hd-logo" />
          <span class="hd-badge">2026</span>
        </header>

        <div class="headline">
          <span class="hl-sub">LA NOUVELLE</span>
          <span class="hl-main">VAGUE</span>
        </div>

        <div class="carousel" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
          <div class="carousel-glow" />
          {SLIDES.map((item, i) => {
            const active = i === current
            return (
              <div
                key={i}
                class="card"
                style={{
                  transform: active
                    ? `perspective(600px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`
                    : `translateX(${(i - current) * 340}px) scale(0.85)`,
                  opacity: active ? 1 : 0,
                  zIndex: active ? 2 : 0
                }}
              >
                <img src={item.img} alt={item.name} />
                <div class="card-ov" />
              </div>
            )
          })}
        </div>

        <div class="vinfo" key={`vi-${current}`}>
          <p class="vinfo-name">{slide.name}</p>
          <p class="vinfo-tag">{slide.tag}</p>
        </div>

        <div class="dots">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              class={`dot ${i === current ? 'act' : ''}`}
              onClick={() => { setCurrent(i); resetAuto() }}
              aria-label={`Diapo ${i + 1}`}
            />
          ))}
        </div>

        <p class="swh">\u2190 GLISSEZ \u2192</p>

        <a
          href="https://www.stellantis.com"
          target="_blank"
          rel="noopener noreferrer"
          class="cta"
        >
          DÉCOUVRIR
        </a>

        <footer class="ft">
          <img src="./STLA_BIG-b23f3d7e.png" alt="STLA" class="ft-logo" />
        </footer>
      </div>
    </div>
  )
}