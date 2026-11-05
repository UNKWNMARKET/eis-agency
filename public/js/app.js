import { h, clear, get, post, meta } from './lib.js';
import { dashboard } from './views/dashboard.js';
import { clientsList, clientDetail } from './views/clients.js';
import { policiesList, policyDetail } from './views/policies.js';
import { renewals } from './views/renewals.js';
import { pipeline } from './views/pipeline.js';
import { claimsList, claimDetail } from './views/claims.js';
import { billing } from './views/billing.js';
import { commissions } from './views/commissions.js';
import { tasksView, certificatesView } from './views/work.js';
import { reports } from './views/reports.js';
import { carriers, settings } from './views/admin.js';

const app = document.getElementById('app');
const logo = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M16 6l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V9z');
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'white'); p.setAttribute('stroke-width', '2.4'); p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return h('div', { class: 'logo' }, svg);
};

const NAV = [
  ['/dashboard', '▦', 'Dashboard'],
  ['/clients', '☺', 'Clients'],
  ['/policies', '▤', 'Policies'],
  ['/renewals', '↻', 'Renewals'],
  ['/pipeline', '◆', 'Pipeline'],
  ['/claims', '⚑', 'Claims'],
  ['sep'],
  ['/billing', '$', 'Billing'],
  ['/commissions', '%', 'Commissions', ['admin', 'manager', 'accounting']],
  ['/tasks', '✓', 'Tasks'],
  ['/certificates', '✉', 'Certificates'],
  ['sep'],
  ['/reports', '≣', 'Reports'],
  ['/carriers', '⌂', 'Carriers'],
  ['/settings', '⚙', 'Settings'],
];

const ROUTES = [
  [/^\/dashboard$/, dashboard], [/^\/clients$/, clientsList], [/^\/clients\/(\d+)$/, clientDetail],
  [/^\/policies$/, policiesList], [/^\/policies\/(\d+)$/, policyDetail], [/^\/renewals$/, renewals], [/^\/pipeline$/, pipeline],
  [/^\/claims$/, claimsList], [/^\/claims\/(\d+)$/, claimDetail], [/^\/billing$/, billing], [/^\/commissions$/, commissions],
  [/^\/tasks$/, tasksView], [/^\/certificates$/, certificatesView], [/^\/reports(?:\/([a-z_]+))?$/, reports],
  [/^\/carriers$/, carriers], [/^\/settings(?:\/([a-z_]+))?$/, settings],
];

/* ---------- Login ---------- */
function showLogin(message) {
  window.__user = null;
  const err = h('div', { class: 'form-banner', hidden: !message, role: 'alert' }, message);
  const email = h('input', { type: 'email', id: 'login_email', required: true, autocomplete: 'username', autofocus: true });
  const pass = h('input', { type: 'password', id: 'login_pw', required: true, autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit', style: { justifyContent: 'center' } }, 'Sign in');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.hidden = true;
    try {
      await post('/api/auth/login', { email: email.value, password: pass.value });
      await boot();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
  } }, err,
  h('div', { class: 'field' }, h('label', { for: 'login_email' }, 'Email'), email),
  h('div', { class: 'field' }, h('label', { for: 'login_pw' }, 'Password'), pass), btn);
  clear(app).append(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'brand', style: { padding: 0 } }, logo(), h('span', null, 'Agency Management')),
    h('h1', null, 'Sign in'), h('div', { class: 'muted' }, 'Use your agency account to continue.'), form)));
}

/* ---------- Shell ---------- */
let contentEl;
function renderShell() {
  const user = window.__user;
  const links = NAV.filter((n) => n[0] === 'sep' || !n[3] || n[3].includes(user.role)).map((n) =>
    n[0] === 'sep' ? h('div', { class: 'sep' }) : h('a', { href: '#' + n[0], dataset: { path: n[0] } }, h('span', { class: 'ico' }, n[1]), n[2]));
  const side = h('aside', { class: 'side', id: 'side' },
    h('div', { class: 'brand' }, logo(), h('span', null, meta.value.agency.agency_name || 'Agency')),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, links),
    h('div', { class: 'me' }, h('div', null, h('strong', null, user.name)), h('div', { class: 'muted' }, user.role),
      h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: async () => { await post('/api/auth/logout').catch(() => {}); showLogin(); } }, 'Sign out')));
  contentEl = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  const shell = h('div', { class: 'shell' }, side,
    h('div', { class: 'main' },
      h('div', { class: 'topbar' },
        h('button', { class: 'btn menu-btn', 'aria-label': 'Menu', onclick: () => side.classList.toggle('open') }, '☰'), globalSearch(),
        h('button', { class: 'btn btn-primary', onclick: () => { location.hash = '#/clients?new=1'; } }, '+ New client')),
      contentEl));
  clear(app).append(shell);
  side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('open'); });
}

function globalSearch() {
  const input = h('input', { type: 'search', placeholder: 'Search clients, policy numbers, claims…  ( / )', 'aria-label': 'Global search', autocomplete: 'off' });
  const results = h('div', { class: 'search-results', hidden: true });
  let timer, seq = 0;
  const HREF = { client: '/clients/', policy: '/policies/', claim: '/claims/', opportunity: '/pipeline?opp=' };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await get('/api/search', { q });
        if (my !== seq) return;
        clear(results);
        if (!r.results.length) results.append(h('div', { class: 'empty' }, 'No results'));
        for (const x of r.results) results.append(h('a', { href: '#' + HREF[x.type] + x.id, onclick: () => { results.hidden = true; input.value = ''; } },
          h('span', { class: 't' }, x.type), h('span', null, h('strong', null, x.title), x.subtitle ? h('span', { class: 'muted' }, '  ' + x.subtitle) : null)));
        results.hidden = false;
      } catch { /* ignore */ }
    }, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { results.hidden = true; input.blur(); }
    if (e.key === 'Enter') results.querySelector('a')?.click();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); input.focus(); }
  });
  return h('div', { class: 'search' }, input, results);
}

/* ---------- Router ---------- */
let navSeq = 0;
async function route() {
  if (!window.__user) return;
  const raw = location.hash.slice(1) || '/dashboard';
  const [path, queryStr] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryStr || ''));
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', path === a.dataset.path || path.startsWith(a.dataset.path + '/')));
  const hit = ROUTES.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
  const my = ++navSeq;
  clear(contentEl).append(h('div', { class: 'empty' }, 'Loading…'));
  if (!hit) { clear(contentEl).append(h('div', { class: 'empty' }, 'Page not found.')); return; }
  try {
    const node = await hit[1](...hit[0].slice(1), query);
    if (my !== navSeq) return;
    clear(contentEl).append(node);
    document.title = (node.dataset?.title ? node.dataset.title + ' · ' : '') + (meta.value.agency.agency_name || 'AMS');
    window.scrollTo(0, 0);
  } catch (e) {
    if (my !== navSeq) return;
    clear(contentEl).append(h('div', { class: 'card' }, h('div', { class: 'empty neg' }, e.message)));
  }
}

async function boot() {
  const { user } = await get('/api/auth/me');
  if (!user) return showLogin();
  window.__user = user;
  meta.value = await get('/api/meta');
  renderShell();
  if (!location.hash) location.hash = '#/dashboard';
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('ams:refresh', route);
window.addEventListener('ams:unauth', () => { if (window.__user) showLogin('Your session has expired. Please sign in again.'); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });
boot().catch((e) => { clear(app).append(h('div', { class: 'login' }, h('div', { class: 'card' }, h('h1', null, 'Unable to load'), h('p', { class: 'muted' }, e.message)))); });
