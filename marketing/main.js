const root = document.documentElement;
const header = document.querySelector('[data-header]');
const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.main-nav');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

menuToggle?.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') === 'true';
  menuToggle.setAttribute('aria-expanded', String(!open));
  nav?.classList.toggle('is-open', !open);
  document.body.classList.toggle('menu-open', !open);
});

nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  menuToggle?.setAttribute('aria-expanded', 'false');
  nav.classList.remove('is-open');
  document.body.classList.remove('menu-open');
}));

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  });
}, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });

document.querySelectorAll('.reveal:not(.is-visible)').forEach(element => observer.observe(element));

let ticking = false;
function updateWorld() {
  const scroll = window.scrollY;
  root.style.setProperty('--scroll-y', `${scroll}px`);
  header?.classList.toggle('is-scrolled', scroll > 24);
  ticking = false;
}

if (!reducedMotion) {
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(updateWorld);
      ticking = true;
    }
  }, { passive: true });
}
updateWorld();
