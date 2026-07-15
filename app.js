/* ===================== NUMERA — app.js =====================
   Persistenza locale (localStorage) per ora.
   Struttura dati pronta per essere sostituita 1:1 da Firestore:
   - users, session -> Firebase Auth
   - db.*           -> collections Firestore per utente
================================================================ */

const ICON_COLORS = ['#30D158','#0A84FF','#FF9F0A','#FF453A','#BF5AF2','#64D2FF'];
const CATEGORIE = [
  { key:'casa', label:'Casa', color:'#0A84FF' },
  { key:'cibo', label:'Cibo e spesa', color:'#FF9F0A' },
  { key:'trasporti', label:'Trasporti', color:'#30D158' },
  { key:'svago', label:'Svago', color:'#BF5AF2' },
  { key:'salute', label:'Salute', color:'#FF453A' },
  { key:'lavoro', label:'Lavoro', color:'#64D2FF' },
  { key:'risparmio', label:'Risparmio', color:'#FFD60A' },
  { key:'altro', label:'Altro', color:'#8E8E93' },
];
function catInfo(key){ return CATEGORIE.find(c=>c.key===key) || CATEGORIE[CATEGORIE.length-1]; }
const MEDAGLIE_SOGLIE = [25, 50, 75, 100];
function medaglieRaggiunte(pct){ return MEDAGLIE_SOGLIE.filter(s=>pct>=s); }

/* ---------- Firebase / Firestore / Auth ---------- */
// window._fb e window._fbReady sono impostati dallo script di init in index.html
const {
  db: firestoreDB, doc, getDoc, setDoc, deleteDoc, auth,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail,
  updateEmail, updatePassword, deleteUser,
  reauthenticateWithCredential, EmailAuthProvider
} = window._fb;

function userRef(collection, uid){
  return doc(firestoreDB, collection, uid);
}
async function fbLoadDB(uid){
  const snap = await getDoc(userRef('numera_data', uid));
  return snap.exists() ? snap.data() : seedDB();
}
async function fbLoadSnapshots(uid){
  const snap = await getDoc(userRef('numera_snapshots', uid));
  return snap.exists() ? (snap.data().list || []) : [];
}
async function fbPersist(uid, dbData, snaps){
  await Promise.all([
    setDoc(userRef('numera_data', uid), dbData),
    setDoc(userRef('numera_snapshots', uid), { list: snaps })
  ]);
}
async function fbDeleteUserData(uid){
  await Promise.all([
    deleteDoc(userRef('numera_data', uid)),
    deleteDoc(userRef('numera_snapshots', uid))
  ]);
}

function friendlyAuthError(code){
  const map = {
    'auth/invalid-email': 'Email non valida.',
    'auth/user-not-found': 'Nessun account con questa email.',
    'auth/wrong-password': 'Password errata.',
    'auth/invalid-credential': 'Email o password non corretti.',
    'auth/email-already-in-use': 'Esiste già un account con questa email.',
    'auth/weak-password': 'La password deve avere almeno 6 caratteri.',
    'auth/too-many-requests': 'Troppi tentativi. Riprova tra qualche minuto.',
    'auth/network-request-failed': 'Errore di connessione. Controlla la rete.',
    'auth/requires-recent-login': 'Per sicurezza, reinserisci la password attuale e riprova.',
  };
  return map[code] || 'Si è verificato un errore. Riprova.';
}

/* ---------- stato iniziale vuoto per ogni nuovo utente ---------- */
function seedDB(){
  return {
    accounts: [],
    preventivati: [],
    mancanti: [],
    fisse: [],
    obiettivi: [],
    acquisti: [],
    stipendi: [],
    movimenti: [],
    budget: {},
  };
}

function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function euro(n){ return (n<0?'-':'') + '€ ' + Math.abs(n).toLocaleString('it-IT',{minimumFractionDigits:2, maximumFractionDigits:2}); }
/* Helper "chiave" data/mese SENZA passare per toISOString(): .toISOString() converte in UTC,
   e per fusi orari positivi (es. Italia) una mezzanotte locale costruita a mano può "scivolare"
   nel giorno/mese precedente in UTC. Queste funzioni leggono sempre i componenti locali. */
function dateKeyFromDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function meseKeyFromDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function oggiStr(){ return dateKeyFromDate(new Date()); }
function fmtDate(d){ if(!d) return '—'; const dt = new Date(d+'T00:00:00'); return dt.toLocaleDateString('it-IT',{day:'2-digit', month:'short'}); }
function fmtMese(m){ if(!m) return '—'; const [y,mm] = m.split('-'); const dt = new Date(Number(y), Number(mm)-1, 1); const s = dt.toLocaleDateString('it-IT',{month:'long', year:'numeric'}); return s.charAt(0).toUpperCase()+s.slice(1); }
function daysUntil(d){ const dt=new Date(d+'T00:00:00'); const now=new Date(); now.setHours(0,0,0,0); return Math.round((dt-now)/86400000); }
function isMobileView(){ return window.innerWidth <= 900; }
let _resizeTimer;
window.addEventListener('resize', ()=>{
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(()=>{
    const activePage = document.querySelector('.page.active');
    if(activePage && activePage.id==='page-dashboard' && typeof renderDashboard==='function') renderDashboard();
  }, 200);
});

/* ---------------- state ---------------- */
let db = null;
let session = null;
let snapshots = [];
let filters = {
  spese: { q:'', cat:'', acc:'', tipo:'' },
  preventivati: { q:'' },
  mancanti: { q:'' },
  fisse: { q:'' },
  obiettivi: { q:'' },
  acquisti: { q:'' },
  conti: { q:'' },
};

function saveDB(){
  if(!session) return;
  const today = oggiStr();
  const total = db.accounts.reduce((s,a)=>s+Number(a.balance||0),0);
  const idx = snapshots.findIndex(s=>s.date===today);
  if(idx>=0) snapshots[idx].total = total; else snapshots.push({date:today, total});
  snapshots = snapshots.slice(-120);
  fbPersist(session.uid, db, snapshots).catch(err=>{
    console.error('Errore salvataggio Firebase:', err);
    toast('Errore di salvataggio su Firebase.');
  });
}
function getSnapshots(){ return snapshots; }

/* ==================== AUTH ==================== */
let authMode = 'login';

document.getElementById('toggle-link').addEventListener('click', (e)=>{
  e.preventDefault();
  authMode = authMode==='login' ? 'register' : 'login';
  const isReg = authMode==='register';
  document.getElementById('field-name').style.display = isReg ? 'block' : 'none';
  document.getElementById('login-forgot').style.display = isReg ? 'none' : 'block';
  document.getElementById('login-heading').textContent = isReg ? 'Crea account' : 'Bentornato';
  document.getElementById('login-sub').textContent = isReg
    ? 'Registrati con la tua email per proteggere e sincronizzare i tuoi dati finanziari.'
    : 'Accedi al tuo cockpit finanziario per gestire eventi, conti e obiettivi.';
  document.getElementById('login-submit').textContent = isReg ? 'Crea account' : 'Accedi';
  document.getElementById('login-toggle').innerHTML = isReg
    ? 'Hai già un account? <a href="#" id="toggle-link2">Accedi</a>'
    : 'Non hai un account? <a href="#" id="toggle-link2">Registrati</a>';
  document.getElementById('toggle-link2').addEventListener('click', (ev)=>{ ev.preventDefault(); document.getElementById('toggle-link').click(); });
  document.getElementById('login-error').style.display='none';
});

document.getElementById('forgot-link').addEventListener('click', async (e)=>{
  e.preventDefault();
  const errBox = document.getElementById('login-error');
  const email = document.getElementById('login-email').value.trim();
  if(!email){ errBox.textContent='Inserisci la tua email qui sopra, poi clicca di nuovo.'; errBox.style.display='block'; return; }
  try{
    await sendPasswordResetEmail(auth, email);
    errBox.style.display='none';
    toast('Email di ripristino inviata, controlla la posta.');
  }catch(err){
    console.error(err);
    errBox.textContent = friendlyAuthError(err.code);
    errBox.style.display='block';
  }
});

document.getElementById('login-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errBox = document.getElementById('login-error');
  errBox.style.display='none';

  const submitBtn = document.getElementById('login-submit');
  const prevLabel = submitBtn.textContent;
  submitBtn.disabled = true; submitBtn.textContent = 'Attendere…';

  try{
    if(authMode==='register'){
      const name = document.getElementById('reg-name').value.trim();
      if(!name || !email || !password){ return showErr('Compila nome, email e password.'); }
      if(password.length < 6){ return showErr('La password deve avere almeno 6 caratteri.'); }
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await startSession(name, cred.user.uid);
    } else {
      if(!email || !password){ return showErr('Inserisci email e password.'); }
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const name = cred.user.displayName || cred.user.email.split('@')[0];
      await startSession(name, cred.user.uid);
    }
  } catch(err){
    console.error(err);
    showErr(friendlyAuthError(err.code));
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = prevLabel;
  }

  function showErr(msg){ errBox.textContent = msg; errBox.style.display='block'; }
});

document.getElementById('logout-btn').addEventListener('click', async (e)=>{
  e.stopPropagation();
  await signOut(auth).catch(()=>{});
  session = null;
  document.getElementById('app').classList.remove('active');
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('login-form').reset();
});
document.getElementById('user-chip').addEventListener('click', ()=> goToPage('account'));

async function startSession(name, userId){
  session = { name, uid: userId };
  db = await fbLoadDB(userId);
  if(!db.stipendi){
    // migrazione dal vecchio modello a singolo stipendio
    if(db.stipendio){
      db.stipendi = [{ id:uid(), nome:'Stipendio', base:db.stipendio.base||0, eccezioni:db.stipendio.eccezioni||[], ricevuti:db.stipendio.ricevuti||[] }];
      delete db.stipendio;
    } else {
      db.stipendi = [];
    }
  }
  if(!db.movimenti) db.movimenti = [];
  if(!db.budget) db.budget = {};
  snapshots = await fbLoadSnapshots(userId);
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').classList.add('active');
  document.getElementById('user-name-display').textContent = name;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
  saveDB();
  renderAll();
}

/* auto-login: se Firebase Auth ha già un utente valido (sessione persistente) */
(async function initAuth(){
  const user = await window._fbReady;
  if(user){
    const name = user.displayName || (user.email ? user.email.split('@')[0] : 'Utente');
    await startSession(name, user.uid);
  }
})();

/* ==================== NAV ==================== */
function goToPage(pageKey){
  document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active'));
  document.querySelectorAll('.bn-item[data-page]').forEach(i=>i.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-page="${pageKey}"]`);
  const bnItem = document.querySelector(`.bn-item[data-page="${pageKey}"]`);
  if(navItem) navItem.classList.add('active');
  if(bnItem) bnItem.classList.add('active');
  document.getElementById('page-'+pageKey).classList.add('active');
  const mainEl = document.querySelector('.main');
  mainEl.classList.toggle('dash-active', pageKey==='dashboard');
  if(pageKey==='simulatore'){
    mainEl.classList.add('sim-active');
    if(!simInitialized){ simState.saldo = computeTotals().totalConti; simInitialized = true; }
    renderSimulatore();
    playSimIntro();
  } else {
    mainEl.classList.remove('sim-active');
  }
  document.getElementById('main-scroll-target')?.scrollTo?.(0,0);
  closeSidebar();
}
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click', ()=> goToPage(item.dataset.page));
});
document.querySelectorAll('.bn-item[data-page]').forEach(item=>{
  item.addEventListener('click', ()=> goToPage(item.dataset.page));
});

/* ==================== MOBILE DRAWER ==================== */
function openSidebar(){
  document.querySelector('.sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('active');
}
function closeSidebar(){
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
}
document.getElementById('mobile-menu-btn').addEventListener('click', openSidebar);
document.getElementById('bn-menu-btn').addEventListener('click', openSidebar);
document.getElementById('sidebar-close-btn').addEventListener('click', closeSidebar);
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

/* ==================== KPI BAR (dati principali sempre visibili) ==================== */
function computeTotals(){
  const totalConti = db.accounts.reduce((s,a)=>s+Number(a.balance||0),0);
  const totalPrev = db.preventivati.reduce((s,a)=>s+Number(a.amount||0),0);
  const totalMancanti = db.mancanti.reduce((s,a)=>s+Number(a.amount||0),0);
  const totaleGenerale = totalConti + totalPrev + totalMancanti;
  return { totalConti, totalPrev, totalMancanti, totaleGenerale };
}
function computeTrendPct(currentTotal){
  if(!snapshots || snapshots.length<2) return null;
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate()-30);
  const targetStr = dateKeyFromDate(targetDate);
  const ordered = [...snapshots].sort((a,b)=>a.date.localeCompare(b.date));
  const past = ordered.find(s=>s.date>=targetStr) || ordered[0];
  if(!past || !past.total) return null;
  const pct = ((currentTotal - past.total) / Math.abs(past.total)) * 100;
  return isFinite(pct) ? pct : null;
}
function renderKpiBar(){
  const { totalConti, totalPrev, totalMancanti, totaleGenerale } = computeTotals();
  document.getElementById('kpi-attuale').textContent = euro(totalConti);
  document.getElementById('kpi-preventivato').textContent = euro(totalPrev);
  document.getElementById('kpi-mancante').textContent = euro(totalMancanti);
  document.getElementById('kpi-totale').textContent = euro(totaleGenerale);

  const trendEl = document.getElementById('kpi-trend-attuale');
  const pct = computeTrendPct(totalConti);
  if(pct===null){
    trendEl.style.display = 'none';
  } else {
    const up = pct>=0;
    trendEl.style.display = 'inline-flex';
    trendEl.style.background = up ? 'var(--mint-dim)' : 'var(--coral-dim)';
    trendEl.style.color = up ? 'var(--mint-strong)' : 'var(--coral)';
    trendEl.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5">${up ? '<path d="M5 12l5-5 5 5M10 7v10"/>' : '<path d="M5 12l5 5 5-5M10 17V7"/>'}</svg>${Math.abs(pct).toFixed(1)}%`;
  }
}

/* ==================== TOAST ==================== */
let toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toast-text').textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ==================== MODAL HELPERS ==================== */
const overlay = document.getElementById('modal-overlay');
const modalEl = document.getElementById('modal-content');
function openModal(html){ modalEl.innerHTML = html; overlay.classList.add('active'); }
function closeModal(){ overlay.classList.remove('active'); modalEl.innerHTML=''; }
overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeModal(); });

