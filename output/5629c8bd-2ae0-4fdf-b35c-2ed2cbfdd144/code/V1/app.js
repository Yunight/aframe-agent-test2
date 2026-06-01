// Check for prefers-reduced-motion
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===== 320x480 Carousel Logic =====
const carousel320x480 = (() => {
  const wrapper = document.querySelector('.ad-320x480 .product-carousel-wrapper');
  if (!wrapper) return;
  
  const images = document.querySelectorAll('.ad-320x480 .carousel-image');
  const dots = document.querySelectorAll('.ad-320x480 .carousel-dot');
  const statusElement = document.querySelector('.ad-320x480 .carousel-status');
  
  let currentIndex = 0;
  let autoRotateInterval = null;
  
  const showImage = (index) => {
    // Remove active class from all images
    images.forEach(img => img.classList.remove('carousel-image-active'));
    // Add active class to current image
    images[index].classList.add('carousel-image-active');
    
    // Update dots
    dots.forEach((dot, i) => {
      if (i === index) {
        dot.classList.add('active');
        dot.setAttribute('aria-current', 'true');
      } else {
        dot.classList.remove('active');
        dot.setAttribute('aria-current', 'false');
      }
    });
    
    // Announce to screen readers
    statusElement.textContent = `Produit ${index + 1} de ${images.length}: ${images[index].alt}`;
  };
  
  const nextImage = () => {
    currentIndex = (currentIndex + 1) % images.length;
    showImage(currentIndex);
  };
  
  const startAutoRotate = () => {
    if (prefersReducedMotion) return;
    autoRotateInterval = setInterval(nextImage, 3000);
  };
  
  const stopAutoRotate = () => {
    clearInterval(autoRotateInterval);
  };
  
  const resetAutoRotate = () => {
    stopAutoRotate();
    startAutoRotate();
  };
  
  // Dot click handlers
  dots.forEach((dot, index) => {
    dot.addEventListener('click', () => {
      currentIndex = index;
      showImage(currentIndex);
      resetAutoRotate();
    });
    
    dot.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        currentIndex = (currentIndex + 1) % images.length;
        showImage(currentIndex);
        resetAutoRotate();
        dots[currentIndex].focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        currentIndex = (currentIndex - 1 + images.length) % images.length;
        showImage(currentIndex);
        resetAutoRotate();
        dots[currentIndex].focus();
      }
    });
  });
  
  // Pause on hover/focus, resume on leave
  wrapper.addEventListener('mouseenter', stopAutoRotate);
  wrapper.addEventListener('mouseleave', startAutoRotate);
  wrapper.addEventListener('focusin', stopAutoRotate);
  wrapper.addEventListener('focusout', startAutoRotate);
  
  // Initialize
  showImage(0);
  startAutoRotate();
})();

// ===== 300x600 Color Swatch Logic =====
const colorSwatches = (() => {
  const swatches = document.querySelectorAll('.ad-300x600 .swatch');
  const heroProduct = document.getElementById('hero-product');
  
  if (!swatches.length || !heroProduct) return;
  
  const announceElement = document.createElement('div');
  announceElement.setAttribute('role', 'status');
  announceElement.setAttribute('aria-live', 'polite');
  announceElement.setAttribute('aria-atomic', 'true');
  announceElement.style.position = 'absolute';
  announceElement.style.left = '-10000px';
  document.body.appendChild(announceElement);
  
  swatches.forEach((swatch) => {
    swatch.addEventListener('click', () => {
      const newImage = swatch.getAttribute('data-image');
      const colorName = swatch.getAttribute('data-color');
      
      // Update hero image with fade effect
      if (!prefersReducedMotion) {
        heroProduct.style.opacity = '0';
        setTimeout(() => {
          heroProduct.src = newImage;
          heroProduct.style.opacity = '1';
        }, 200);
      } else {
        heroProduct.src = newImage;
      }
      
      // Update swatch selection state
      swatches.forEach(s => {
        s.setAttribute('aria-checked', 'false');
      });
      swatch.setAttribute('aria-checked', 'true');
      
      // Announce to screen readers
      announceElement.textContent = `Variante ${colorName} sélectionnée`;
    });
    
    swatch.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        swatch.click();
      }
    });
  });
})();

// ===== Accessibility Enhancements =====
document.addEventListener('DOMContentLoaded', () => {
  // Ensure all interactive elements are reachable via keyboard
  const interactiveElements = document.querySelectorAll('button, a, [role="radio"]');
  interactiveElements.forEach((el) => {
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
    }
  });
});