// ============================================================================
// VAACT Vérif — Logique applicative
// ----------------------------------------------------------------------------
// Outil de consultation de traductions Yu-Gi-Oh! (lecture seule).
//
// Flux global :
//   1. loadCardInfo()    → fetch cardinfo_fr.txt, remplit ATTRIBUTES/TYPES/RACES
//   2. loadCards()       → fetch les 2 .cdb, extrait, fusionne → CARDS[]
//   3. render()          → affiche la carte courante dans le DOM
//   4. événements        → navigation, filtres, recherche, thème
//
// Dépendances : sql.js 1.10.3 (CDN), YGOPRODeck API (images).
//
// Organisation :
//   1. Config              — URLs, constantes globales
//   2. État                — CARDS, currentIndex, filtres
//   3. Codes YGOPRO        — chargés depuis cardinfo_fr.txt
//   4. Tags auto [XXX]     — extraction + rendu coloré
//   5. Filtres             — état + application
//   6. Toast               — messages éphémères
//   7. Images              — fetch YGOPRODeck + cache
//   8. Chargement          — cardinfo + SQLite + fusion + init
//   9. Extraction          — SQL → objet carte
//  10. Fusion              — merge EN/FR + détection orphelines
//  11. Rendu               — affichage de la carte courante
//  12. Navigation          — prev/next/random
//  13. Panneau filtres     — open/close + checkboxes
//  14. Filtres personnalisés — chips de mots-clés
//  15. Recherche           — jump to match
//  16. Utilitaires         — esc, resize, hauteur topbar
//  17. Thème               — clair/sombre
//  18. Init                — bootstrap
// ============================================================================

// ============================================================================
// 1. CONFIG
// ============================================================================
const CDB_EN_URL = 'https://raw.githubusercontent.com/Mazorn/VAACT-Very-Accurate-Anime-Character-Tournament-/main/VAACT%20S1.cdb';
const CDB_FR_URL = 'https://raw.githubusercontent.com/kevinraphael95/VAACT-patch-fr/main/VAACT%20S1.cdb';
const CARDINFO_URL = 'cardinfo_fr.txt';

const IMAGE_FETCH_TIMEOUT_MS = 8000;

// ============================================================================
// 2. ÉTAT GLOBAL
// ============================================================================
let CARDS = [];
let currentIndex = 0;
let customKeywords = [];
const CUSTOM_KEYWORDS_LS = 'vaact-custom-keywords';

(function restoreCustomKeywords() {
  try {
    const saved = localStorage.getItem(CUSTOM_KEYWORDS_LS);
    if (saved) customKeywords = JSON.parse(saved);
    if (!Array.isArray(customKeywords)) customKeywords = [];
  } catch (e) {
    customKeywords = [];
  }
})();

function saveCustomKeywords() {
  try {
    localStorage.setItem(CUSTOM_KEYWORDS_LS, JSON.stringify(customKeywords));
  } catch (e) {}
}

// ============================================================================
// 3. TRADUCTION DES CODES YGOPRO (chargée depuis cardinfo_fr.txt)
// ============================================================================
// Les tables ATTRIBUTES / TYPES / RACES sont remplies dynamiquement au
// démarrage par loadCardInfo(). Ça évite les bugs de valeurs en dur (comme
// le décalage Xyz/Pendule/Lien qu'on avait avant) et permet de mettre à jour
// les libellés sans toucher au code.

let ATTRIBUTES = {};
let TYPES = [];
let RACES = {};