/* ==================== RENDER ALL ==================== */
const RENDER_MAP = {
  spese: ()=>renderSpese(),
  preventivati: ()=>renderPreventivati(),
  mancanti: ()=>renderMancanti(),
  fisse: ()=>renderFisse(),
  obiettivi: ()=>renderObiettivi(),
  acquisti: ()=>renderAcquisti(),
  conti: ()=>renderConti(),
};
function setFilter(page, field, value){
  filters[page][field] = value;
  const active = document.activeElement;
  const activeId = active && active.id;
  const selStart = active && typeof active.selectionStart==='number' ? active.selectionStart : null;
  const selEnd = active && typeof active.selectionEnd==='number' ? active.selectionEnd : null;
  RENDER_MAP[page]();
  if(activeId){
    const el = document.getElementById(activeId);
    if(el){
      el.focus();
      if(selStart!==null && el.setSelectionRange){ try{ el.setSelectionRange(selStart, selEnd); }catch(_){} }
    }
  }
}
function searchBar(page, placeholder, extraHtml){
  return `
    <div class="filter-bar">
      <div class="search-input">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="search-${page}" value="${esc(filters[page].q)}" placeholder="${placeholder}" oninput="setFilter('${page}','q',this.value)">
      </div>
      ${extraHtml||''}
    </div>
  `;
}
function matches(text, q){ return !q || (text||'').toLowerCase().includes(q.toLowerCase()); }