async function loadCardInfo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cardinfo introuvable : ${url} (HTTP ${res.status})`);
  const text = await res.text();

  const lines = text.split(/\r?\n/);
  let section = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');   // trim end seulement
    if (!line) continue;

    if (line.startsWith('##')) {
      section = line.slice(2).trim().toLowerCase();
      continue;
    }
    if (line.startsWith('#end')) break;
    if (line.startsWith('#')) continue;

    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const hexPart = line.slice(0, tabIdx).trim();
    const label = line.slice(tabIdx + 1).trim();

    let value;
    if (hexPart.startsWith('-')) {
      value = parseInt(hexPart, 10);
    } else {
      value = parseInt(hexPart, 16);
    }
    if (isNaN(value)) continue;

    if (section === 'attribute') {
      ATTRIBUTES[value] = label;
    } else if (section === 'type') {
      TYPES.push({ v: value, label });
    } else if (section === 'race') {
      RACES[value] = label;
    }
    // Les autres sections (rule, level, link marker, category, setname)
    // ne sont pas utilisées par le Vérif pour l'instant.
  }

  console.log(`✅ cardinfo chargé : ${Object.keys(ATTRIBUTES).length} attributs, ` +
              `${TYPES.length} types, ${Object.keys(RACES).length} races`);
}

function attributeToString(attr) {
  if (!attr) return '—';
  return ATTRIBUTES[attr] || `Attr${attr}`;
}

function typeToString(type) {
  if (!type) return '—';
  const parts = [];
  for (const t of TYPES) {
    if (type & t.v) parts.push(t.label);
  }
  return parts.length ? parts.join(' / ') : `Type ${type}`;
}

function raceToString(race) {
  if (!race) return '—';
  return RACES[race] || `Race${race}`;
}

function formatStat(value) {
  if (value === null || value === undefined) return '—';
  if (value === -2 || value === -1) return '?';
  if (value < 0) return '0';
  return String(value);
}

// ============================================================================
// 4. TAGS AUTO — détection et rendu des [XXX]
// ============================================================================
function extractTags(descFr) {
  if (!descFr) return [];
  const matches = descFr.match(/\[([A-Z0-9_-]+)\]/gi);
  if (!matches) return [];
  const seen = new Set();
  const tags = [];
  for (const m of matches) {
    const tag = m.slice(1, -1).toUpperCase();
    if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
  }
  return tags;
}

function tagHue(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}

function renderTagsHtml(descFr) {
  const tags = extractTags(descFr);
  if (!tags.length) return '';
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return tags.map(tag => {
    const h = tagHue(tag);
    const bg = isDark ? `hsla(${h}, 60%, 40%, 0.18)` : `hsl(${h}, 70%, 92%)`;
    const fg = isDark ? `hsl(${h}, 70%, 70%)` : `hsl(${h}, 65%, 32%)`;
    return `<span class="tag-badge" style="background:${bg};color:${fg}">[${esc(tag)}]</span>`;
  }).join('');
}

// ============================================================================
// 5. FILTRES
// ============================================================================
function isVaactCard(card) {
  return extractTags(card.desc_fr).includes('VAACT');
}

function isIncompleteCard(card) {
  return card.missingFr === true || card.missingEn === true;
}

function getFilterState() {
  return {
    vaact: !!document.getElementById('filterVaact')?.checked,
    incomplete: !!document.getElementById('filterIncomplete')?.checked,
    keywords: customKeywords,
  };
}

function countActiveFilters() {
  const { vaact, incomplete, keywords } = getFilterState();
  return (vaact ? 1 : 0) + (incomplete ? 1 : 0) + keywords.length;
}

function getFilteredCards() {
  let list = CARDS;
  const { vaact, incomplete, keywords } = getFilterState();

  if (vaact) list = list.filter(isVaactCard);
  if (incomplete) list = list.filter(isIncompleteCard);

  if (keywords.length) {
    list = list.filter(c => {
      const haystack = [
        (c.name_en || '').toLowerCase(),
        (c.name_fr || '').toLowerCase(),
        (c.id || ''),
      ].join(' ');
      return keywords.every(kw => haystack.includes(kw));
    });
  }

  return list;
}

function updateFiltersBadge() {
  const btn = document.getElementById('filtersBtn');
  if (!btn) return;

  const count = countActiveFilters();
  btn.classList.toggle('active', count > 0);

  const badge = btn.querySelector('.badge-count');
  if (badge) {
    if (count > 0) {
      badge.textContent = String(count);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ============================================================================
// 6. TOAST — message éphémère
// ============================================================================
let toastTimer;

function showToast(message) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// ============================================================================
// 7. IMAGES — Recherche locale et affichage
// ============================================================================
const imageCache = {};

async function fetchCardImage(card) {
  if (!card || !card.id) return null;
  const key = String(card.id).trim();

  if (imageCache[key] !== undefined) return imageCache[key];

  if (window.memCacheEn && window.memCacheEn.has(key)) {
    const cachedCard = window.memCacheEn.get(key);
    const localImg = cachedCard?.card_images?.[0]?.image_url_cropped 
                  || cachedCard?.card_images?.[0]?.image_url 
                  || null;
    if (localImg) {
      imageCache[key] = localImg;
      return localImg;
    }
  }

  if (window.yugiCache) {
    const normName = (card.name_en || card.name_fr || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normName && window.yugiCache.has(normName)) {
      const yugiCard = window.yugiCache.get(normName);
      const yugiImg = yugiCard.img || yugiCard.img_en || null;
      if (yugiImg) {
        imageCache[key] = yugiImg;
        return yugiImg;
      }
    }
  }

  imageCache[key] = null;
  return null;
}

function ensurePlaceholder(parent) {
  let ph = parent.querySelector('.img-placeholder');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'img-placeholder';
    ph.textContent = '🃏';
    parent.style.position = 'relative';
    parent.appendChild(ph);
  }
  return ph;
}

async function loadCardImage(card) {
  const imgEl = document.getElementById('cardImg');
  if (!imgEl) return;

  imgEl.onload = null;
  imgEl.onerror = null;
  imgEl.removeAttribute('src');
  imgEl.style.display = 'none';
  imgEl.alt = card?.name_fr || card?.name_en || 'Carte';

  const parent = imgEl.parentElement;
  ensurePlaceholder(parent);

  const url = await fetchCardImage(card);

  if (getFilteredCards()[currentIndex] !== card) return;
  if (!url) return;

  imgEl.onload = () => {
    const ph = parent.querySelector('.img-placeholder');
    if (ph) ph.remove();
    imgEl.style.display = 'block';
  };
  imgEl.onerror = () => {
    imgEl.removeAttribute('src');
    imgEl.style.display = 'none';
  };
  imgEl.src = url;
}

// ============================================================================
// 8. CHARGEMENT — cardinfo + SQLite + fusion
// ============================================================================
async function fetchBuffer(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} introuvable (HTTP ${res.status}) — URL testée : ${url}`);
  }
  const buf = await res.arrayBuffer();

  const header = new TextDecoder().decode(buf.slice(0, 16));
  if (!header.startsWith('SQLite format 3')) {
    throw new Error(
      `${label} n'est pas un fichier SQLite valide — ` +
      `l'URL renvoie probablement une page HTML 404. ` +
      `Vérifie que le fichier existe bien à : ${url}`
    );
  }
  return buf;
}

async function loadCards() {
  const loadingText = document.getElementById('loadingText');

  try {
    loadingText.textContent = 'Chargement du cardinfo…';
    await loadCardInfo(CARDINFO_URL);

    loadingText.textContent = 'Initialisation de SQLite…';
    const SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`,
    });

    loadingText.textContent = 'Chargement du cdb original (EN)…';
    const enBuffer = await fetchBuffer(CDB_EN_URL, 'Fichier EN');
    const enDb = new SQL.Database(new Uint8Array(enBuffer));

    loadingText.textContent = 'Chargement du cdb traduit (FR)…';
    const frBuffer = await fetchBuffer(CDB_FR_URL, 'Fichier FR');
    const frDb = new SQL.Database(new Uint8Array(frBuffer));

    loadingText.textContent = 'Extraction des cartes…';
    const enCards = extractCards(enDb);
    const frCards = extractCards(frDb);

    enDb.close();
    frDb.close();

    loadingText.textContent = 'Fusion des traductions…';
    CARDS = mergeCards(enCards, frCards);

    const missingFr = CARDS.filter(c => c.missingFr).length;
    const missingEn = CARDS.filter(c => c.missingEn).length;
    console.log(`✅ ${CARDS.length} cartes chargées`);
    console.log(`   • ${missingFr} sans traduction FR`);
    console.log(`   • ${missingEn} sans original EN`);

    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('mainContainer').style.display = 'block';
    document.getElementById('navBar').style.display = 'block';
    document.body.classList.add('has-nav');

    updateTopbarHeight();
    renderCustomChips();
    updateFiltersBadge();
    render();

  } catch (err) {
    console.error('❌ Erreur:', err);
    loadingText.textContent = `❌ Erreur : ${err.message}`;
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:12px;font-size:12px;opacity:.75;';
    hint.textContent = 'Vérifie que les fichiers .cdb sont bien accessibles.';
    loadingText.appendChild(hint);
  }
}

// ============================================================================
// 9. EXTRACTION — SQL → objet carte
// ============================================================================
function extractCards(db) {
  const textsResult = db.exec("SELECT id, name, desc FROM texts")[0];
  if (!textsResult) return {};

  const texts = textsResult.values;

  let datasResult;
  try {
    datasResult = db.exec("SELECT id, type, atk, def, level, race, attribute FROM datas")[0];
  } catch (e) {
    datasResult = null;
  }

  const datasById = {};
  if (datasResult) {
    for (const row of datasResult.values) {
      datasById[String(row[0])] = {
        type: row[1],
        atk: row[2],
        def: row[3],
        level: row[4],
        race: row[5],
        attribute: row[6],
      };
    }
  }

  const cards = {};
  for (const [id, name, desc] of texts) {
    const idStr = String(id);
    cards[idStr] = {
      id: idStr,
      name: name || '',
      desc: desc || '',
      ...(datasById[idStr] || {}),
    };
  }
  return cards;
}

// ============================================================================
// 10. FUSION — merge EN/FR + détection orphelines
// ============================================================================
function mergeCards(enCards, frCards) {
  const result = [];
  const enOnly = [];
  const frOnly = [];

  for (const id in enCards) {
    const en = enCards[id];
    const fr = frCards[id];

    if (!fr) {
      enOnly.push({ id, name: en.name });
      result.push({
        id: en.id,
        name_en: en.name,
        desc_en: en.desc,
        name_fr: '',
        desc_fr: '',
        type: en.type || '',
        atk: en.atk ?? null,
        def: en.def ?? null,
        level: en.level ?? null,
        attribute: en.attribute || '',
        race: en.race ?? null,
        missingFr: true,
      });
      continue;
    }

    result.push({
      id: en.id,
      name_en: en.name,
      desc_en: en.desc,
      name_fr: fr.name,
      desc_fr: fr.desc,
      type: en.type || fr.type || '',
      atk: en.atk ?? null,
      def: en.def ?? null,
      level: en.level ?? null,
      attribute: en.attribute || '',
      race: en.race ?? null,
    });
  }

  for (const id in frCards) {
    if (enCards[id]) continue;
    const fr = frCards[id];
    frOnly.push({ id, name: fr.name });
    result.push({
      id: fr.id,
      name_en: '',
      desc_en: '',
      name_fr: fr.name,
      desc_fr: fr.desc,
      type: fr.type || '',
      atk: fr.atk ?? null,
      def: fr.def ?? null,
      level: fr.level ?? null,
      attribute: fr.attribute || '',
      race: fr.race ?? null,
      missingEn: true,
    });
  }

  if (enOnly.length) {
    console.warn(`⚠️ ${enOnly.length} carte(s) présente(s) en EN mais absente(s) en FR :`);
    console.table(enOnly);
  }
  if (frOnly.length) {
    console.warn(`⚠️ ${frOnly.length} carte(s) présente(s) en FR mais absente(s) en EN :`);
    console.table(frOnly);
  }
  if (!enOnly.length && !frOnly.length) {
    console.log('✅ Aucune carte orpheline — les deux fichiers sont synchronisés.');
  }

  result.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  return result;
}

// ============================================================================
// 11. RENDU — affichage de la carte courante
// ============================================================================
function render() {
  if (!CARDS.length) return;
  const filtered = getFilteredCards();

  if (!filtered.length) {
    document.getElementById('infoId').textContent = '—';
    document.getElementById('infoType').textContent = '—';
    document.getElementById('infoAttr').textContent = '—';
    document.getElementById('infoStats').textContent = '—';
    document.getElementById('infoLevel').textContent = '—';
    document.getElementById('origName').textContent = '—';
    document.getElementById('origDesc').textContent = 'Aucune carte ne correspond aux filtres actifs.';
    document.getElementById('translationSection').innerHTML = '';

    const imgEl = document.getElementById('cardImg');
    if (imgEl) {
      imgEl.onload = null;
      imgEl.onerror = null;
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
      ensurePlaceholder(imgEl.parentElement);
    }

    document.getElementById('navCenter').textContent = '0 / 0';
    document.getElementById('prevBtn').disabled = true;
    document.getElementById('nextBtn').disabled = true;
    return;
  }

  if (currentIndex >= filtered.length) currentIndex = 0;
  const card = filtered[currentIndex];

  loadCardImage(card);

  document.getElementById('infoId').textContent = card.id || '—';
  document.getElementById('infoType').textContent = typeToString(card.type);
  document.getElementById('infoAttr').textContent = attributeToString(card.attribute);
  document.getElementById('infoStats').textContent =
    formatStat(card.atk) + ' / ' + formatStat(card.def);
  document.getElementById('infoLevel').textContent = card.level ?? '—';

  document.getElementById('origName').textContent = card.name_en || '—';
  document.getElementById('origDesc').textContent = card.desc_en || '—';

  renderTranslation(card);

  document.getElementById('navCenter').textContent = `${currentIndex + 1} / ${filtered.length}`;
  document.getElementById('prevBtn').disabled = currentIndex === 0;
  document.getElementById('nextBtn').disabled = currentIndex === filtered.length - 1;
}

function renderTranslation(card) {
  const container = document.getElementById('translationSection');

  let missingBadge = '';
  if (card.missingFr) {
    missingBadge = `<span class="badge-source missing">⚠️ Traduction FR manquante</span>`;
  } else if (card.missingEn) {
    missingBadge = `<span class="badge-source missing">⚠️ Original EN manquant</span>`;
  }

  const frName = card.missingFr
    ? '<em style="opacity:.5;">— aucune traduction FR pour cette carte —</em>'
    : esc(card.name_fr || '—');
  const frDesc = card.missingFr
    ? '<em style="opacity:.5;">Cette carte existe dans le fichier EN mais n\'a pas de correspondance dans le fichier FR.</em>'
    : esc(card.desc_fr || '—');

  const tagsHtml = renderTagsHtml(card.desc_fr);

  container.innerHTML = `
    <div class="translation${card.missingFr || card.missingEn ? ' incomplete' : ''}">
      <div class="trans-head">
        <div class="trans-meta">
          <span class="badge-source manual">Traduction</span>
          ${tagsHtml}
          ${missingBadge}
        </div>
      </div>
      <div class="trans-name">${frName}</div>
      <div class="trans-desc">${frDesc}</div>
    </div>
  `;
}

// ============================================================================
// 12. NAVIGATION
// ============================================================================
function goPrev() {
  if (currentIndex > 0) { currentIndex--; render(); }
}
function goNext() {
  const filtered = getFilteredCards();
  if (currentIndex < filtered.length - 1) { currentIndex++; render(); }
}
function goRandom() {
  const filtered = getFilteredCards();
  if (!filtered.length) return;
  currentIndex = Math.floor(Math.random() * filtered.length);
  render();
}

document.getElementById('prevBtn').addEventListener('click', goPrev);
document.getElementById('nextBtn').addEventListener('click', goNext);
document.getElementById('randomBtn').addEventListener('click', goRandom);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') goPrev();
  else if (e.key === 'ArrowRight') goNext();
});

// ============================================================================
// 13. PANNEAU FILTRES
// ============================================================================
const filtersBtn = document.getElementById('filtersBtn');
const filtersPanel = document.getElementById('filtersPanel');

function openFiltersPanel() {
  if (!filtersPanel) return;
  filtersPanel.classList.add('open');
  filtersBtn?.setAttribute('aria-expanded', 'true');
}

function closeFiltersPanel(restoreFocus = false) {
  if (!filtersPanel) return;
  const wasOpen = filtersPanel.classList.contains('open');
  filtersPanel.classList.remove('open');
  filtersBtn?.setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) filtersBtn?.focus();
}

if (filtersBtn && filtersPanel) {
  filtersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (filtersPanel.classList.contains('open')) {
      closeFiltersPanel();
    } else {
      openFiltersPanel();
    }
  });

  document.addEventListener('click', (e) => {
    if (!filtersPanel.contains(e.target) && !filtersBtn.contains(e.target)) {
      closeFiltersPanel();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filtersPanel.classList.contains('open')) {
      closeFiltersPanel(true);
    }
  });
}

// ============================================================================
// 14. FILTRES — checkboxes + mots-clés personnalisés
// ============================================================================
['filterVaact', 'filterIncomplete'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => {
    currentIndex = 0;
    render();
    updateFiltersBadge();
  });
});

const customInput = document.getElementById('customKeywordInput');
const customAddBtn = document.getElementById('customAddBtn');
const customChips = document.getElementById('customChips');
const customResetBtn = document.getElementById('filterResetBtn');

function addCustomKeyword(rawValue) {
  const value = (rawValue || '').trim().toLowerCase();
  if (!value) return;
  if (customKeywords.includes(value)) return;

  customKeywords.push(value);
  saveCustomKeywords();
  renderCustomChips();
  currentIndex = 0;
  render();
  updateFiltersBadge();
}

function removeCustomKeyword(value) {
  const idx = customKeywords.indexOf(value);
  if (idx === -1) return;
  customKeywords.splice(idx, 1);
  saveCustomKeywords();
  renderCustomChips();
  currentIndex = 0;
  render();
  updateFiltersBadge();
}

function renderCustomChips() {
  if (!customChips) return;

  if (!customKeywords.length) {
    customChips.innerHTML = '';
    return;
  }

  customChips.innerHTML = customKeywords.map(kw => `
    <span class="custom-chip">
      <span class="chip-label">${esc(kw)}</span>
      <button type="button" class="chip-remove" data-keyword="${esc(kw)}" title="Retirer" aria-label="Retirer le filtre : ${esc(kw)}">✕</button>
    </span>
  `).join('');

  customChips.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCustomKeyword(btn.dataset.keyword);
    });
  });
}

if (customAddBtn && customInput) {
  customAddBtn.addEventListener('click', () => {
    addCustomKeyword(customInput.value);
    customInput.value = '';
    customInput.focus();
  });

  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustomKeyword(customInput.value);
      customInput.value = '';
    }
  });
}

if (customResetBtn) {
  customResetBtn.addEventListener('click', () => {
    const v = document.getElementById('filterVaact');
    const i = document.getElementById('filterIncomplete');
    if (v) v.checked = false;
    if (i) i.checked = false;

    customKeywords = [];
    saveCustomKeywords();
    renderCustomChips();

    currentIndex = 0;
    render();
    updateFiltersBadge();
  });
}

// ============================================================================
// 15. RECHERCHE
// ============================================================================
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');

function updateSearchIndicator() {
  if (!searchInput) return;
  const wrap = searchInput.closest('.search-wrap') || searchInput.parentElement;
  if (wrap) wrap.classList.toggle('has-search', searchInput.value.trim().length > 0);
}

function jumpToFirstMatch() {
  if (!searchInput) return;
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return;

  const filtered = getFilteredCards();
  const found = filtered.findIndex(c =>
    (c.name_en || '').toLowerCase().includes(q) ||
    (c.name_fr || '').toLowerCase().includes(q) ||
    (c.id || '').includes(q)
  );

  if (found >= 0) {
    currentIndex = found;
    render();
  } else {
    showToast(`Aucune carte ne correspond à « ${q} »`);
  }
}

if (searchInput) {
  searchInput.addEventListener('input', updateSearchIndicator);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToFirstMatch();
      searchInput.blur();
    } else if (e.key === 'Escape') {
      searchInput.value = '';
      updateSearchIndicator();
    }
  });
}

if (searchClear) {
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    updateSearchIndicator();
    searchInput.focus();
  });
}

// ============================================================================
// 16. UTILITAIRES
// ============================================================================
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function updateTopbarHeight() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  document.documentElement.style.setProperty('--topbar-height', topbar.offsetHeight + 'px');
}
window.addEventListener('resize', updateTopbarHeight);

// ============================================================================
// 17. THÈME
// ============================================================================
const THEME_KEY = 'vaact-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', isDark ? 'Basculer en thème clair' : 'Basculer en thème sombre');
  }
}

(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
})();

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);

  const filtered = getFilteredCards();
  const card = filtered[currentIndex];
  if (card) renderTranslation(card);
}

const themeBtn = document.getElementById('themeToggle');
if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

// ============================================================================
// 18. INIT
// ============================================================================
loadCards();