/* ==================== VISTA CALENDARIO (eventi/Preventivati) ==================== */
let calendarState = {
  dashboard: { on:false, mese:null },
  preventivati: { on:false, mese:null },
};
function calendarRenderer(pageKey){ return pageKey==='dashboard' ? renderDashboard : renderPreventivati; }
function setVistaCalendario(pageKey, on){
  if(!calendarState[pageKey].mese) calendarState[pageKey].mese = meseChiave(0);
  calendarState[pageKey].on = on;
  calendarRenderer(pageKey)();
}
function cambiaMeseCalendario(pageKey, delta){
  const st = calendarState[pageKey];
  const [y,m] = st.mese.split('-').map(Number);
  st.mese = meseKeyFromDate(new Date(y, m-1+delta, 1));
  calendarRenderer(pageKey)();
}
function vistaToggle(pageKey){
  const on = calendarState[pageKey].on;
  return `
    <div class="view-toggle">
      <button class="view-toggle-btn ${!on?'active':''}" onclick="setVistaCalendario('${pageKey}',false)">Lista</button>
      <button class="view-toggle-btn ${on?'active':''}" onclick="setVistaCalendario('${pageKey}',true)">Calendario</button>
    </div>
  `;
}
function renderCalendarGrid(pageKey){
  const st = calendarState[pageKey];
  if(!st.mese) st.mese = meseChiave(0);
  const meseKey = st.mese;
  const [y,m] = meseKey.split('-').map(Number);
  const giorni = new Date(y, m, 0).getDate();
  const primoGiornoIdx = (new Date(y, m-1, 1).getDay()+6)%7; // 0 = lunedì
  const oggiVal = oggiStr();

  const eventiPerGiorno = {};
  db.preventivati.forEach(p=>{
    if(p.date && p.date.slice(0,7)===meseKey){
      const giorno = Number(p.date.slice(8,10));
      (eventiPerGiorno[giorno] = eventiPerGiorno[giorno] || []).push(p);
    }
  });

  const celle = [];
  for(let i=0;i<primoGiornoIdx;i++) celle.push('<div class="cal-day cal-day-empty"></div>');
  for(let d=1; d<=giorni; d++){
    const dataStr = `${meseKey}-${String(d).padStart(2,'0')}`;
    const evs = eventiPerGiorno[d] || [];
    const isOggi = dataStr===oggiVal;
    celle.push(`
      <div class="cal-day ${isOggi?'cal-day-oggi':''}" ${evs.length?`onclick="modalGiornoEventi('${dataStr}')" style="cursor:pointer;"`:''}>
        <div class="cal-day-num">${d}</div>
        <div class="cal-day-events">
          ${evs.slice(0,2).map(e=>`<div class="cal-event" style="background:${e.color}22; color:${e.color};">${esc(e.name)}</div>`).join('')}
          ${evs.length>2 ? `<div class="cal-event-more">+${evs.length-2} altri</div>` : ''}
        </div>
      </div>
    `);
  }

  return `
    <div class="cal-header">
      <button class="icon-btn" onclick="cambiaMeseCalendario('${pageKey}',-1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
      <div class="cal-header-title">${fmtMese(meseKey)}</div>
      <button class="icon-btn" onclick="cambiaMeseCalendario('${pageKey}',1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
    <div class="cal-grid cal-grid-labels">
      <div class="cal-weekday">Lun</div><div class="cal-weekday">Mar</div><div class="cal-weekday">Mer</div><div class="cal-weekday">Gio</div><div class="cal-weekday">Ven</div><div class="cal-weekday">Sab</div><div class="cal-weekday">Dom</div>
    </div>
    <div class="cal-grid">${celle.join('')}</div>
  `;
}
function modalGiornoEventi(dataStr){
  const evs = db.preventivati.filter(p=>p.date===dataStr);
  if(!evs.length) return;
  openModal(`
    <h3>${fmtDate(dataStr)}</h3>
    <div class="list">
      ${evs.map(p=>`
        <div class="row-item">
          <div class="row-icon" style="background:${p.color}22; color:${p.color};">${esc(p.name.charAt(0).toUpperCase())}</div>
          <div class="row-main"><div class="row-title">${esc(p.name)}</div>${p.note?`<div class="row-sub">${esc(p.note)}</div>`:''}</div>
          <div class="row-amount" style="color:var(--blue)">${euro(p.amount)}</div>
          <div class="row-actions">
            <button class="icon-btn" onclick="closeModal(); modalPreventivato('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn" style="color:var(--mint)" title="Segna come incassato" onclick="closeModal(); convertToAccount('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div>
  `);
}

function renderAll(){
  checkStipendioAutomatico();
  checkPreventivatiScaduti();
  checkSpeseFisseAutomatiche();
  checkAcquistiDaRimuovere();
  const renderers = [renderKpiBar, renderDashboard, renderConti, renderSpese, renderStipendio, renderPreventivati, renderMancanti, renderFisse, renderObiettivi, renderAcquisti, renderAccount];
  renderers.forEach(fn=>{
    try{ fn(); }
    catch(err){ console.error(`Errore in ${fn.name}:`, err); }
  });
  updateBadge();
}
function updateBadge(){
  const b = document.getElementById('badge-mancanti');
  b.textContent = db.mancanti.length || '';
  b.style.display = db.mancanti.length ? 'inline-block' : 'none';

  const inScadenza = db.preventivati.filter(p=>{
    if(!p.date) return false;
    const d = daysUntil(p.date);
    return d>=0 && d<=3;
  });
  const bp = document.getElementById('badge-preventivati');
  bp.textContent = inScadenza.length || '';
  bp.style.background = 'var(--amber-dim)';
  bp.style.color = 'var(--amber)';
  bp.style.display = inScadenza.length ? 'inline-block' : 'none';
}

/* ==================== DASHBOARD ==================== */
let chartTrend, chartBreakdown;
function renderDashboard(){
  const { totalConti, totalPrev, totalMancanti, totaleGenerale } = computeTotals();
  const totalFisseMensili = db.fisse.reduce((s,a)=> s + (a.frequency==='annuale' ? a.amount/12 : a.amount), 0);
  const acquistiPending = db.acquisti.filter(a=>!a.bought);
  const acquistiPendingTotal = acquistiPending.reduce((s,a)=>s+Number(a.price||0)*Number(a.qty||1),0);
  const obiettiviTop = [...db.obiettivi].sort((a,b)=>{
    const pa = a.target? a.current/a.target : 0, pb = b.target? b.current/b.target : 0;
    return pb-pa;
  }).slice(0,3);

  const snaps = getSnapshots();
  let trendPct = null, trendAbs = null;
  if(snaps.length >= 2){
    const cutoff = Date.now() - 30*86400000;
    const past = snaps.filter(s=> new Date(s.date).getTime() <= cutoff);
    const ref = past.length ? past[past.length-1] : snaps[0];
    trendAbs = totalConti - ref.total;
    trendPct = ref.total !== 0 ? (trendAbs/ref.total*100) : null;
  }

  const upcoming = [...db.preventivati].filter(p=>p.date).sort((a,b)=> new Date(a.date)-new Date(b.date)).slice(0,5);

  const quickActionsHtml = `
    <div class="quick-actions">
      <button class="qa-btn" onclick="modalMovimento()"><span class="qa-icon" style="background:rgba(255,55,95,0.14); color:#FF375F;">+</span>Spesa</button>
      <button class="qa-btn" onclick="modalAccount()"><span class="qa-icon" style="background:var(--mint-dim); color:var(--mint);">+</span>Conto</button>
      <button class="qa-btn" onclick="modalPreventivato()"><span class="qa-icon" style="background:var(--blue-dim); color:var(--blue);">+</span>Evento</button>
      <button class="qa-btn" onclick="modalMancante()"><span class="qa-icon" style="background:var(--coral-dim); color:var(--coral);">+</span>Mancante</button>
      <button class="qa-btn" onclick="modalFissa()"><span class="qa-icon" style="background:var(--amber-dim); color:var(--amber);">+</span>Spesa fissa</button>
      <button class="qa-btn" onclick="modalObiettivo()"><span class="qa-icon" style="background:rgba(178,124,255,0.14); color:#B27CFF;">+</span>Obiettivo</button>
      <button class="qa-btn" onclick="modalAcquisto()"><span class="qa-icon" style="background:rgba(79,209,232,0.14); color:#4FD1E8;">+</span>Acquisto</button>
    </div>
  `;
  const obiettiviCardsHtml = obiettiviTop.length ? obiettiviTop.map(o=>{
    const pct = Math.min(100, (o.current/o.target*100)||0);
    return `<div class="card">
      <div class="card-title">${esc(o.name)}</div>
      <div class="stat-value" style="margin-top:6px; font-size:18px;">${euro(o.current)} <span style="color:var(--text-faint); font-size:12.5px; font-weight:500;">/ ${euro(o.target)}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${o.color};"></div></div>
      <div class="row-sub" style="margin-top:8px;">${pct.toFixed(0)}% raggiunto</div>
    </div>`;
  }).join('') : `<div class="card" style="grid-column:1/-1;">${emptyState('Nessun obiettivo. Creane uno per iniziare a risparmiare.')}</div>`;

  if(isMobileView()){
    document.getElementById('page-dashboard').innerHTML = '';
    document.getElementById('page-dashboard').style.display = 'none';
    const rootEl = document.getElementById('mobile-dash-root');
    rootEl.style.display = 'block';

    const meseCorrente = meseKeyFromDate(new Date());
    const usciteMese = db.movimenti.filter(m=>m.type==='uscita' && (m.date||'').slice(0,7)===meseCorrente).reduce((s,m)=>s+Number(m.amount),0);
    const speseCategoria = {};
    db.movimenti.filter(m=>m.type==='uscita' && (m.date||'').slice(0,7)===meseCorrente).forEach(m=>{
      const key = m.category || 'altro';
      speseCategoria[key] = (speseCategoria[key]||0) + Number(m.amount);
    });
    const categorieTop = CATEGORIE.filter(c=>speseCategoria[c.key]).sort((a,b)=>speseCategoria[b.key]-speseCategoria[a.key]).slice(0,4);
    const movimentiRecenti = db.movimenti.map((m,i)=>({m,i})).sort((a,b)=>{
      const cmp = (b.m.date||'').localeCompare(a.m.date||'');
      return cmp!==0 ? cmp : b.i-a.i;
    }).slice(0,6).map(x=>x.m);

    rootEl.innerHTML = `
      <div class="mobile-dash-hero">
        <div class="hero-balance-label">Saldo totale</div>
        <div class="hero-balance-amount">${euro(totalConti)}</div>
        ${trendPct!==null ? `<div class="hero-balance-trend ${trendAbs>=0?'up':'down'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="${trendAbs>=0?'M5 12l5-5 4 4 5-6':'M5 6l5 5 4-4 5 6'}"/></svg>
          ${trendAbs>=0?'+':''}${trendPct.toFixed(1)}% negli ultimi 30gg
        </div>` : ''}
        <div class="hero-balance-actions">
          <button class="hero-balance-btn primary" onclick="modalMovimento(null,'uscita')">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
            Spesa
          </button>
          <button class="hero-balance-btn" onclick="modalMovimento(null,'entrata')">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            Entrata
          </button>
        </div>
        <div class="hero-stats-row">
          <div class="hero-stat">
            <div class="hero-stat-label">Preventivato</div>
            <div class="hero-stat-value" style="color:var(--blue);">${euro(totalPrev)}</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-label">Mancante</div>
            <div class="hero-stat-value" style="color:#ff8fa8;">${euro(totalMancanti)}</div>
          </div>
          <div class="hero-stat">
            <div class="hero-stat-label">Totale</div>
            <div class="hero-stat-value">${euro(totaleGenerale)}</div>
          </div>
        </div>
      </div>

      <div class="mobile-dash-sheet">
        <div class="spend-summary">
          <div class="spend-summary-text">
            <div class="spend-summary-label">Spesa questo mese</div>
            <div class="spend-summary-amount">${euro(usciteMese)}</div>
          </div>
          <div class="spend-summary-icons">
            ${categorieTop.length ? categorieTop.map(c=>`<div class="spend-summary-icon" style="background:${c.color};" title="${esc(c.label)}: ${euro(speseCategoria[c.key])}">${esc(c.label.charAt(0))}</div>`).join('') : `<div class="spend-summary-icon" style="background:var(--surface-2); color:var(--text-faint);">—</div>`}
          </div>
        </div>

        <div class="grid grid-3" style="margin-bottom:20px;">
          <div class="card">
            <div class="card-title">Spese fisse mensili</div>
            <div class="stat-value" style="color:var(--amber); font-size:17px;">${euro(totalFisseMensili)}</div>
            <div class="row-sub" style="margin-top:4px;">${db.fisse.length} voci</div>
          </div>
          <div class="card">
            <div class="card-title">Obiettivi attivi</div>
            <div class="stat-value" style="font-size:17px;">${db.obiettivi.length}</div>
            <div class="row-sub" style="margin-top:4px;">${obiettiviTop.length? Math.round((obiettiviTop.reduce((s,o)=>s+(o.target?o.current/o.target:0),0)/obiettiviTop.length)*100)+'% medio' : 'nessuno'}</div>
          </div>
          <div class="card">
            <div class="card-title">Lista acquisti</div>
            <div class="stat-value" style="font-size:17px;">${euro(acquistiPendingTotal)}</div>
            <div class="row-sub" style="margin-top:4px;">${acquistiPending.length} da comprare</div>
          </div>
        </div>

        <div class="section-title">Transazioni recenti <span class="count">${movimentiRecenti.length}</span></div>
        <div class="list">
          ${movimentiRecenti.length ? movimentiRecenti.map(m=>{
            const isTrasf = m.type==='trasferimento';
            const isUscita = m.type==='uscita';
            const acc = !isTrasf ? db.accounts.find(a=>a.id===m.accountId) : null;
            const iconBg = isTrasf ? 'var(--blue-dim)' : (isUscita?'rgba(255,55,95,0.14)':'var(--mint-dim)');
            const iconColor = isTrasf ? 'var(--blue)' : (isUscita?'#FF375F':'var(--mint)');
            const iconPath = isTrasf ? '<path d="M7 7h11M18 7l-4-4M18 7l-4 4M17 17H6M6 17l4 4M6 17l4-4"/>' : (isUscita ? '<path d="M12 5v14M19 12l-7 7-7-7"/>' : '<path d="M12 19V5M5 12l7-7 7 7"/>');
            return `<div class="row-item">
              <div class="row-icon" style="background:${iconBg}; color:${iconColor};">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">${iconPath}</svg>
              </div>
              <div class="row-main"><div class="row-title">${esc(m.name)}</div><div class="row-sub">${acc?esc(acc.name):fmtDate(m.date)}</div></div>
              <div class="row-amount" style="color:${isTrasf?'var(--blue)':(isUscita?'var(--coral)':'var(--mint)')}">${isTrasf?'':(isUscita?'−':'+')} ${euro(m.amount)}</div>
            </div>`;
        }).join('') : emptyState('Nessun movimento ancora. Registra una spesa o un\u2019entrata per iniziare.')}
      </div>

      <div class="section-title" style="margin-top:24px;">Azioni rapide</div>
      ${quickActionsHtml}

      <div class="section-title">Obiettivi in evidenza <span class="count">${db.obiettivi.length}</span></div>
      <div class="grid grid-2">
        ${obiettiviCardsHtml}
      </div>
      </div>
    `;
    return;
  }

  document.getElementById('mobile-dash-root').style.display = 'none';
  document.getElementById('mobile-dash-root').innerHTML = '';
  document.getElementById('page-dashboard').style.display = '';
  document.getElementById('page-dashboard').innerHTML = `
    <div class="topbar">
      <div>
        <div class="page-title">Dashboard</div>
        <div class="page-sub">Panoramica generale del tuo denaro, ${esc(session.name)}.</div>
      </div>
      ${trendPct!==null ? `<div class="stat-trend ${trendAbs>=0?'up':'down'}" style="font-size:13px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="${trendAbs>=0?'M5 12l5-5 4 4 5-6':'M5 6l5 5 4-4 5 6'}"/></svg>
        ${trendAbs>=0?'+':''}${trendPct.toFixed(1)}% negli ultimi 30gg
      </div>` : ''}
    </div>

    ${quickActionsHtml}

    <div class="grid grid-3" style="margin-top:20px;">
      <div class="card">
        <div class="card-title">Spese fisse mensili</div>
        <div class="stat-value" style="color:var(--amber); font-size:20px;">${euro(totalFisseMensili)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${db.fisse.length} voci ricorrenti</div>
      </div>
      <div class="card">
        <div class="card-title">Obiettivi attivi</div>
        <div class="stat-value" style="font-size:20px;">${db.obiettivi.length}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${obiettiviTop.length? Math.round((obiettiviTop.reduce((s,o)=>s+(o.target?o.current/o.target:0),0)/obiettiviTop.length)*100)+'% medio raggiunto' : 'Nessun obiettivo ancora'}</div>
      </div>
      <div class="card">
        <div class="card-title">Lista acquisti</div>
        <div class="stat-value" style="font-size:20px;">${euro(acquistiPendingTotal)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${acquistiPending.length} da comprare</div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-top:20px;">
      <div class="card">
        <div class="card-title">Andamento denaro attuale</div>
        <div style="height:220px; margin-top:10px;"><canvas id="chart-trend"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">Ripartizione conti</div>
        <div style="height:220px; margin-top:10px;"><canvas id="chart-breakdown"></canvas></div>
      </div>
    </div>

    <div class="section-title">Prossime scadenze <span class="count">${upcoming.length}</span></div>
    ${vistaToggle('dashboard')}
    ${calendarState.dashboard.on ? renderCalendarGrid('dashboard') : `
    <div class="list">
      ${upcoming.length ? upcoming.map(p=>{
        const d = daysUntil(p.date);
        const urgent = d<=5;
        return `<div class="row-item">
          <div class="row-icon" style="background:${p.color}22; color:${p.color};">${p.name.charAt(0).toUpperCase()}</div>
          <div class="row-main">
            <div class="row-title">${esc(p.name)}</div>
            <div class="row-sub">${fmtDate(p.date)} · ${d===0?'oggi':d===1?'domani':d<0?'scaduto':'tra '+d+' giorni'}</div>
          </div>
          ${urgent ? `<span class="pill" style="background:var(--amber-dim); color:var(--amber);">a breve</span>` : ''}
          <div class="row-amount" style="color:var(--blue)">${euro(p.amount)}</div>
        </div>`;
      }).join('') : emptyState('Nessuna scadenza imminente.')}
    </div>
    `}

    <div class="section-title">Obiettivi in evidenza <span class="count">${db.obiettivi.length}</span></div>
    <div class="grid grid-3">
      ${obiettiviCardsHtml}
    </div>
  `;

  drawTrendChart(snaps);
  drawBreakdownChart();
}

function drawTrendChart(snaps){
  const ctx = document.getElementById('chart-trend');
  if(!ctx || typeof Chart === 'undefined') return;
  if(chartTrend) chartTrend.destroy();
  const data = snaps.length ? snaps : [{date:oggiStr(), total: db.accounts.reduce((s,a)=>s+Number(a.balance),0)}];
  chartTrend = new Chart(ctx, {
    type:'line',
    data:{
      labels: data.map(s=>fmtDate(s.date)),
      datasets:[{
        data: data.map(s=>s.total),
        borderColor:'#30D158', backgroundColor:'rgba(48,209,88,0.14)',
        fill:true, tension:0.4, pointRadius:0, borderWidth:2.5,
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c=> euro(c.raw) } } },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#5D7169', font:{size:10} } },
        y:{ grid:{color:'rgba(20,40,30,0.07)'}, ticks:{ color:'#5D7169', font:{size:10}, callback:v=>'€'+v } }
      }
    }
  });
}
function drawBreakdownChart(){
  const ctx = document.getElementById('chart-breakdown');
  if(!ctx || typeof Chart === 'undefined') return;
  if(chartBreakdown) chartBreakdown.destroy();
  chartBreakdown = new Chart(ctx, {
    type:'doughnut',
    data:{
      labels: db.accounts.map(a=>a.name),
      datasets:[{ data: db.accounts.map(a=>Number(a.balance)), backgroundColor: db.accounts.map(a=>a.color), borderWidth:3, borderColor:'#f6f9f7', borderRadius:6 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'70%',
      plugins:{ legend:{ position:'bottom', labels:{ color:'#5C6F65', font:{size:11}, padding:12, boxWidth:8 } },
        tooltip:{ callbacks:{ label: c=> `${c.label}: ${euro(c.raw)}` } } }
    }
  });
}

function emptyState(msg){
  return `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 15c1 1.2 2.4 2 4 2s3-.8 4-2"/></svg><p>${msg}</p></div>`;
}
function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

/* ==================== CONTI ==================== */
function renderConti(){
  const f = filters.conti;
  const total = db.accounts.reduce((s,a)=>s+Number(a.balance),0);
  let list = [...db.accounts];
  if(f.q) list = list.filter(a=> matches(a.name,f.q));
  document.getElementById('page-conti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Conti</div><div class="page-sub">${db.accounts.length} sorgenti · totale ${euro(total)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalAccount()">+ Nuovo conto</button></div>
    </div>
    ${db.accounts.length>3 ? searchBar('conti','Cerca conto...') : ''}
    <div class="grid grid-3">
      ${list.map(a=>`
        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div class="row-icon" style="background:${a.color}22; color:${a.color};">${esc(a.icon||a.name.charAt(0))}</div>
            <div class="row-actions">
              <button class="icon-btn" onclick="modalAccount('${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
              <button class="icon-btn btn-danger" onclick="deleteItem('accounts','${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
            </div>
          </div>
          <div class="card-title" style="margin-top:14px;">${esc(a.name)}</div>
          <div class="stat-value">${euro(a.balance)}</div>
        </div>
      `).join('')}
      ${list.length || !f.q ? `<div class="card" style="display:flex; align-items:center; justify-content:center; border-style:dashed; cursor:pointer; color:var(--text-faint);" onclick="modalAccount()">
        + Aggiungi sorgente
      </div>` : ''}
    </div>
  `;
}
function modalAccount(id){
  const isEdit = !!id;
  const a = isEdit ? db.accounts.find(x=>x.id===id) : null;
  openModal(`
    <h3>${isEdit?'Modifica conto':'Nuovo conto'}</h3>
    <div class="field"><label>Nome</label><input id="f-name" value="${a?esc(a.name):''}" placeholder="Es. Carta N26"></div>
    <div class="field"><label>Saldo attuale (€)</label><input id="f-balance" type="number" step="0.01" value="${a?a.balance:''}" placeholder="0.00"></div>
    ${isEdit ? `<p style="color:var(--text-faint); font-size:11.5px; margin:-8px 0 12px;">Se cambi il saldo, l'app registra da sola una spesa/entrata di rettifica in "Spese" per tenere tutto coerente.</p>` : ''}
    <div class="field"><label>Colore</label>
      <div class="color-picker">${ICON_COLORS.map(c=>`<div class="color-swatch ${a&&a.color===c?'selected':''}" style="background:${c}" data-color="${c}" onclick="selectColor(this)"></div>`).join('')}</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveAccount('${id||''}')">${isEdit?'Salva':'Crea'}</button>
    </div>
  `);
  if(!a) setTimeout(()=>document.querySelector('.color-swatch').classList.add('selected'),0);
}
function selectColor(el){ el.parentElement.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected')); el.classList.add('selected'); }
function saveAccount(id){
  const name = document.getElementById('f-name').value.trim();
  const balance = parseFloat(document.getElementById('f-balance').value)||0;
  const colorEl = document.querySelector('.color-swatch.selected');
  const color = colorEl ? colorEl.dataset.color : ICON_COLORS[0];
  if(!name) return toast('Inserisci un nome.');
  if(id){
    const a = db.accounts.find(x=>x.id===id);
    const saldoPrecedente = Number(a.balance)||0;
    a.name=name; a.balance=balance; a.color=color; a.icon = name.slice(0,2).toUpperCase();
    const delta = balance - saldoPrecedente;
    if(Math.abs(delta) > 0.004){
      db.movimenti.push({
        id:uid(), type: delta>0 ? 'entrata' : 'uscita', name:'Rettifica saldo',
        amount: Math.abs(delta), date: oggiStr(),
        accountId: id, category:'altro', rettifica:true
      });
    }
  } else {
    db.accounts.push({ id:uid(), name, balance, color, icon:name.slice(0,2).toUpperCase() });
  }
  saveDB(); closeModal(); renderAll(); toast('Conto salvato.');
}

/* ==================== SPESE (movimenti che aggiornano il saldo in automatico) ==================== */
let chartCategorie;
function applyMovimentoEffect(m, sign){
  // sign = +1 per applicare l'effetto sui conti, -1 per annullarlo
  if(m.type==='trasferimento'){
    const from = db.accounts.find(a=>a.id===m.fromAccountId);
    const to = db.accounts.find(a=>a.id===m.toAccountId);
    if(from) from.balance = Number(from.balance) - sign*Number(m.amount);
    if(to) to.balance = Number(to.balance) + sign*Number(m.amount);
  } else {
    const acc = db.accounts.find(a=>a.id===m.accountId);
    if(!acc) return;
    const delta = m.type==='uscita' ? -Number(m.amount) : Number(m.amount);
    acc.balance = Number(acc.balance) + sign*delta;
  }
}
function renderSpese(){
  const f = filters.spese;
  const meseCorrente = meseKeyFromDate(new Date());
  const delMese = db.movimenti.filter(m=> (m.date||'').slice(0,7)===meseCorrente);
  const usciteMese = delMese.filter(m=>m.type==='uscita').reduce((s,m)=>s+Number(m.amount),0);
  const entrateMese = delMese.filter(m=>m.type==='entrata').reduce((s,m)=>s+Number(m.amount),0);

  let list = db.movimenti.map((m,i)=>({m,i})).sort((a,b)=>{
    const cmp = (b.m.date||'').localeCompare(a.m.date||'');
    return cmp!==0 ? cmp : b.i - a.i; // a parità di data, il più aggiunto di recente prima
  }).map(x=>x.m);
  if(f.q) list = list.filter(m=> matches(m.name, f.q) || (m.category && matches(catInfo(m.category).label, f.q)));
  if(f.cat) list = list.filter(m=> m.category===f.cat);
  if(f.acc) list = list.filter(m=> m.accountId===f.acc || m.fromAccountId===f.acc || m.toAccountId===f.acc);
  if(f.tipo) list = list.filter(m=> m.type===f.tipo);

  const speseCategoria = {};
  delMese.filter(m=>m.type==='uscita').forEach(m=>{
    const key = m.category || 'altro';
    speseCategoria[key] = (speseCategoria[key]||0) + Number(m.amount);
  });
  const categorieConDati = CATEGORIE.filter(c => speseCategoria[c.key] || db.budget[c.key]);

  const extraFiltersHtml = `
    <select class="filter-select" onchange="setFilter('spese','tipo',this.value)">
      <option value="">Tutti i tipi</option>
      <option value="uscita" ${f.tipo==='uscita'?'selected':''}>Spese</option>
      <option value="entrata" ${f.tipo==='entrata'?'selected':''}>Entrate</option>
      <option value="trasferimento" ${f.tipo==='trasferimento'?'selected':''}>Trasferimenti</option>
    </select>
    <select class="filter-select" onchange="setFilter('spese','cat',this.value)">
      <option value="">Tutte le categorie</option>
      ${CATEGORIE.map(c=>`<option value="${c.key}" ${f.cat===c.key?'selected':''}>${esc(c.label)}</option>`).join('')}
    </select>
    <select class="filter-select" onchange="setFilter('spese','acc',this.value)">
      <option value="">Tutti i conti</option>
      ${db.accounts.map(a=>`<option value="${a.id}" ${f.acc===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}
    </select>
  `;

  document.getElementById('page-spese').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Spese</div><div class="page-sub">${db.movimenti.length} movimenti · aggiornano il saldo del conto in automatico</div></div>
      <div class="topbar-actions">
        <button class="btn" onclick="modalBudget()">Budget</button>
        <button class="btn btn-primary" onclick="modalMovimento()">+ Nuovo movimento</button>
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:20px;">
      <div class="card">
        <div class="card-title">Uscite questo mese</div>
        <div class="stat-value" style="color:var(--coral);">${euro(usciteMese)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${delMese.filter(m=>m.type==='uscita').length} spese registrate</div>
      </div>
      <div class="card">
        <div class="card-title">Entrate questo mese</div>
        <div class="stat-value" style="color:var(--mint);">${euro(entrateMese)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${delMese.filter(m=>m.type==='entrata').length} entrate registrate</div>
      </div>
    </div>

    ${categorieConDati.length ? `
    <div class="section-title">Budget per categoria <span class="count">questo mese</span></div>
    <div class="grid grid-3" style="margin-bottom:20px;">
      ${categorieConDati.map(c=>{
        const speso = speseCategoria[c.key]||0;
        const limite = db.budget[c.key]||0;
        const pct = limite ? Math.min(100, speso/limite*100) : 0;
        const over = limite && speso>limite;
        return `<div class="card">
          <div class="card-title">${esc(c.label)}</div>
          <div class="stat-value" style="font-size:18px; color:${over?'var(--coral)':'var(--text)'};">${euro(speso)}${limite?` <span style="color:var(--text-faint); font-size:12.5px; font-weight:500;">/ ${euro(limite)}</span>`:''}</div>
          ${limite ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${over?'var(--coral)':c.color};"></div></div>` : `<div class="row-sub" style="margin-top:8px;">Nessun budget impostato</div>`}
        </div>`;
      }).join('')}
    </div>
    ` : ''}

    <div class="grid grid-2" style="margin:20px 0;">
      <div class="card">
        <div class="card-title">Spesa per categoria (questo mese)</div>
        <div style="height:220px; margin-top:10px;"><canvas id="chart-categorie"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">Totali per categoria</div>
        <div style="margin-top:10px;">
          ${CATEGORIE.filter(c=>speseCategoria[c.key]).sort((a,b)=>speseCategoria[b.key]-speseCategoria[a.key]).map(c=>`
            <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-soft);">
              <div style="display:flex; align-items:center; gap:8px;"><span style="width:9px;height:9px;border-radius:50%;background:${c.color};display:inline-block;"></span>${esc(c.label)}</div>
              <div style="font-family:var(--font-mono); font-weight:700;">${euro(speseCategoria[c.key])}</div>
            </div>
          `).join('') || `<div class="row-sub" style="padding:10px 0;">Nessuna spesa categorizzata questo mese.</div>`}
        </div>
      </div>
    </div>

    <div class="section-title">Movimenti <span class="count">${list.length}</span></div>
    ${searchBar('spese','Cerca movimento...', extraFiltersHtml)}
    <div class="list">
      ${list.length ? list.map(m=>{
        const isTrasf = m.type==='trasferimento';
        const isUscita = m.type==='uscita';
        const acc = !isTrasf ? db.accounts.find(a=>a.id===m.accountId) : null;
        const fromAcc = isTrasf ? db.accounts.find(a=>a.id===m.fromAccountId) : null;
        const toAcc = isTrasf ? db.accounts.find(a=>a.id===m.toAccountId) : null;
        const cat = (!isTrasf && m.category) ? catInfo(m.category) : null;
        const iconBg = isTrasf ? 'var(--blue-dim)' : (isUscita?'rgba(255,55,95,0.14)':'var(--mint-dim)');
        const iconColor = isTrasf ? 'var(--blue)' : (isUscita?'#FF375F':'var(--mint)');
        const iconPath = isTrasf ? '<path d="M7 7h11M18 7l-4-4M18 7l-4 4M17 17H6M6 17l4 4M6 17l4-4"/>' : (isUscita ? '<path d="M12 5v14M19 12l-7 7-7-7"/>' : '<path d="M12 19V5M5 12l7-7 7 7"/>');
        const sub = isTrasf ? `${fromAcc?esc(fromAcc.name):'conto eliminato'} → ${toAcc?esc(toAcc.name):'conto eliminato'} · ${fmtDate(m.date)}` : `${acc?esc(acc.name):'Conto eliminato'} · ${fmtDate(m.date)}${cat?' · '+esc(cat.label):''}`;
        return `
        <div class="row-item">
          <div class="row-icon" style="background:${iconBg}; color:${iconColor};">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">${iconPath}</svg>
          </div>
          <div class="row-main"><div class="row-title">${esc(m.name)}</div><div class="row-sub">${sub}</div></div>
          <div class="row-amount" style="color:${isTrasf?'var(--blue)':(isUscita?'var(--coral)':'var(--mint)')}">${isTrasf?'':(isUscita?'−':'+')} ${euro(m.amount)}</div>
          <div class="row-actions">
            ${m.rettifica ? `<span class="pill" style="background:var(--surface-2); color:var(--text-faint);" title="Generata dalla modifica manuale del saldo, non eliminabile">Rettifica</span>` : `
            <button class="icon-btn" onclick="modalMovimento('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteMovimento('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
            `}
          </div>
        </div>
      `;}).join('') : emptyState(db.movimenti.length ? 'Nessun movimento corrisponde alla ricerca.' : "Nessun movimento ancora. Registra una spesa o un'entrata: il saldo del conto si aggiorna da solo.")}
    </div>
  `;

  drawCategorieChart(speseCategoria);
}
function drawCategorieChart(speseCategoria){
  const ctx = document.getElementById('chart-categorie');
  if(!ctx || typeof Chart === 'undefined') return;
  if(chartCategorie) chartCategorie.destroy();
  const entries = CATEGORIE.filter(c=>speseCategoria[c.key]);
  if(!entries.length) return;
  chartCategorie = new Chart(ctx, {
    type:'doughnut',
    data:{
      labels: entries.map(c=>c.label),
      datasets:[{ data: entries.map(c=>speseCategoria[c.key]), backgroundColor: entries.map(c=>c.color), borderWidth:3, borderColor:'#f6f9f7', borderRadius:6 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'70%',
      plugins:{ legend:{ position:'bottom', labels:{ color:'#5C6F65', font:{size:11}, padding:12, boxWidth:8 } },
        tooltip:{ callbacks:{ label: c=> `${c.label}: ${euro(c.raw)}` } } }
    }
  });
}
function modalMovimento(id, presetType){
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
  const isEdit = !!id;
  const m = isEdit ? db.movimenti.find(x=>x.id===id) : null;
  if(m && m.rettifica) return toast('Le rettifiche di saldo non sono modificabili: cambia di nuovo il saldo dal conto se serve.');
  const tipo = m ? m.type : (presetType || 'uscita');
  const accOptions = (selected)=> db.accounts.map(a=>`<option value="${a.id}" ${selected===a.id?'selected':''}>${esc(a.name)}</option>`).join('');
  const catOptions = (selected)=> CATEGORIE.map(c=>`<option value="${c.key}" ${(selected||'altro')===c.key?'selected':''}>${esc(c.label)}</option>`).join('');
  openModal(`
    <h3>${isEdit?'Modifica movimento':'Nuovo movimento'}</h3>
    <div class="field">
      <label>Tipo</label>
      <div style="display:flex; gap:14px; margin-top:6px; flex-wrap:wrap;">
        <label class="chip-check"><input type="radio" name="f-mov-tipo" value="uscita" ${tipo==='uscita'?'checked':''} onclick="toggleMovTipo('uscita')"> Spesa</label>
        <label class="chip-check"><input type="radio" name="f-mov-tipo" value="entrata" ${tipo==='entrata'?'checked':''} onclick="toggleMovTipo('entrata')"> Entrata</label>
        <label class="chip-check"><input type="radio" name="f-mov-tipo" value="trasferimento" ${tipo==='trasferimento'?'checked':''} onclick="toggleMovTipo('trasferimento')"> Trasferimento</label>
      </div>
    </div>
    <div class="field"><label>Descrizione</label><input id="f-mov-name" value="${m?esc(m.name):(tipo==='trasferimento'?'Trasferimento':'')}" placeholder="Es. Spesa al supermercato"></div>
    <div class="field-row">
      <div class="field"><label>Importo (€)</label><input id="f-mov-amount" type="number" step="0.01" value="${m?m.amount:''}" placeholder="0.00"></div>
      <div class="field"><label>Data</label><input id="f-mov-date" type="date" value="${m?m.date:oggiStr()}"></div>
    </div>
    <div id="mov-field-conto" class="field" style="display:${tipo==='trasferimento'?'none':'block'};">
      <label>Conto</label>
      <select id="f-mov-account">${accOptions(m?m.accountId:'')}</select>
    </div>
    <div id="mov-field-trasf" class="field-row" style="display:${tipo==='trasferimento'?'grid':'none'};">
      <div class="field"><label>Da conto</label><select id="f-mov-from">${accOptions(m?m.fromAccountId:'')}</select></div>
      <div class="field"><label>A conto</label><select id="f-mov-to">${accOptions(m?m.toAccountId:'')}</select></div>
    </div>
    <div id="mov-field-cat" class="field" style="display:${tipo==='trasferimento'?'none':'block'};">
      <label>Categoria</label>
      <select id="f-mov-cat">${catOptions(m?m.category:'altro')}</select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveMovimento('${id||''}')">${isEdit?'Salva':'Registra'}</button>
    </div>
  `);
}
function toggleMovTipo(tipo){
  const isTrasf = tipo==='trasferimento';
  document.getElementById('mov-field-conto').style.display = isTrasf ? 'none' : 'block';
  document.getElementById('mov-field-trasf').style.display = isTrasf ? 'grid' : 'none';
  document.getElementById('mov-field-cat').style.display = isTrasf ? 'none' : 'block';
}
function saveMovimento(id){
  const type = document.querySelector('input[name="f-mov-tipo"]:checked').value;
  const name = document.getElementById('f-mov-name').value.trim();
  const amount = parseFloat(document.getElementById('f-mov-amount').value)||0;
  const date = document.getElementById('f-mov-date').value;
  if(!name) return toast('Inserisci una descrizione.');
  if(amount<=0) return toast('Inserisci un importo maggiore di zero.');

  const data = { name, amount, date, type };
  if(type==='trasferimento'){
    const fromAccountId = document.getElementById('f-mov-from').value;
    const toAccountId = document.getElementById('f-mov-to').value;
    if(fromAccountId===toAccountId) return toast('Scegli due conti diversi.');
    data.fromAccountId = fromAccountId; data.toAccountId = toAccountId;
  } else {
    const accountId = document.getElementById('f-mov-account').value;
    const category = document.getElementById('f-mov-cat').value;
    if(!db.accounts.find(a=>a.id===accountId)) return toast('Conto non trovato.');
    data.accountId = accountId; data.category = category;
  }

  if(id){
    const m = db.movimenti.find(x=>x.id===id);
    applyMovimentoEffect(m, -1);
    // rimuove i campi del tipo precedente per non lasciare valori vuoti sul vecchio tipo
    delete m.accountId; delete m.category; delete m.fromAccountId; delete m.toAccountId;
    Object.assign(m, data);
    applyMovimentoEffect(m, +1);
  } else {
    const m = { id:uid(), ...data };
    db.movimenti.push(m);
    applyMovimentoEffect(m, +1);
  }

  saveDB(); closeModal(); renderAll();
  toast(type==='trasferimento' ? 'Trasferimento registrato.' : type==='uscita' ? 'Spesa registrata, saldo aggiornato.' : 'Entrata registrata, saldo aggiornato.');
}
function deleteMovimento(id){
  const m = db.movimenti.find(x=>x.id===id);
  if(!m) return;
  if(m.rettifica) return toast('Le rettifiche di saldo non si possono eliminare: modifica di nuovo il saldo dal conto se serve.');
  applyMovimentoEffect(m, -1);
  db.movimenti = db.movimenti.filter(x=>x.id!==id);
  saveDB(); renderAll(); toast('Movimento eliminato, saldo ripristinato.');
}
function modalBudget(){
  openModal(`
    <h3>Budget mensile per categoria</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Imposta un limite di spesa mensile per ogni categoria. Lascia vuoto per non impostare un limite.</p>
    ${CATEGORIE.map(c=>`
      <div class="field">
        <label>${esc(c.label)}</label>
        <input id="f-budget-${c.key}" type="number" step="0.01" value="${db.budget[c.key]||''}" placeholder="Nessun limite">
      </div>
    `).join('')}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveBudget()">Salva</button>
    </div>
  `);
}
function saveBudget(){
  CATEGORIE.forEach(c=>{
    const val = parseFloat(document.getElementById(`f-budget-${c.key}`).value);
    if(val>0) db.budget[c.key] = val; else delete db.budget[c.key];
  });
  saveDB(); closeModal(); renderAll(); toast('Budget salvato.');
}

/* ==================== STIPENDIO (supporta più fonti, es. più lavori) ==================== */
function stipendioPerMese(st, mese){
  const ecc = st.eccezioni.find(e=>e.mese===mese);
  return ecc ? ecc.amount : st.base;
}
function meseChiave(offset){
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()+offset);
  return meseKeyFromDate(d);
}
function meseSuccessivoChiave(mese){
  const [y,m] = mese.split('-').map(Number);
  return meseKeyFromDate(new Date(y, m, 1));
}
function ultimoGiornoMese(mese){
  const [y,m] = mese.split('-').map(Number);
  const giorno = new Date(y, m, 0).getDate();
  return `${mese}-${String(giorno).padStart(2,'0')}`;
}
function checkStipendioAutomatico(){
  if(!db || !session || !db.stipendi) return;
  const meseScorso = meseChiave(-1);
  const meseCorrente = meseChiave(0);
  let changed = false;

  db.stipendi.forEach(st=>{
    if(!st.base && !st.eccezioni.length) return;

    // fallback: se il mese scorso non ha né un Preventivato né una voce Mancanti né è già ricevuto
    // (capita quando questa fonte di stipendio viene configurata per la prima volta, senza storico)
    const giaInMancanti = db.mancanti.some(m=>m.fromStipendioId===st.id && m.fromStipendioMese===meseScorso);
    const giaInPreventivati = db.preventivati.some(p=>p.fromStipendioId===st.id && p.fromStipendioMese===meseScorso);
    const giaRicevuto = st.ricevuti.includes(meseScorso);
    if(!giaInMancanti && !giaInPreventivati && !giaRicevuto){
      const stima = stipendioPerMese(st, meseScorso);
      if(stima>0){
        db.mancanti.push({ id:uid(), name:`${st.nome} ${fmtMese(meseScorso)}`, amount:stima, note:"Stima, da confermare all'accredito", fromStipendioId:st.id, fromStipendioMese:meseScorso });
        changed = true;
      }
    }

    // mese corrente: previsione in Preventivati, con data = ultimo giorno del mese.
    // Così la regola generale in checkPreventivatiScaduti() lo sposta in Mancanti esattamente
    // il 1° del mese successivo (fisso), se non è stato ancora accreditato.
    const giaRicevutoCorrente = st.ricevuti.includes(meseCorrente);
    const giaTracciatoCorrente = db.preventivati.some(p=>p.fromStipendioId===st.id && p.fromStipendioMese===meseCorrente) || db.mancanti.some(m=>m.fromStipendioId===st.id && m.fromStipendioMese===meseCorrente);
    if(!giaRicevutoCorrente && !giaTracciatoCorrente){
      const stima = stipendioPerMese(st, meseCorrente);
      if(stima>0){
        db.preventivati.push({ id:uid(), name:`${st.nome} ${fmtMese(meseCorrente)}`, amount:stima, date:ultimoGiornoMese(meseCorrente), note:'Stima automatica dalla sezione Stipendio', color:'#0A84FF', fromStipendioId:st.id, fromStipendioMese:meseCorrente });
        changed = true;
      }
    }
  });

  if(changed) saveDB();
}
function checkPreventivatiScaduti(){
  // regola generale per TUTTI i preventivati (compresi quelli generati dallo stipendio):
  // il giorno dopo la data prevista, se non sono stati saldati, passano in Mancanti da soli.
  if(!db || !session) return;
  const oggiVal = oggiStr();
  let changed = false;
  const rimasti = [];
  db.preventivati.forEach(p=>{
    if(p.date && p.date < oggiVal){
      const mancante = { id:uid(), name:p.name, amount:p.amount };
      if(p.fromStipendioId){
        mancante.fromStipendioId = p.fromStipendioId;
        mancante.fromStipendioMese = p.fromStipendioMese;
        mancante.note = "Stima, da confermare all'accredito";
      } else if(p.note){
        mancante.note = p.note;
      }
      db.mancanti.push(mancante);
      changed = true;
    } else {
      rimasti.push(p);
    }
  });
  if(changed){
    db.preventivati = rimasti;
    saveDB();
  }
}
function riempiMesiMancanti(st, ultimoAccreditato){
  const meseScorso = meseChiave(-1);
  let cursore = meseSuccessivoChiave(ultimoAccreditato);
  let guard = 0;
  while(cursore <= meseScorso && guard<36){
    const giaPresente = st.ricevuti.includes(cursore) || db.mancanti.some(m=>m.fromStipendioId===st.id && m.fromStipendioMese===cursore);
    if(!giaPresente){
      const stima = stipendioPerMese(st, cursore);
      if(stima>0){
        db.mancanti.push({ id:uid(), name:`${st.nome} ${fmtMese(cursore)}`, amount:stima, note:"Stima, da confermare all'accredito", fromStipendioId:st.id, fromStipendioMese:cursore });
      }
    }
    cursore = meseSuccessivoChiave(cursore);
    guard++;
  }
}
function renderStipendio(){
  const meseScorso = meseChiave(-1);
  const meseCorrente = meseKeyFromDate(new Date());

  document.getElementById('page-stipendio').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Stipendio</div><div class="page-sub">${db.stipendi.length} fonte${db.stipendi.length===1?'':'i'} di stipendio · utile se hai più lavori</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalNuovoStipendio()">+ Nuovo stipendio</button></div>
    </div>
    ${db.stipendi.length ? db.stipendi.map(st=>renderStipendioBlock(st, meseScorso, meseCorrente)).join('') : `<div class="card">${emptyState('Nessuno stipendio configurato. Aggiungine uno: se hai più lavori puoi crearne più di uno.')}</div>`}
  `;
}
function renderStipendioBlock(st, meseScorso, meseCorrente){
  const eccezioneCorrente = st.eccezioni.find(e=>e.mese===meseCorrente);
  const importoMeseCorrente = eccezioneCorrente ? eccezioneCorrente.amount : st.base;
  const sorted = [...st.eccezioni].sort((a,b)=> b.mese.localeCompare(a.mese));

  const mancanteScorso = db.mancanti.find(m=>m.fromStipendioId===st.id && m.fromStipendioMese===meseScorso);
  const ricevutoScorso = st.ricevuti.includes(meseScorso);
  const preventivoCorrente = db.preventivati.find(p=>p.fromStipendioId===st.id && p.fromStipendioMese===meseCorrente);

  return `
    <div class="card" style="margin-bottom:20px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
        <div>
          <div class="card-title" style="font-size:15px; color:var(--text);">${esc(st.nome)}</div>
          <div class="row-sub" style="margin-top:2px;">Base ${euro(st.base)} al mese${eccezioneCorrente?' · questo mese è diverso dal solito':''}</div>
        </div>
        <div class="topbar-actions">
          <button class="btn" onclick="modalStipendioBase('${st.id}')">Modifica</button>
          <button class="btn btn-primary" onclick="modalEccezione('${st.id}')">+ Eccezione</button>
          <button class="icon-btn btn-danger" title="Elimina questa fonte di stipendio" onclick="deleteStipendio('${st.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
        </div>
      </div>

      <div class="list" style="margin-bottom:18px;">
        <div class="row-item">
          <div class="row-icon" style="background:var(--coral-dim); color:var(--coral);">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
          </div>
          <div class="row-main">
            <div class="row-title">Stipendio di ${fmtMese(meseScorso)}</div>
            <div class="row-sub">${ricevutoScorso ? 'Già accreditato su un conto' : mancanteScorso ? "In \"Mancanti\", in attesa di conferma e accredito" : 'Nessuna stima disponibile'}</div>
          </div>
          ${ricevutoScorso ? `<span class="pill" style="background:var(--mint-dim); color:var(--mint);">✓ Ricevuto</span>` : mancanteScorso ? `<button class="btn" onclick="goToPage('mancanti')">Vai a Mancanti</button>` : ''}
        </div>
        <div class="row-item">
          <div class="row-icon" style="background:var(--blue-dim); color:var(--blue);">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          </div>
          <div class="row-main">
            <div class="row-title">Stipendio di ${fmtMese(meseCorrente)}</div>
            <div class="row-sub">${preventivoCorrente ? `Previsto in "Preventivati", passa in Mancanti il 1° ${fmtMese(meseSuccessivoChiave(meseCorrente))} se non ancora accreditato` : 'Nessuna stima disponibile'}</div>
          </div>
          ${preventivoCorrente ? `<button class="btn" onclick="goToPage('preventivati')">Vai a Preventivati</button>` : ''}
        </div>
      </div>

      <div class="grid grid-2" style="margin-bottom:${sorted.length?'18px':'0'};">
        <div class="card" style="box-shadow:none; border:1px solid var(--border-soft); background:none;">
          <div class="card-title">Questo mese</div>
          <div class="stat-value" style="font-size:18px; color:${eccezioneCorrente ? 'var(--amber)' : 'var(--text)'}">${euro(importoMeseCorrente)}</div>
          <div class="row-sub" style="margin-top:4px;">${eccezioneCorrente ? esc(eccezioneCorrente.note || 'Importo diverso dal solito') : 'Importo standard, nessuna eccezione'}</div>
        </div>
        <div class="card" style="box-shadow:none; border:1px solid var(--border-soft); background:none;">
          <div class="card-title">Eccezioni registrate</div>
          <div class="stat-value" style="font-size:18px;">${st.eccezioni.length}</div>
          <div class="row-sub" style="margin-top:4px;">mesi con importo diverso dalla base</div>
        </div>
      </div>

      ${sorted.length ? `
      <div class="section-title" style="margin-top:8px; margin-bottom:10px;">Eccezioni <span class="count">${st.eccezioni.length}</span></div>
      <div class="list">
        ${sorted.map(e=>`
          <div class="row-item">
            <div class="row-icon" style="background:var(--amber-dim); color:var(--amber);">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </div>
            <div class="row-main"><div class="row-title">${fmtMese(e.mese)}</div><div class="row-sub">${e.note ? esc(e.note) : 'Nessuna nota'}</div></div>
            <div class="row-amount" style="color:${e.amount < st.base ? 'var(--coral)' : 'var(--mint)'}">${euro(e.amount)}</div>
            <div class="row-actions">
              <button class="icon-btn" onclick="modalEccezione('${st.id}','${e.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
              <button class="icon-btn btn-danger" onclick="deleteEccezione('${st.id}','${e.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
            </div>
          </div>
        `).join('')}
      </div>
      ` : ''}
    </div>
  `;
}
function modalNuovoStipendio(){
  openModal(`
    <h3>Nuovo stipendio</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Utile se hai più lavori: crea una fonte separata per ciascuno stipendio.</p>
    <div class="field"><label>Nome</label><input id="f-stip-nome" placeholder="Es. Lavoro principale, Secondo lavoro..."></div>
    <div class="field"><label>Importo mensile (€)</label><input id="f-stip-base-nuovo" type="number" step="0.01" placeholder="0.00"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="creaStipendio()">Crea</button>
    </div>
  `);
}
function creaStipendio(){
  const nome = document.getElementById('f-stip-nome').value.trim();
  const base = parseFloat(document.getElementById('f-stip-base-nuovo').value)||0;
  if(!nome) return toast('Inserisci un nome.');
  db.stipendi.push({ id:uid(), nome, base, eccezioni:[], ricevuti:[] });
  saveDB(); closeModal(); renderAll(); toast('Stipendio creato.');
}
function deleteStipendio(id){
  db.stipendi = db.stipendi.filter(x=>x.id!==id);
  saveDB(); renderAll(); toast('Stipendio eliminato.');
}
function modalStipendioBase(stipendioId){
  const st = db.stipendi.find(x=>x.id===stipendioId);
  if(!st) return;
  const ultimoDefault = st.ricevuti.length ? [...st.ricevuti].sort().slice(-1)[0] : '';
  openModal(`
    <h3>Modifica stipendio</h3>
    <div class="field"><label>Nome</label><input id="f-stip-nome-edit" value="${esc(st.nome)}"></div>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:10px;">L'importo che percepisci di solito ogni mese da questa fonte. Le eccezioni si aggiungono a parte.</p>
    <div class="field"><label>Importo mensile (€)</label><input id="f-stip-base" type="number" step="0.01" value="${st.base || ''}" placeholder="0.00"></div>
    <div class="field">
      <label>Ultimo stipendio accreditato</label>
      <input id="f-stip-ultimo" type="month" value="${ultimoDefault}" max="${meseChiave(0)}">
    </div>
    <p style="color:var(--text-faint); font-size:11.5px; margin-top:4px;">Serve a capire quali mesi passati risultano ancora da accreditare per questa fonte: quelli dopo questo mese e fino allo scorso finiranno tra i Mancanti. Lascia vuoto se non vuoi controllare mesi passati.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveStipendioBase('${stipendioId}')">Salva</button>
    </div>
  `);
}
function saveStipendioBase(stipendioId){
  const st = db.stipendi.find(x=>x.id===stipendioId);
  if(!st) return;
  const nome = document.getElementById('f-stip-nome-edit').value.trim();
  const amount = parseFloat(document.getElementById('f-stip-base').value)||0;
  const ultimo = document.getElementById('f-stip-ultimo').value;
  if(!nome) return toast('Inserisci un nome.');
  st.nome = nome;
  st.base = amount;
  if(ultimo){
    if(!st.ricevuti.includes(ultimo)) st.ricevuti.push(ultimo);
    riempiMesiMancanti(st, ultimo);
  }
  saveDB(); closeModal(); renderAll(); toast('Stipendio salvato.');
}
function modalEccezione(stipendioId, id){
  const st = db.stipendi.find(x=>x.id===stipendioId);
  if(!st) return;
  const isEdit = !!id;
  const e = isEdit ? st.eccezioni.find(x=>x.id===id) : null;
  const meseDefault = e ? e.mese : meseKeyFromDate(new Date());
  openModal(`
    <h3>${isEdit?'Modifica eccezione':'Nuova eccezione'}</h3>
    <div class="field-row">
      <div class="field"><label>Mese</label><input id="f-ecc-mese" type="month" value="${meseDefault}"></div>
      <div class="field"><label>Importo (€)</label><input id="f-ecc-amount" type="number" step="0.01" value="${e?e.amount:''}" placeholder="0.00"></div>
    </div>
    <div class="field"><label>Motivo (opzionale)</label><input id="f-ecc-note" value="${e?esc(e.note||''):''}" placeholder="Es. bonus, malattia, part time"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveEccezione('${stipendioId}','${id||''}')">${isEdit?'Salva':'Aggiungi'}</button>
    </div>
  `);
}
function saveEccezione(stipendioId, id){
  const st = db.stipendi.find(x=>x.id===stipendioId);
  if(!st) return;
  const mese = document.getElementById('f-ecc-mese').value;
  const amount = parseFloat(document.getElementById('f-ecc-amount').value)||0;
  const note = document.getElementById('f-ecc-note').value.trim();
  if(!mese) return toast('Seleziona un mese.');
  if(id){
    const e = st.eccezioni.find(x=>x.id===id);
    e.mese = mese; e.amount = amount; e.note = note;
  } else {
    const existing = st.eccezioni.find(x=>x.mese===mese);
    if(existing){ existing.amount = amount; existing.note = note; }
    else st.eccezioni.push({ id:uid(), mese, amount, note });
  }
  saveDB(); closeModal(); renderAll(); toast('Eccezione salvata.');
}
function deleteEccezione(stipendioId, id){
  const st = db.stipendi.find(x=>x.id===stipendioId);
  if(!st) return;
  st.eccezioni = st.eccezioni.filter(x=>x.id!==id);
  saveDB(); renderAll(); toast('Eliminata.');
}

/* ==================== PREVENTIVATI ==================== */
function renderPreventivati(){
  const f = filters.preventivati;
  const total = db.preventivati.reduce((s,p)=>s+Number(p.amount),0);
  let sorted = [...db.preventivati].sort((a,b)=> new Date(a.date||'2100-01-01') - new Date(b.date||'2100-01-01'));
  if(f.q) sorted = sorted.filter(p=> matches(p.name,f.q) || matches(p.note,f.q));
  document.getElementById('page-preventivati').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Appuntamenti &amp; Preventivati</div><div class="page-sub">${db.preventivati.length} eventi · totale ${euro(total)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo evento</button></div>
    </div>
    ${vistaToggle('preventivati')}
    ${calendarState.preventivati.on ? renderCalendarGrid('preventivati') : `
    ${searchBar('preventivati','Cerca evento...')}
    <div class="list">
      ${sorted.length ? sorted.map(p=>{
        const d = p.date ? daysUntil(p.date) : null;
        const urgente = d!==null && d>=0 && d<=3;
        return `<div class="row-item">
          <div class="row-icon" style="background:${p.color}22; color:${p.color};">${p.name.charAt(0).toUpperCase()}</div>
          <div class="row-main">
            <div class="row-title">${esc(p.name)}</div>
            <div class="row-sub">${fmtDate(p.date)}${d!==null ? ' · '+(d===0?'oggi':d<0?'passato':'tra '+d+' giorni') : ''}${p.note?' · '+esc(p.note):''}</div>
          </div>
          ${urgente ? `<span class="pill" style="background:var(--amber-dim); color:var(--amber);">a breve</span>` : ''}
          <div class="row-amount" style="color:var(--blue)">${euro(p.amount)}</div>
          <div class="row-actions">
            <button class="icon-btn" onclick="modalPreventivato('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn" style="color:var(--mint)" title="Segna come incassato" onclick="convertToAccount('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('preventivati','${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>`;
      }).join('') : emptyState(db.preventivati.length ? 'Nessun evento corrisponde alla ricerca.' : 'Nessun evento preventivato. Aggiungine uno.')}
    </div>
    `}
  `;
}
function modalPreventivato(id){
  const isEdit = !!id;
  const p = isEdit ? db.preventivati.find(x=>x.id===id) : null;
  openModal(`
    <h3>${isEdit?'Modifica evento':'Nuovo evento preventivato'}</h3>
    <div class="field"><label>Nome evento / cliente</label><input id="f-name" value="${p?esc(p.name):''}" placeholder="Es. Compleanno Marco"></div>
    <div class="field-row">
      <div class="field"><label>Importo (€)</label><input id="f-amount" type="number" step="0.01" value="${p?p.amount:''}" placeholder="0.00"></div>
      <div class="field"><label>Data</label><input id="f-date" type="date" value="${p?p.date||'':''}"></div>
    </div>
    <div class="field"><label>Nota (opzionale)</label><input id="f-note" value="${p?esc(p.note||''):''}" placeholder="Es. acconto già versato"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="savePreventivato('${id||''}')">${isEdit?'Salva':'Crea'}</button>
    </div>
  `);
}
function savePreventivato(id){
  const name = document.getElementById('f-name').value.trim();
  const amount = parseFloat(document.getElementById('f-amount').value)||0;
  const date = document.getElementById('f-date').value;
  const note = document.getElementById('f-note').value.trim();
  if(!name) return toast('Inserisci un nome.');
  if(id){
    const p = db.preventivati.find(x=>x.id===id);
    p.name=name; p.amount=amount; p.date=date; p.note=note;
  } else {
    db.preventivati.push({ id:uid(), name, amount, date, note, color: ICON_COLORS[Math.floor(Math.random()*ICON_COLORS.length)] });
  }
  saveDB(); closeModal(); renderAll(); toast('Evento salvato.');
}
function convertToAccount(id){
  const p = db.preventivati.find(x=>x.id===id);
  if(!p || !db.accounts.length) return toast('Crea prima almeno un conto.');
  openModal(`
    <h3>Segna come incassato</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">A quale conto aggiungere ${euro(p.amount)} da "${esc(p.name)}"?</p>
    <div class="field"><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confirmConvert('${id}')">Conferma incasso</button>
    </div>
  `);
}
function confirmConvert(id){
  const accId = document.getElementById('f-account').value;
  const p = db.preventivati.find(x=>x.id===id);
  const acc = db.accounts.find(x=>x.id===accId);
  acc.balance = Number(acc.balance) + Number(p.amount);
  db.movimenti.push({ id:uid(), type:'entrata', name:p.name, amount:Number(p.amount), date:oggiStr(), accountId:acc.id, category:'altro' });
  if(p.fromStipendioId){
    const st = db.stipendi.find(x=>x.id===p.fromStipendioId);
    if(st && !st.ricevuti.includes(p.fromStipendioMese)) st.ricevuti.push(p.fromStipendioMese);
  }
  db.preventivati = db.preventivati.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(p.amount)} aggiunti a ${acc.name}.`);
}

/* ==================== MANCANTI ==================== */
function renderMancanti(){
  const f = filters.mancanti;
  const total = db.mancanti.reduce((s,m)=>s+Number(m.amount),0);
  let list = [...db.mancanti];
  if(f.q) list = list.filter(m=> matches(m.name,f.q) || matches(m.note,f.q));
  document.getElementById('page-mancanti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Soldi Mancanti</div><div class="page-sub">${db.mancanti.length} voci · totale ${euro(total)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalMancante()">+ Aggiungi</button></div>
    </div>
    ${searchBar('mancanti','Cerca voce...')}
    <div class="list">
      ${list.length ? list.map(m=>{
        const isStipendio = !!m.fromStipendioId;
        return `
        <div class="row-item">
          <div class="row-icon" style="background:${isStipendio?'var(--amber-dim)':'var(--coral-dim)'}; color:${isStipendio?'var(--amber)':'var(--coral)'};">
            ${isStipendio ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>` : esc(m.name.charAt(0).toUpperCase())}
          </div>
          <div class="row-main">
            <div class="row-title">${esc(m.name)}</div>
            ${isStipendio ? `<div class="row-sub">Stima, da confermare all'accredito</div>` : (m.note?`<div class="row-sub">${esc(m.note)}</div>`:'')}
          </div>
          <div class="row-amount" style="color:var(--coral)">${euro(m.amount)}</div>
          <div class="row-actions">
            ${isStipendio ? `<button class="icon-btn" style="color:var(--mint)" title="Accredita su un conto" onclick="modalAccreditaStipendio('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button>` : `<button class="icon-btn" style="color:var(--mint)" title="Accredita su un conto" onclick="modalAccreditaMancante('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button>`}
            <button class="icon-btn" onclick="modalMancante('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('mancanti','${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>
      `;}).join('') : emptyState(db.mancanti.length ? 'Nessuna voce corrisponde alla ricerca.' : 'Nessun pagamento mancante. Ottimo segno.')}
    </div>
  `;
}
function modalAccreditaMancante(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
  openModal(`
    <h3>Accredita su conto</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">A quale conto aggiungere ${euro(m.amount)} da "${esc(m.name)}"?</p>
    <div class="field"><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confirmAccreditaMancante('${id}')">Conferma accredito</button>
    </div>
  `);
}
function confirmAccreditaMancante(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  const accId = document.getElementById('f-account').value;
  const acc = db.accounts.find(x=>x.id===accId);
  if(!acc) return toast('Seleziona un conto.');
  acc.balance = Number(acc.balance) + Number(m.amount);
  db.movimenti.push({ id:uid(), type:'entrata', name:m.name, amount:Number(m.amount), date:oggiStr(), accountId:acc.id, category:'altro' });
  db.mancanti = db.mancanti.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(m.amount)} aggiunti a ${acc.name}.`);
}
function modalAccreditaStipendio(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
  openModal(`
    <h3>Accredita stipendio</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">La stima era ${euro(m.amount)}. Inserisci l'importo esatto ricevuto per "${esc(m.name)}", perché può variare rispetto alla stima.</p>
    <div class="field"><label>Importo esatto (€)</label><input id="f-stip-esatto" type="number" step="0.01" value="${m.amount}" placeholder="0.00"></div>
    <div class="field"><label>Conto</label><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confirmAccreditaStipendio('${id}')">Conferma accredito</button>
    </div>
  `);
}
function confirmAccreditaStipendio(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  const accId = document.getElementById('f-account').value;
  const importoEsatto = parseFloat(document.getElementById('f-stip-esatto').value)||0;
  const acc = db.accounts.find(x=>x.id===accId);
  if(!acc) return toast('Seleziona un conto.');
  if(importoEsatto<=0) return toast('Inserisci un importo valido.');
  acc.balance = Number(acc.balance) + importoEsatto;
  db.movimenti.push({ id:uid(), type:'entrata', name:m.name, amount:importoEsatto, date:oggiStr(), accountId:acc.id, category:'altro' });
  if(m.fromStipendioId){
    const st = db.stipendi.find(x=>x.id===m.fromStipendioId);
    if(st && !st.ricevuti.includes(m.fromStipendioMese)) st.ricevuti.push(m.fromStipendioMese);
  }
  db.mancanti = db.mancanti.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(importoEsatto)} accreditati su ${acc.name}.`);
}
function modalMancante(id){
  const isEdit=!!id; const m = isEdit? db.mancanti.find(x=>x.id===id): null;
  openModal(`
    <h3>${isEdit?'Modifica voce':'Nuovo pagamento mancante'}</h3>
    <div class="field"><label>Descrizione</label><input id="f-name" value="${m?esc(m.name):''}" placeholder="Es. Rimborso da un amico"></div>
    <div class="field"><label>Importo (€)</label><input id="f-amount" type="number" step="0.01" value="${m?m.amount:''}" placeholder="0.00"></div>
    <div class="field"><label>Nota</label><input id="f-note" value="${m?esc(m.note||''):''}" placeholder="Opzionale"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveMancante('${id||''}')">${isEdit?'Salva':'Crea'}</button>
    </div>
  `);
}
function saveMancante(id){
  const name = document.getElementById('f-name').value.trim();
  const amount = parseFloat(document.getElementById('f-amount').value)||0;
  const note = document.getElementById('f-note').value.trim();
  if(!name) return toast('Inserisci una descrizione.');
  if(id){ const m=db.mancanti.find(x=>x.id===id); m.name=name; m.amount=amount; m.note=note; }
  else db.mancanti.push({ id:uid(), name, amount, note });
  saveDB(); closeModal(); renderAll(); toast('Salvato.');
}

/* ==================== SPESE FISSE ==================== */
function fmtMeseNome(n){
  const mesi = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
  const nome = mesi[((n-1)%12+12)%12];
  return nome.charAt(0).toUpperCase()+nome.slice(1);
}
function renderFisse(){
  const filt = filters.fisse;
  const mensile = db.fisse.reduce((s,f)=> s + (f.frequency==='annuale'? f.amount/12 : f.amount), 0);
  let list = [...db.fisse];
  if(filt.q) list = list.filter(x=> matches(x.name, filt.q));
  document.getElementById('page-fisse').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Spese fisse ricorrenti</div><div class="page-sub">${db.fisse.length} voci · impatto mensile ${euro(mensile)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalFissa()">+ Aggiungi</button></div>
    </div>
    ${searchBar('fisse','Cerca spesa fissa...')}
    <div class="list">
      ${list.length ? list.map(f=>{
        const acc = db.accounts.find(a=>a.id===f.accountId);
        const scadenza = f.frequency==='annuale' ? `ogni ${fmtMeseNome(f.mese||1)}, giorno ${f.giorno||1}` : `il giorno ${f.giorno||1} di ogni mese`;
        return `
        <div class="row-item">
          <div class="row-icon" style="background:var(--amber-dim); color:var(--amber);">${esc(f.name.charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(f.name)}</div>
            <div class="row-sub">${f.frequency==='annuale'?'Annuale':'Mensile'} · ${scadenza}${acc?` · addebito automatico da ${esc(acc.name)}`:' · nessun conto collegato, resta manuale'}</div>
          </div>
          <div class="row-amount" style="color:var(--amber)">${euro(f.amount)}</div>
          <div class="row-actions">
            <button class="icon-btn" onclick="modalFissa('${f.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('fisse','${f.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>`;
      }).join('') : emptyState(db.fisse.length ? 'Nessuna spesa fissa corrisponde alla ricerca.' : 'Nessuna spesa fissa registrata.')}
    </div>
  `;
}
function toggleFissaFreq(freq){
  document.getElementById('fissa-field-mese').style.display = freq==='annuale' ? 'block' : 'none';
}
function modalFissa(id){
  const isEdit=!!id; const f = isEdit? db.fisse.find(x=>x.id===id): null;
  const frequency = f ? f.frequency : 'mensile';
  const accOptions = (selected)=> `<option value="">Nessuno (resta manuale)</option>` + db.accounts.map(a=>`<option value="${a.id}" ${selected===a.id?'selected':''}>${esc(a.name)}</option>`).join('');
  openModal(`
    <h3>${isEdit?'Modifica spesa':'Nuova spesa fissa'}</h3>
    <div class="field"><label>Nome</label><input id="f-name" value="${f?esc(f.name):''}" placeholder="Es. Assicurazione drone"></div>
    <div class="field-row">
      <div class="field"><label>Importo (€)</label><input id="f-amount" type="number" step="0.01" value="${f?f.amount:''}" placeholder="0.00"></div>
      <div class="field"><label>Frequenza</label><select id="f-freq" onchange="toggleFissaFreq(this.value)">
        <option value="mensile" ${frequency==='mensile'?'selected':''}>Mensile</option>
        <option value="annuale" ${frequency==='annuale'?'selected':''}>Annuale</option>
      </select></div>
    </div>
    <div class="field-row">
      <div class="field" id="fissa-field-mese" style="display:${frequency==='annuale'?'block':'none'};">
        <label>Mese</label>
        <select id="f-mese">${Array.from({length:12},(_,i)=>i+1).map(m=>`<option value="${m}" ${(f&&f.mese===m)?'selected':''}>${fmtMeseNome(m)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Giorno addebito</label><input id="f-giorno" type="number" min="1" max="28" value="${f?f.giorno||1:1}"></div>
    </div>
    <div class="field">
      <label>Conto da cui prelevare</label>
      <select id="f-account">${accOptions(f?f.accountId:'')}</select>
    </div>
    <p style="color:var(--text-faint); font-size:11.5px; margin-top:6px;">Se colleghi un conto, l'importo verrà addebitato automaticamente a partire dalla prossima scadenza (non subito). Senza conto, resta solo un promemoria informativo.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveFissa('${id||''}')">${isEdit?'Salva':'Crea'}</button>
    </div>
  `);
}
function saveFissa(id){
  const name = document.getElementById('f-name').value.trim();
  const amount = parseFloat(document.getElementById('f-amount').value)||0;
  const frequency = document.getElementById('f-freq').value;
  const giorno = Math.min(28, Math.max(1, parseInt(document.getElementById('f-giorno').value)||1));
  const mese = frequency==='annuale' ? (parseInt(document.getElementById('f-mese').value)||1) : null;
  const accountId = document.getElementById('f-account').value || null;
  if(!name) return toast('Inserisci un nome.');
  const periodoCorrente = frequency==='annuale' ? meseChiave(0).slice(0,4) : meseChiave(0);
  if(id){
    const f=db.fisse.find(x=>x.id===id);
    const contoAppenaCollegato = accountId && !f.accountId;
    f.name=name; f.amount=amount; f.frequency=frequency; f.giorno=giorno;
    if(mese) f.mese=mese; else delete f.mese;
    if(accountId) f.accountId=accountId; else delete f.accountId;
    // se il conto viene collegato ora (o cambia frequenza), evita un addebito a sorpresa per il periodo in corso
    if(contoAppenaCollegato) f.ultimoAddebito = periodoCorrente;
  } else {
    const nuova = { id:uid(), name, amount, frequency, giorno };
    if(mese) nuova.mese = mese;
    if(accountId){
      nuova.accountId = accountId;
      nuova.ultimoAddebito = periodoCorrente; // niente addebito a sorpresa: parte dal prossimo periodo
    }
    db.fisse.push(nuova);
  }
  saveDB(); closeModal(); renderAll(); toast('Salvato.');
}
function checkSpeseFisseAutomatiche(){
  if(!db || !session) return;
  const oggi = new Date();
  const oggiStr = dateKeyFromDate(oggi);
  const meseCorrente = oggiStr.slice(0,7);
  const annoCorrente = oggiStr.slice(0,4);
  let changed = false;

  db.fisse.forEach(f=>{
    if(!f.accountId) return;
    const acc = db.accounts.find(a=>a.id===f.accountId);
    if(!acc) return;
    const giorno = f.giorno || 1;

    if(f.frequency==='mensile'){
      if(f.ultimoAddebito===meseCorrente) return;
      if(oggi.getDate() < giorno) return;
      acc.balance = Number(acc.balance) - Number(f.amount);
      db.movimenti.push({ id:uid(), type:'uscita', name:f.name, amount:f.amount, date:oggiStr, accountId:f.accountId, category:'altro', fromFissa:f.id });
      f.ultimoAddebito = meseCorrente;
      changed = true;
    } else if(f.frequency==='annuale'){
      const meseFissa = f.mese || 1;
      const meseOra = oggi.getMonth()+1;
      if(f.ultimoAddebito===annoCorrente) return;
      if(meseOra < meseFissa) return;
      if(meseOra===meseFissa && oggi.getDate() < giorno) return;
      acc.balance = Number(acc.balance) - Number(f.amount);
      db.movimenti.push({ id:uid(), type:'uscita', name:f.name, amount:f.amount, date:oggiStr, accountId:f.accountId, category:'altro', fromFissa:f.id });
      f.ultimoAddebito = annoCorrente;
      changed = true;
    }
  });

  if(changed) saveDB();
}

/* ==================== OBIETTIVI ==================== */
function renderObiettivi(){
  const f = filters.obiettivi;
  let list = [...db.obiettivi];
  if(f.q) list = list.filter(o=> matches(o.name,f.q));

  const totaleRisparmiato = db.obiettivi.reduce((s,o)=>s+Number(o.current||0),0);
  const totaleTarget = db.obiettivi.reduce((s,o)=>s+Number(o.target||0),0);
  const pctGlobale = totaleTarget ? Math.min(100, totaleRisparmiato/totaleTarget*100) : 0;
  const medaglieTotali = db.obiettivi.reduce((s,o)=>s+((o.medaglie||[]).length),0);

  document.getElementById('page-obiettivi').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Obiettivi finanziari</div><div class="page-sub">${db.obiettivi.length} obiettivi attivi</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalObiettivo()">+ Nuovo obiettivo</button></div>
    </div>

    ${db.obiettivi.length ? `
    <div class="grid grid-3" style="margin-bottom:24px;">
      <div class="card">
        <div class="card-title">Totale risparmiato</div>
        <div class="stat-value" style="color:var(--mint); font-size:20px;">${euro(totaleRisparmiato)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">su ${euro(totaleTarget)} di obiettivi totali</div>
      </div>
      <div class="card">
        <div class="card-title">Progresso complessivo</div>
        <div class="stat-value" style="font-size:20px;">${pctGlobale.toFixed(0)}%</div>
        <div class="progress-track" style="margin-top:8px;"><div class="progress-fill" style="width:${pctGlobale}%; background:var(--mint);"></div></div>
      </div>
      <div class="card">
        <div class="card-title">Medaglie sbloccate</div>
        <div class="stat-value" style="font-size:20px;">${medaglieTotali} 🏅</div>
        <div class="stat-trend" style="color:var(--text-faint)">traguardi raggiunti in totale</div>
      </div>
    </div>
    ` : ''}

    ${searchBar('obiettivi','Cerca obiettivo...')}
    <div class="grid grid-3">
      ${list.length ? list.map(o=>renderObiettivoCard(o)).join('') : `<div class="card" style="grid-column:1/-1;">${emptyState(db.obiettivi.length ? 'Nessun obiettivo corrisponde alla ricerca.' : 'Nessun obiettivo. Crea il primo, es. "Fondo emergenze" o "Nuovo drone".')}</div>`}
    </div>
  `;
}
function renderObiettivoCard(o){
  const pct = Math.min(100, (Number(o.current)/Number(o.target)*100)||0);
  const raggiunte = medaglieRaggiunte(pct);
  const mancano = Math.max(0, Number(o.target) - Number(o.current));
  const completato = pct>=100;
  return `<div class="card" style="${completato?`border-color:${o.color}55;`:''}">
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div class="card-title">${esc(o.name)}${completato?' 🎉':''}</div>
      <div class="row-actions">
        <button class="icon-btn" title="Storico versamenti" onclick="modalStoricoObiettivo('${o.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18M7 15l4-4 4 4 5-6"/></svg></button>
        <button class="icon-btn" onclick="modalObiettivo('${o.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn btn-danger" onclick="deleteItem('obiettivi','${o.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
      </div>
    </div>
    <div class="stat-value" style="margin-top:8px; font-size:20px;">${euro(o.current)} <span style="color:var(--text-faint); font-size:13px; font-weight:500;">/ ${euro(o.target)}</span></div>
    <div class="progress-track" style="margin-top:8px;"><div class="progress-fill" style="width:${pct}%; background:${o.color};"></div></div>
    <div class="row-sub" style="margin-top:8px;">${completato ? 'Obiettivo raggiunto!' : euro(mancano)+' mancanti'}${o.deadline?' · entro '+fmtDate(o.deadline):''}</div>
    <div style="display:flex; gap:6px; margin-top:14px;">
      ${MEDAGLIE_SOGLIE.map(s=>`
        <span title="${s}%" style="width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; flex-shrink:0; ${raggiunte.includes(s) ? `background:${o.color}22; color:${o.color}; border:1px solid ${o.color}55;` : 'background:var(--surface); color:var(--text-faint); border:1px solid var(--border-soft);'}">${raggiunte.includes(s)?'🏅':s}</span>
      `).join('')}
    </div>
    <button class="btn btn-primary" style="width:100%; justify-content:center; margin-top:14px;" onclick="modalContributoObiettivo('${o.id}')">+ Aggiungi risparmio</button>
  </div>`;
}
function modalObiettivo(id){
  const isEdit=!!id; const o = isEdit? db.obiettivi.find(x=>x.id===id): null;
  openModal(`
    <h3>${isEdit?'Modifica obiettivo':'Nuovo obiettivo'}</h3>
    <div class="field"><label>Nome</label><input id="f-name" value="${o?esc(o.name):''}" placeholder="Es. Fondo emergenze"></div>
    <div class="field-row">
      <div class="field"><label>Attuale (€)</label><input id="f-current" type="number" step="0.01" value="${o?o.current:'0'}"></div>
      <div class="field"><label>Obiettivo (€)</label><input id="f-target" type="number" step="0.01" value="${o?o.target:''}"></div>
    </div>
    <div class="field"><label>Scadenza (opzionale)</label><input id="f-deadline" type="date" value="${o?o.deadline||'':''}"></div>
    <div class="field"><label>Colore</label>
      <div class="color-picker">${ICON_COLORS.map(c=>`<div class="color-swatch ${o&&o.color===c?'selected':''}" style="background:${c}" data-color="${c}" onclick="selectColor(this)"></div>`).join('')}</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveObiettivo('${id||''}')">${isEdit?'Salva':'Crea'}</button>
    </div>
  `);
}
function saveObiettivo(id){
  const name = document.getElementById('f-name').value.trim();
  const current = parseFloat(document.getElementById('f-current').value)||0;
  const target = parseFloat(document.getElementById('f-target').value)||0;
  const deadline = document.getElementById('f-deadline').value;
  const colorEl = document.querySelector('.color-swatch.selected');
  const color = colorEl ? colorEl.dataset.color : ICON_COLORS[1];
  if(!name || !target) return toast('Inserisci nome e importo obiettivo.');
  if(id){
    const o=db.obiettivi.find(x=>x.id===id);
    o.name=name; o.current=current; o.target=target; o.deadline=deadline; o.color=color;
  } else {
    db.obiettivi.push({ id:uid(), name, current, target, deadline, color, contributi:[], medaglie:medaglieRaggiunte(Math.min(100,(current/target*100)||0)) });
  }
  saveDB(); closeModal(); renderAll(); toast('Obiettivo salvato.');
}
function modalContributoObiettivo(id){
  const o = db.obiettivi.find(x=>x.id===id);
  if(!o) return;
  openModal(`
    <h3>Aggiungi risparmio</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Per "${esc(o.name)}"</p>
    <div class="field">
      <label>Tipo</label>
      <div style="display:flex; gap:18px; margin-top:6px;">
        <label class="chip-check"><input type="radio" name="f-contrib-tipo" value="deposito" checked> Deposito</label>
        <label class="chip-check"><input type="radio" name="f-contrib-tipo" value="prelievo"> Prelievo</label>
      </div>
    </div>
    <div class="field"><label>Importo (€)</label><input id="f-contrib-amount" type="number" step="0.01" placeholder="0.00"></div>
    <div class="field">
      <label>Conto (opzionale)</label>
      <select id="f-contrib-account">
        <option value="">Nessuno, aggiorna solo il progresso</option>
        ${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}
      </select>
    </div>
    <p style="color:var(--text-faint); font-size:11.5px; margin-top:4px;">Se scegli un conto, i soldi si spostano davvero: un deposito li sottrae dal conto, un prelievo li restituisce.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaContributoObiettivo('${id}')">Conferma</button>
    </div>
  `);
}
function salvaContributoObiettivo(id){
  const o = db.obiettivi.find(x=>x.id===id);
  if(!o) return;
  const tipo = document.querySelector('input[name="f-contrib-tipo"]:checked').value;
  const amount = parseFloat(document.getElementById('f-contrib-amount').value)||0;
  const accountId = document.getElementById('f-contrib-account').value;
  if(amount<=0) return toast('Inserisci un importo valido.');

  const pctPrima = Math.min(100, (Number(o.current)/Number(o.target)*100)||0);
  o.current = tipo==='deposito' ? Number(o.current)+amount : Math.max(0, Number(o.current)-amount);

  if(accountId){
    const acc = db.accounts.find(a=>a.id===accountId);
    if(acc){
      acc.balance = Number(acc.balance) + (tipo==='deposito' ? -amount : amount);
      db.movimenti.push({ id:uid(), type: tipo==='deposito' ? 'uscita' : 'entrata', name:`${tipo==='deposito'?'Risparmio per':'Prelievo da'} ${o.name}`, amount, date:oggiStr(), accountId, category:'risparmio' });
    }
  }

  if(!o.contributi) o.contributi = [];
  o.contributi.push({ id:uid(), tipo, amount, date:oggiStr(), accountId: accountId||null });

  const pctDopo = Math.min(100, (Number(o.current)/Number(o.target)*100)||0);
  if(!o.medaglie) o.medaglie = [];
  const nuove = MEDAGLIE_SOGLIE.filter(s=> pctDopo>=s && pctPrima<s && !o.medaglie.includes(s));
  nuove.forEach(s=> o.medaglie.push(s));

  saveDB(); closeModal(); renderAll();
  if(nuove.length){
    const ultima = nuove[nuove.length-1];
    toast(ultima===100 ? `🎉 Obiettivo "${o.name}" raggiunto!` : `🏅 Hai raggiunto il ${ultima}% di "${o.name}"!`);
  } else {
    toast('Risparmio aggiornato.');
  }
}
function modalStoricoObiettivo(id){
  const o = db.obiettivi.find(x=>x.id===id);
  if(!o) return;
  const contributi = [...(o.contributi||[])].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  openModal(`
    <h3>Storico — ${esc(o.name)}</h3>
    <div class="list">
      ${contributi.length ? contributi.map(c=>{
        const acc = c.accountId ? db.accounts.find(a=>a.id===c.accountId) : null;
        const isDep = c.tipo==='deposito';
        return `<div class="row-item">
          <div class="row-icon" style="background:${isDep?'var(--mint-dim)':'var(--coral-dim)'}; color:${isDep?'var(--mint)':'var(--coral)'};">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">${isDep?'<path d="M12 19V5M5 12l7-7 7 7"/>':'<path d="M12 5v14M19 12l-7 7-7-7"/>'}</svg>
          </div>
          <div class="row-main"><div class="row-title">${isDep?'Deposito':'Prelievo'}</div><div class="row-sub">${fmtDate(c.date)}${acc?' · '+esc(acc.name):''}</div></div>
          <div class="row-amount" style="color:${isDep?'var(--mint)':'var(--coral)'}">${isDep?'+':'−'} ${euro(c.amount)}</div>
        </div>`;
      }).join('') : emptyState('Nessun versamento ancora. Usa "+ Aggiungi risparmio" per iniziare.')}
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div>
  `);
}

/* ==================== LISTA ACQUISTI ==================== */
function renderAcquisti(){
  const f = filters.acquisti;
  const pending = db.acquisti.filter(a=>!a.bought);
  const totalPending = pending.reduce((s,a)=>s+Number(a.price||0)*Number(a.qty||1),0);
  let list = db.acquisti.slice().sort((a,b)=>a.bought-b.bought);
  if(f.q) list = list.filter(a=> matches(a.name,f.q));
  document.getElementById('page-acquisti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Lista Acquisti</div><div class="page-sub">${pending.length} da comprare · ${euro(totalPending)} previsti</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalAcquisto()">+ Aggiungi</button></div>
    </div>
    ${searchBar('acquisti','Cerca articolo...')}
    <div class="list">
      ${list.length ? list.map(a=>{
        const qty = Number(a.qty||1);
        const totale = Number(a.price||0) * qty;
        const giorniRimasti = a.speseRegistrata && a.dataSpesa ? Math.max(0, 3 - Math.floor((new Date(oggiStr()) - new Date(a.dataSpesa))/86400000)) : null;
        return `
        <div class="row-item" style="${a.bought?'opacity:.65;':''}">
          <div class="chip-check"><input type="checkbox" ${a.bought?'checked':''} onchange="toggleAcquisto('${a.id}')"></div>
          <div class="row-main">
            <div class="row-title" style="${a.bought?'text-decoration:line-through;':''}">${esc(a.name)}${qty>1?` <span style="color:var(--text-faint); font-weight:500;">× ${qty}</span>`:''}</div>
            ${a.speseRegistrata ? `<div class="row-sub">Spesa registrata · verrà rimosso ${giorniRimasti===0?'oggi':'tra '+giorniRimasti+' giorn'+(giorniRimasti===1?'o':'i')}</div>` : a.priority?`<div class="row-sub">Priorità: ${esc(a.priority)}</div>`:''}
          </div>
          <div class="row-amount">${a.price?euro(totale):'—'}</div>
          <div class="row-actions">
            ${a.bought && !a.speseRegistrata ? `<button class="icon-btn" style="color:var(--coral)" title="Segna come spesa" onclick="modalSpesaAcquisto('${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg></button>` : ''}
            <button class="icon-btn" onclick="modalAcquisto('${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('acquisti','${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>
      `;}).join('') : emptyState(db.acquisti.length ? 'Nessun articolo corrisponde alla ricerca.' : 'Lista vuota. Aggiungi il primo articolo.')}
    </div>
  `;
}
function modalSpesaAcquisto(id){
  const a = db.acquisti.find(x=>x.id===id);
  if(!a) return;
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
  const totale = Number(a.price||0) * Number(a.qty||1);
  openModal(`
    <h3>Segna come spesa</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Registra ${euro(totale)} per "${esc(a.name)}" come uscita. L'articolo verrà rimosso da questa lista in automatico dopo 3 giorni.</p>
    <div class="field"><label>Conto</label><select id="f-account">${db.accounts.map(acc=>`<option value="${acc.id}">${esc(acc.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confermaSpesaAcquisto('${id}')">Registra spesa</button>
    </div>
  `);
}
function confermaSpesaAcquisto(id){
  const a = db.acquisti.find(x=>x.id===id);
  if(!a) return;
  const accId = document.getElementById('f-account').value;
  const acc = db.accounts.find(x=>x.id===accId);
  if(!acc) return toast('Seleziona un conto.');
  const totale = Number(a.price||0) * Number(a.qty||1);
  acc.balance = Number(acc.balance) - totale;
  db.movimenti.push({ id:uid(), type:'uscita', name:a.name, amount:totale, date:oggiStr(), accountId:acc.id, category:'altro' });
  a.bought = true;
  a.speseRegistrata = true;
  a.dataSpesa = oggiStr();
  saveDB(); closeModal(); renderAll(); toast('Spesa registrata: sparirà dalla lista tra 3 giorni.');
}
function checkAcquistiDaRimuovere(){
  if(!db || !session) return;
  const oggi = oggiStr();
  const prima = db.acquisti.length;
  db.acquisti = db.acquisti.filter(a=>{
    if(!a.speseRegistrata || !a.dataSpesa) return true;
    const giorni = Math.floor((new Date(oggi) - new Date(a.dataSpesa)) / 86400000);
    return giorni < 3;
  });
  if(db.acquisti.length !== prima) saveDB();
}
function modalAcquisto(id){
  const isEdit = !!id;
  const a = isEdit ? db.acquisti.find(x=>x.id===id) : null;
  openModal(`
    <h3>${isEdit?'Modifica articolo':'Nuovo articolo'}</h3>
    <div class="field"><label>Nome</label><input id="f-name" value="${a?esc(a.name):''}" placeholder="Es. Batteria drone di scorta"></div>
    <div class="field-row">
      <div class="field"><label>Quantità</label><input id="f-qty" type="number" min="1" step="1" value="${a?a.qty||1:1}"></div>
      <div class="field"><label>Prezzo unitario (€)</label><input id="f-price" type="number" step="0.01" value="${a?a.price||'':''}" placeholder="0.00"></div>
    </div>
    <div class="field"><label>Priorità</label><select id="f-priority">
      <option value="" ${a&&!a.priority?'selected':''}>—</option>
      <option value="Bassa" ${a&&a.priority==='Bassa'?'selected':''}>Bassa</option>
      <option value="Media" ${a&&a.priority==='Media'?'selected':''}>Media</option>
      <option value="Alta" ${a&&a.priority==='Alta'?'selected':''}>Alta</option>
    </select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveAcquisto('${id||''}')">${isEdit?'Salva':'Aggiungi'}</button>
    </div>
  `);
}
function saveAcquisto(id){
  const name = document.getElementById('f-name').value.trim();
  const qty = Math.max(1, parseInt(document.getElementById('f-qty').value)||1);
  const price = parseFloat(document.getElementById('f-price').value)||0;
  const priority = document.getElementById('f-priority').value;
  if(!name) return toast('Inserisci un nome.');
  if(id){
    const a = db.acquisti.find(x=>x.id===id);
    a.name=name; a.qty=qty; a.price=price; a.priority=priority;
  } else {
    db.acquisti.push({ id:uid(), name, qty, price, priority, bought:false });
  }
  saveDB(); closeModal(); renderAll(); toast(id?'Articolo aggiornato.':'Aggiunto alla lista.');
}
function toggleAcquisto(id){ const a=db.acquisti.find(x=>x.id===id); a.bought=!a.bought; saveDB(); renderAcquisti(); }

/* ==================== SIMULATORE (non tocca mai conti/movimenti reali) ==================== */
let simState = { saldo: 0, movimenti: [] };
let simInitialized = false;
function playSimIntro(){
  const el = document.getElementById('sim-intro');
  if(!el) return;
  el.style.display = 'flex';
  el.classList.remove('playing');
  void el.offsetWidth; // forza il reflow per poter ri-riprodurre l'animazione ogni volta
  el.classList.add('playing');
  clearTimeout(playSimIntro._t);
  playSimIntro._t = setTimeout(()=>{ el.style.display='none'; el.classList.remove('playing'); }, 1650);
}
function renderSimulatore(){
  const totale = simState.saldo + simState.movimenti.reduce((s,m)=> s + (m.tipo==='entrata' ? m.importo : -m.importo), 0);
  document.getElementById('page-simulatore').innerHTML = `
    <div class="sim-container">
      <div class="sim-badge">🧪 Simulazione, nessun conto reale viene toccato</div>
      <div class="topbar">
        <div><div class="page-title">Simulatore</div><div class="page-sub">Prova spese ed entrate ipotetiche in totale libertà</div></div>
        <div class="topbar-actions">
          <button class="btn" onclick="resetSimulatore()">Azzera</button>
          <button class="btn btn-primary" onclick="modalMovimentoSimulato()">+ Movimento simulato</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:24px; text-align:center; padding:32px;">
        <div class="card-title">Saldo simulato</div>
        <div class="stat-value" style="font-size:36px; margin-top:8px; color:${totale>=0?'var(--mint)':'var(--coral)'};">${euro(totale)}</div>
        <div class="row-sub" style="margin-top:8px;">Partenza <a href="#" onclick="modalSaldoPartenza(); return false;" style="color:var(--blue); font-weight:600;">${euro(simState.saldo)}</a> · ${simState.movimenti.length} movimenti simulati</div>
      </div>

      <div class="section-title">Movimenti simulati <span class="count">${simState.movimenti.length}</span></div>
      <div class="list">
        ${simState.movimenti.length ? [...simState.movimenti].reverse().map(m=>`
          <div class="row-item">
            <div class="row-icon" style="background:${m.tipo==='entrata'?'var(--mint-dim)':'rgba(255,55,95,0.14)'}; color:${m.tipo==='entrata'?'var(--mint)':'#FF375F'};">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">${m.tipo==='entrata'?'<path d="M12 19V5M5 12l7-7 7 7"/>':'<path d="M12 5v14M19 12l-7 7-7-7"/>'}</svg>
            </div>
            <div class="row-main"><div class="row-title">${esc(m.nome)}</div></div>
            <div class="row-amount" style="color:${m.tipo==='entrata'?'var(--mint)':'var(--coral)'}">${m.tipo==='entrata'?'+':'−'} ${euro(m.importo)}</div>
            <div class="row-actions">
              <button class="icon-btn btn-danger" onclick="rimuoviMovimentoSimulato('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
            </div>
          </div>
        `).join('') : emptyState("Nessun movimento simulato ancora. Prova ad aggiungere una spesa o un'entrata ipotetica.")}
      </div>
    </div>
  `;
}
function modalMovimentoSimulato(){
  openModal(`
    <h3>Movimento simulato</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Non tocca i tuoi conti reali: è solo un'ipotesi.</p>
    <div class="field">
      <label>Tipo</label>
      <div style="display:flex; gap:18px; margin-top:6px;">
        <label class="chip-check"><input type="radio" name="f-sim-tipo" value="uscita" checked> Spesa</label>
        <label class="chip-check"><input type="radio" name="f-sim-tipo" value="entrata"> Entrata</label>
      </div>
    </div>
    <div class="field"><label>Descrizione</label><input id="f-sim-nome" placeholder="Es. Nuovo obiettivo, aumento stipendio..."></div>
    <div class="field"><label>Importo (€)</label><input id="f-sim-importo" type="number" step="0.01" placeholder="0.00"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="aggiungiMovimentoSimulato()">Aggiungi</button>
    </div>
  `);
}
function aggiungiMovimentoSimulato(){
  const tipo = document.querySelector('input[name="f-sim-tipo"]:checked').value;
  const nome = document.getElementById('f-sim-nome').value.trim();
  const importo = parseFloat(document.getElementById('f-sim-importo').value)||0;
  if(!nome) return toast('Inserisci una descrizione.');
  if(importo<=0) return toast('Inserisci un importo maggiore di zero.');
  simState.movimenti.push({ id:uid(), tipo, nome, importo });
  closeModal(); renderSimulatore(); toast('Movimento simulato aggiunto.');
}
function rimuoviMovimentoSimulato(id){
  simState.movimenti = simState.movimenti.filter(m=>m.id!==id);
  renderSimulatore();
}
function modalSaldoPartenza(){
  openModal(`
    <h3>Saldo di partenza</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Da quale importo vuoi iniziare la simulazione?</p>
    <div class="field"><label>Importo (€)</label><input id="f-sim-saldo" type="number" step="0.01" value="${simState.saldo}"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaSaldoPartenza()">Salva</button>
    </div>
  `);
}
function salvaSaldoPartenza(){
  simState.saldo = parseFloat(document.getElementById('f-sim-saldo').value)||0;
  closeModal(); renderSimulatore();
}
function resetSimulatore(){
  simState = { saldo: computeTotals().totalConti, movimenti: [] };
  renderSimulatore();
  toast('Simulazione azzerata.');
}

/* ==================== ACCOUNT ==================== */
function renderAccount(){
  const user = auth.currentUser;
  const email = user ? user.email : '';
  const name = session ? session.name : '';
  const createdAt = user && user.metadata && user.metadata.creationTime
    ? new Date(user.metadata.creationTime).toLocaleDateString('it-IT',{day:'2-digit', month:'long', year:'numeric'})
    : null;

  document.getElementById('page-account').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Account</div><div class="page-sub">Gestisci il tuo profilo e i tuoi dati</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Profilo</div>
        <div class="list" style="margin-top:12px;">
          <div class="row-item">
            <div class="row-icon" style="background:var(--mint-dim); color:var(--mint);">${esc((name||'?').charAt(0).toUpperCase())}</div>
            <div class="row-main"><div class="row-title">${esc(name)}</div><div class="row-sub">${esc(email)}</div></div>
            <div class="row-actions">
              <button class="icon-btn" onclick="modalModificaNome()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            </div>
          </div>
        </div>
        ${createdAt ? `<div class="row-sub" style="margin-top:12px;">Account creato il ${createdAt}</div>` : ''}
      </div>
      <div class="card">
        <div class="card-title">Sicurezza</div>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:12px;">
          <button class="btn" style="justify-content:flex-start;" onclick="modalModificaEmail()">Modifica email</button>
          <button class="btn" style="justify-content:flex-start;" onclick="modalModificaPassword()">Modifica password</button>
          <button class="btn" style="justify-content:flex-start;" onclick="richiediResetPassword()">Invia email per reimpostare la password</button>
        </div>
      </div>
    </div>

    <div class="section-title">Zona pericolosa</div>
    <div class="card" style="border-color:rgba(255,69,58,0.3);">
      <div class="card-title" style="color:var(--coral);">Elimina account</div>
      <div class="row-sub" style="margin:6px 0 14px;">Elimina definitivamente il tuo account e tutti i dati salvati (conti, spese, stipendio, obiettivi e tutto il resto). Questa azione non è reversibile.</div>
      <button class="btn btn-danger" style="border-color:rgba(255,69,58,0.35);" onclick="modalEliminaAccount()">Elimina il mio account</button>
    </div>
  `;
}
function modalModificaNome(){
  openModal(`
    <h3>Modifica nome</h3>
    <div class="field"><label>Nome visualizzato</label><input id="f-acc-nome" value="${esc(session.name)}" placeholder="Il tuo nome"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaNome()">Salva</button>
    </div>
  `);
}
async function salvaNome(){
  const nome = document.getElementById('f-acc-nome').value.trim();
  if(!nome) return toast('Inserisci un nome.');
  try{
    await updateProfile(auth.currentUser, { displayName: nome });
    session.name = nome;
    document.getElementById('user-name-display').textContent = nome;
    document.getElementById('user-avatar').textContent = nome.charAt(0).toUpperCase();
    closeModal(); renderAccount(); toast('Nome aggiornato.');
  }catch(err){
    console.error(err);
    toast(friendlyAuthError(err.code));
  }
}
async function reauthenticate(passwordCorrente){
  const cred = EmailAuthProvider.credential(auth.currentUser.email, passwordCorrente);
  await reauthenticateWithCredential(auth.currentUser, cred);
}
function modalModificaEmail(){
  openModal(`
    <h3>Modifica email</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Per sicurezza conferma la password attuale.</p>
    <div class="field"><label>Nuova email</label><input id="f-acc-email" type="email" value="${esc(auth.currentUser.email)}"></div>
    <div class="field"><label>Password attuale</label><input id="f-acc-pass-corrente" type="password" placeholder="••••••••"></div>
    <div class="login-error" id="acc-error" style="display:none;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaEmail()">Salva</button>
    </div>
  `);
}
async function salvaEmail(){
  const nuovaEmail = document.getElementById('f-acc-email').value.trim();
  const passwordCorrente = document.getElementById('f-acc-pass-corrente').value;
  const errBox = document.getElementById('acc-error');
  errBox.style.display='none';
  if(!nuovaEmail || !passwordCorrente) return toast('Compila tutti i campi.');
  try{
    await reauthenticate(passwordCorrente);
    await updateEmail(auth.currentUser, nuovaEmail);
    closeModal(); renderAccount(); toast('Email aggiornata.');
  }catch(err){
    console.error(err);
    errBox.textContent = friendlyAuthError(err.code);
    errBox.style.display='block';
  }
}
function modalModificaPassword(){
  openModal(`
    <h3>Modifica password</h3>
    <div class="field"><label>Password attuale</label><input id="f-acc-pass-corrente" type="password" placeholder="••••••••"></div>
    <div class="field"><label>Nuova password</label><input id="f-acc-pass-nuova" type="password" placeholder="Almeno 6 caratteri"></div>
    <div class="login-error" id="acc-error" style="display:none;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaPassword()">Salva</button>
    </div>
  `);
}
async function salvaPassword(){
  const passwordCorrente = document.getElementById('f-acc-pass-corrente').value;
  const passwordNuova = document.getElementById('f-acc-pass-nuova').value;
  const errBox = document.getElementById('acc-error');
  errBox.style.display='none';
  if(!passwordCorrente || !passwordNuova) return toast('Compila tutti i campi.');
  try{
    await reauthenticate(passwordCorrente);
    await updatePassword(auth.currentUser, passwordNuova);
    closeModal(); toast('Password aggiornata.');
  }catch(err){
    console.error(err);
    errBox.textContent = friendlyAuthError(err.code);
    errBox.style.display='block';
  }
}
async function richiediResetPassword(){
  try{
    await sendPasswordResetEmail(auth, auth.currentUser.email);
    toast('Email per reimpostare la password inviata.');
  }catch(err){
    console.error(err);
    toast(friendlyAuthError(err.code));
  }
}
function modalEliminaAccount(){
  openModal(`
    <h3 style="color:var(--coral);">Elimina account</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Questa azione elimina definitivamente il tuo account e tutti i dati salvati: conti, spese, stipendio, obiettivi e tutto il resto. Non si può annullare.</p>
    <div class="field"><label>Password attuale</label><input id="f-acc-pass-elimina" type="password" placeholder="••••••••"></div>
    <div class="chip-check" style="margin:14px 0;"><input type="checkbox" id="f-acc-conferma"><label for="f-acc-conferma" style="cursor:pointer; font-size:13px;">Ho capito, elimina definitivamente il mio account</label></div>
    <div class="login-error" id="acc-error" style="display:none;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-danger" style="border-color:var(--coral);" onclick="confermaEliminaAccount()">Elimina account</button>
    </div>
  `);
}
async function confermaEliminaAccount(){
  const password = document.getElementById('f-acc-pass-elimina').value;
  const confermato = document.getElementById('f-acc-conferma').checked;
  const errBox = document.getElementById('acc-error');
  errBox.style.display='none';
  if(!password) return toast('Inserisci la password attuale.');
  if(!confermato) return toast('Conferma la casella prima di procedere.');
  try{
    const uid = auth.currentUser.uid;
    await reauthenticate(password);
    await fbDeleteUserData(uid);
    await deleteUser(auth.currentUser);
    closeModal();
    session = null;
    document.getElementById('app').classList.remove('active');
    document.getElementById('login-screen').style.display='flex';
    toast('Account eliminato.');
  }catch(err){
    console.error(err);
    errBox.textContent = friendlyAuthError(err.code);
    errBox.style.display='block';
  }
}

/* ==================== SHARED DELETE ==================== */
function deleteItem(collection, id){
  db[collection] = db[collection].filter(x=>x.id!==id);
  saveDB(); renderAll(); toast('Eliminato.');
}
