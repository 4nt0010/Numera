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
  // Uniamo sempre ai default di seedDB(): i documenti salvati prima dell'introduzione
  // di un nuovo campo (es. "tasks") non lo contengono, e senza questo merge
  // db.tasks sarebbe undefined, mandando in errore i renderer e lasciando le
  // pagine vuote per gli utenti già esistenti.
  return snap.exists() ? { ...seedDB(), ...snap.data() } : seedDB();
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
    tasks: [],
    stipendi: [],
    movimenti: [],
    budget: {},
    oreSettimanali: 40,
    risparmiatoRinunce: 0,
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
function isMobileView(){ return window.innerWidth <= 900 && window.innerHeight > window.innerWidth; }
let _resizeTimer;
window.addEventListener('resize', ()=>{
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(()=>{
    const activePage = document.querySelector('.page.active');
    if(activePage && activePage.id==='page-dashboard' && typeof renderDashboard==='function') renderDashboard();
  }, 200);
});
setInterval(()=>{
  const activePage = document.querySelector('.page.active');
  if(activePage && activePage.id==='page-acquisti' && typeof renderAcquisti==='function' && db) renderAcquisti();
}, 60000);

/* ---------------- state ---------------- */
let db = null;
let session = null;
let snapshots = [];
let filters = {
  spese: { q:'', cat:'', acc:'', tipo:'' },
  preventivati: { q:'' },
  mancanti: { q:'' },
  fisse: { q:'' },
  clienti: { q:'' },
  acquisti: { q:'' },
  conti: { q:'' },
  task: { q:'', prev:'' },
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
    : 'Accedi al tuo cockpit finanziario per gestire preventivi, conti e clienti.';
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
  if(!db.oreSettimanali) db.oreSettimanali = 40;
  if(!db.risparmiatoRinunce) db.risparmiatoRinunce = 0;
  if(!db.tasks) db.tasks = [];
  snapshots = await fbLoadSnapshots(userId);
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').classList.add('active');
  document.getElementById('user-name-display').textContent = name;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
  saveDB();
  renderAll();
  animaEntrata('dashboard');
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
  animaEntrata(pageKey);
  const mainEl = document.querySelector('.main');
  mainEl.classList.toggle('dash-active', pageKey==='dashboard');

  // la visibilità del contenitore mobile della Dashboard è decisa dal CSS (.dash-active),
  // qui serve solo assicurarsi che il contenuto sia aggiornato quando ci si naviga sopra.
  if(pageKey==='dashboard' && isMobileView()){
    renderDashboard();
  }

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

// effetto di comparsa: solo quando si cambia pagina, non a ogni aggiornamento dei dati
let _enterTimer;
function animaEntrata(pageKey){
  const els = [document.getElementById('page-'+pageKey), pageKey==='dashboard' ? document.getElementById('mobile-dash-root') : null].filter(Boolean);
  els.forEach(el=>{ el.classList.remove('page-enter'); void el.offsetWidth; el.classList.add('page-enter'); });
  clearTimeout(_enterTimer);
  _enterTimer = setTimeout(()=> els.forEach(el=>el.classList.remove('page-enter')), 900);
}
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
  const ritardo = p=> typeof prevInRitardo==='function' && prevInRitardo(p);
  const totalPrev = db.preventivati.filter(p=>!ritardo(p)).reduce((s,a)=>s+Number(a.amount||0),0);
  const totalMancanti = db.mancanti.reduce((s,a)=>s+Number(a.amount||0),0) + db.preventivati.filter(ritardo).reduce((s,a)=>s+Number(a.amount||0),0);
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
function getStipendioMensileTotale(){
  return db.stipendi.reduce((s,st)=> s + Number(st.base||0), 0);
}
function getTariffaOraria(){
  const mensile = getStipendioMensileTotale();
  const oreSett = Number(db.oreSettimanali) || 40;
  if(!mensile || !oreSett) return 0;
  const oreMensili = oreSett * 4.345; // media di settimane in un mese
  return mensile / oreMensili;
}
function oreLavoroTesto(prezzo){
  const tariffa = getTariffaOraria();
  if(!tariffa || !prezzo) return null;
  const ore = prezzo / tariffa;
  if(ore < 1) return Math.round(ore*60) + ' min di lavoro';
  if(ore < 10) return ore.toFixed(1).replace(/\.0$/,'') + ' h di lavoro';
  return Math.round(ore) + ' h di lavoro';
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
document.addEventListener('keydown', (e)=>{
  if(e.key!=='Escape') return;
  if(document.getElementById('modal-overlay').classList.contains('active')) closeModal();
  else if(typeof prevDrawerId!=='undefined' && prevDrawerId) closePrevDrawer();
});
const overlay = document.getElementById('modal-overlay');
const modalEl = document.getElementById('modal-content');
function openModal(html){ modalEl.className = 'modal'; modalEl.innerHTML = html; overlay.classList.add('active'); }
function closeModal(){ overlay.classList.remove('active'); modalEl.innerHTML=''; }
overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeModal(); });

/* ==================== RENDER ALL ==================== */
const RENDER_MAP = {
  spese: ()=>renderSpese(),
  preventivati: ()=>renderPreventivati(),
  mancanti: ()=>renderMancanti(),
  fisse: ()=>renderFisse(),
  clienti: ()=>renderClienti(),
  acquisti: ()=>renderAcquisti(),
  conti: ()=>renderConti(),
  task: ()=>renderTask(),
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
  if(evs.length===1) return openPrevDrawer(evs[0].id);
  openModal(`
    <h3>${fmtDate(dataStr)}</h3>
    <div class="list">
      ${evs.map(p=>`
        <div class="row-item" style="cursor:pointer;" onclick="closeModal(); openPrevDrawer('${p.id}')">
          <div class="row-icon" style="background:${p.color}1f; color:${p.color};">${esc(p.name.charAt(0).toUpperCase())}</div>
          <div class="row-main"><div class="row-title">${esc(p.name)}</div>${p.note?`<div class="row-sub">${esc(p.note)}</div>`:''}</div>
          <div class="row-amount">${euro(p.amount)}</div>
        </div>
      `).join('')}
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div>
  `);
}

function renderAll(){
  db.preventivati.forEach(migratePrev);
  checkStipendioAutomatico();
  checkPreventivatiScaduti();
  checkSpeseFisseAutomatiche();
  checkAcquistiDaRimuovere();
  db.preventivati.forEach(migratePrev);
  const renderers = [renderKpiBar, renderDashboard, renderConti, renderSpese, renderStipendio, renderPreventivati, renderMancanti, renderFisse, renderClienti, renderAcquisti, renderTask, renderAccount, renderPrevDrawer];
  renderers.forEach(fn=>{
    try{ fn(); }
    catch(err){ console.error(`Errore in ${fn.name}:`, err); }
  });
  updateBadge();
}
function updateBadge(){
  const b = document.getElementById('badge-mancanti');
  const nMan = db.mancanti.length + prevMancanti().length;
  b.textContent = nMan || '';
  b.style.display = nMan ? 'inline-block' : 'none';

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

  const taskPendenti = db.tasks.filter(t=>!t.done);
  const bt = document.getElementById('badge-task');
  bt.textContent = taskPendenti.length || '';
  bt.style.display = taskPendenti.length ? 'inline-block' : 'none';
}

/* ==================== DASHBOARD ==================== */
let chartTrend, chartBreakdown;
/* ==================== DASHBOARD ====================
   Blocchi costruiti una volta (dashBlocks) e disposti in due modi:
   - desktop: griglia 12 colonne
   - mobile: stile app bancaria (saldo, carte conti scorrevoli, azioni rapide, liste brevi)
====================================================== */
const ICO = {
  down:'<path d="M12 5v14M5 12l7 7 7-7"/>',
  up:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  swap:'<path d="M7 7h11M18 7l-4-4M18 7l-4 4M17 17H6M6 17l4 4M6 17l4-4"/>',
  doc:'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  check:'<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
  card:'<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  repeat:'<path d="M17 2l4 4-4 4M3 12v-2a4 4 0 014-4h14M7 22l-4-4 4-4M21 12v2a4 4 0 01-4 4H3"/>',
  cart:'<path d="M6 2l1.5 4M18 2l-1.5 4M3.5 8h17l-1.6 9.6a2 2 0 01-2 1.7H7.1a2 2 0 01-2-1.7L3.5 8z"/>',
  cash:'<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/>',
  flask:'<path d="M9 2v6L4 18a2 2 0 002 3h12a2 2 0 002-3l-5-10V2M9 2h6M8 15h8"/>',
  users:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>',
};
function svgI(name, size){ return `<svg viewBox="0 0 24 24" width="${size||18}" height="${size||18}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICO[name]}</svg>`; }
const ADD_ACTIONS = [
  { label:'Spesa', fn:"modalMovimento(null,'uscita')", bg:'rgba(255,55,95,0.14)', color:'#FF375F', ico:'down' },
  { label:'Entrata', fn:"modalMovimento(null,'entrata')", bg:'var(--mint-dim)', color:'var(--mint)', ico:'up' },
  { label:'Preventivo', fn:'modalPreventivato()', bg:'var(--blue-dim)', color:'var(--blue)', ico:'doc' },
  { label:'Task', fn:'modalTask()', bg:'rgba(48,209,88,0.14)', color:'var(--mint)', ico:'check' },
  { label:'Trasferimento', fn:"modalMovimento(null,'trasferimento')", bg:'var(--blue-dim)', color:'var(--blue)', ico:'swap' },
  { label:'Conto', fn:'modalAccount()', bg:'var(--mint-dim)', color:'var(--mint)', ico:'card' },
  { label:'Mancante', fn:'modalMancante()', bg:'var(--coral-dim)', color:'var(--coral)', ico:'alert' },
  { label:'Spesa fissa', fn:'modalFissa()', bg:'var(--amber-dim)', color:'var(--amber)', ico:'repeat' },
  { label:'Acquisto', fn:'modalAcquisto()', bg:'rgba(79,209,232,0.14)', color:'#4FD1E8', ico:'cart' },
];
function toggleAddMenu(e){ e.stopPropagation(); document.getElementById('add-menu')?.classList.toggle('open'); }
document.addEventListener('click', ()=> document.getElementById('add-menu')?.classList.remove('open'));

function plur(n, sing, plu){ return `${n} ${n===1?sing:plu}`; }
function dashLink(label, page){ return `<button class="dash-link" onclick="goToPage('${page}')">${label} →</button>`; }
const ICO_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M20 6L9 17l-5-5"/></svg>';
function dashTrend(){
  const snaps = getSnapshots();
  const totalConti = computeTotals().totalConti;
  if(snaps.length < 2) return null;
  const cutoff = Date.now() - 30*86400000;
  const past = snaps.filter(s=> new Date(s.date).getTime() <= cutoff);
  const ref = past.length ? past[past.length-1] : snaps[0];
  const abs = totalConti - ref.total;
  return { abs, pct: ref.total ? abs/Math.abs(ref.total)*100 : null };
}

function dashData(){
  const T = computeTotals();
  const meseCorrente = meseKeyFromDate(new Date());
  const delMese = db.movimenti.filter(m=>(m.date||'').slice(0,7)===meseCorrente && !m.rettifica);
  const uscite = delMese.filter(m=>m.type==='uscita').reduce((s,m)=>s+Number(m.amount),0);
  const entrate = delMese.filter(m=>m.type==='entrata').reduce((s,m)=>s+Number(m.amount),0);
  const perCat = {};
  delMese.filter(m=>m.type==='uscita').forEach(m=>{ const k=m.category||'altro'; perCat[k]=(perCat[k]||0)+Number(m.amount); });
  const topCat = CATEGORIE.filter(c=>perCat[c.key]).sort((a,b)=>perCat[b.key]-perCat[a.key]).slice(0,4);
  const prevSeguire = db.preventivati.filter(p=>!isPrevAuto(p) && ['accettato','inviato'].includes(p.stato))
    .sort((a,b)=> (prevInRitardo(b)-prevInRitardo(a)) || (a.date||'2100').localeCompare(b.date||'2100')).slice(0,4);
  const tasks = db.tasks.filter(t=>!t.done).sort((a,b)=>(a.dueDate||'2100').localeCompare(b.dueDate||'2100')).slice(0,5);
  const recenti = db.movimenti.map((m,i)=>({m,i})).sort((a,b)=>{ const c=(b.m.date||'').localeCompare(a.m.date||''); return c!==0?c:b.i-a.i; }).slice(0,5).map(x=>x.m);
  return { ...T, trend:dashTrend(), meseCorrente, uscite, entrate, perCat, topCat, prevSeguire, tasks, recenti };
}

function dashBlocks(D){
  const maxCat = D.topCat.length ? Math.max(...D.topCat.map(c=>Math.max(D.perCat[c.key], db.budget[c.key]||0))) : 1;
  const trendHtml = D.trend
    ? `<span class="dash-trend ${D.trend.abs>=0?'up':'down'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="${D.trend.abs>=0?'M5 12l5-5 4 4 5-6':'M5 6l5 5 4-4 5 6'}"/></svg>${D.trend.abs>=0?'+':'−'}${euro(Math.abs(D.trend.abs))}${D.trend.pct!==null?` · ${Math.abs(D.trend.pct).toFixed(1)}%`:''} in 30 giorni</span>`
    : `<span class="dash-trend flat">L'andamento compare dopo qualche giorno di utilizzo</span>`;
  const accettati = db.preventivati.filter(p=>!isPrevAuto(p) && p.stato==='accettato').length;

  const hero = `
    <div class="card dash-card dash-hero">
      <div class="dash-hero-top">
        <div><div class="dash-hero-label">Saldo sui conti</div><div class="dash-hero-amount">${euro(D.totalConti)}</div></div>
        ${trendHtml}
      </div>
      <div class="dash-hero-chart"><canvas id="chart-trend"></canvas></div>
      <div class="dash-hero-stats">
        <button class="dash-hero-stat" onclick="goToPage('preventivati')">
          <div class="dash-hero-stat-label"><i style="background:var(--blue)"></i>Preventivato</div>
          <div class="dash-hero-stat-value" style="color:var(--blue)">${euro(D.totalPrev)}</div>
          <div class="dash-hero-stat-hint">${plur(accettati,'preventivo accettato','preventivi accettati')}</div>
        </button>
        <button class="dash-hero-stat" onclick="goToPage('mancanti')">
          <div class="dash-hero-stat-label"><i style="background:var(--coral)"></i>Mancanti</div>
          <div class="dash-hero-stat-value" style="color:var(--coral)">${euro(D.totalMancanti)}</div>
          <div class="dash-hero-stat-hint">in ritardo o da recuperare</div>
        </button>
        <div class="dash-hero-stat" style="cursor:default;">
          <div class="dash-hero-stat-label"><i style="background:var(--text)"></i>Totale previsto</div>
          <div class="dash-hero-stat-value">${euro(D.totaleGenerale)}</div>
          <div class="dash-hero-stat-hint">conti + in arrivo</div>
        </div>
      </div>
    </div>`;

  const mese = `
    <div class="card dash-card">
      <div class="dash-card-head"><div class="dash-card-title">${fmtMese(D.meseCorrente)}</div>${dashLink('Spese','spese')}</div>
      <div class="month-stats">
        <div class="month-stat"><div class="month-stat-label">Uscite</div><div class="month-stat-value" style="color:var(--coral)">${euro(D.uscite)}</div></div>
        <div class="month-stat"><div class="month-stat-label">Entrate</div><div class="month-stat-value" style="color:var(--mint)">${euro(D.entrate)}</div></div>
        <div class="month-stat"><div class="month-stat-label">Netto</div><div class="month-stat-value" style="color:${D.entrate-D.uscite>=0?'var(--text)':'var(--coral)'}">${euro(D.entrate-D.uscite)}</div></div>
      </div>
      ${D.topCat.length ? `<div class="mini-list">${D.topCat.map(c=>{
        const lim = db.budget[c.key]||0, sp = D.perCat[c.key], over = lim && sp>lim;
        return `<div class="mini-row" style="display:block;">
          <div style="display:flex; justify-content:space-between; gap:10px; font-size:12.5px;">
            <span style="font-weight:600;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${c.color}; margin-right:7px;"></span>${esc(c.label)}</span>
            <span class="mini-amount" style="font-size:12.5px; ${over?'color:var(--coral)':''}">${euro(sp)}${lim?` <span style="color:var(--text-faint); font-weight:500;">/ ${euro(lim)}</span>`:''}</span>
          </div>
          <div class="mini-bar"><div style="width:${Math.min(100, sp/(lim||maxCat)*100)}%; background:${over?'var(--coral)':c.color};"></div></div>
        </div>`;}).join('')}</div>`
      : `<div class="empty-mini">Nessuna spesa questo mese. <button onclick="modalMovimento(null,'uscita')">Registrane una</button></div>`}
    </div>`;

  const preventivi = `
    <div class="card dash-card">
      <div class="dash-card-head"><div class="dash-card-title">Preventivi da seguire <span class="count">${D.prevSeguire.length}</span></div>${dashLink('Tutti','preventivati')}</div>
      ${D.prevSeguire.length ? `<div class="mini-list">${D.prevSeguire.map(p=>{
        const st = prevStats(p), ts = prevTaskStats(p.id), rit = prevInRitardo(p);
        return `<div class="mini-row clickable" onclick="openPrevDrawer('${p.id}')">
          <div class="mini-dot" style="background:${p.color}22; color:${p.color};">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
          <div class="mini-main">
            <div class="mini-title">${esc(p.name)}</div>
            <div class="mini-sub">${p.stato==='inviato'?'<span style="color:var(--blue)">In attesa di risposta</span>':rit?'<span style="color:var(--coral)">Mancante · lavoro già svolto</span>':quandoTesto(p.date)}${p.cliente?' · '+esc(p.cliente):''}${ts.n?` · ${ts.fatte}/${ts.n} lavori`:''}</div>
          </div>
          <div class="mini-amount" style="color:${p.stato==='inviato'?'var(--text-dim)':rit?'var(--coral)':'var(--blue)'}">${euro(p.stato==='inviato'?st.totale:st.residuo)}</div>
        </div>`;}).join('')}</div>`
      : `<div class="empty-mini">Nessun preventivo in corso. <button onclick="modalPreventivato()">Crea un preventivo</button></div>`}
    </div>`;

  const task = `
    <div class="card dash-card">
      <div class="dash-card-head"><div class="dash-card-title">Da fare <span class="count">${db.tasks.filter(t=>!t.done).length}</span></div>${dashLink('Tutte','task')}</div>
      ${D.tasks.length ? `<div class="mini-list">${D.tasks.map(t=>{
        const ev = t.prevId ? db.preventivati.find(p=>p.id===t.prevId) : null;
        const over = t.dueDate && daysUntil(t.dueDate)<0;
        const subs = t.subtasks||[], sf = subs.filter(s=>s.done).length;
        return `<div class="mini-row">
          <button class="mini-check" title="Completa" onclick="toggleTaskEvento('${t.id}')">${ICO_CHECK}</button>
          <div class="mini-main" style="cursor:pointer;" onclick="${ev?`openPrevDrawer('${ev.id}')`:`modalTask('${t.id}')`}">
            <div class="mini-title">${esc(t.text)}</div>
            <div class="mini-sub">${ev?`<span style="color:var(--blue)">${esc(ev.name)}</span>`:'Generale'}${subs.length?` · ${sf}/${subs.length}`:''}${t.dueDate?` · <span style="${over?'color:var(--coral)':''}">${over?'scaduta ':''}${fmtDate(t.dueDate)}</span>`:''}</div>
          </div>
          ${t.priority==='Alta'?`<span class="pill" style="background:var(--coral-dim); color:var(--coral);">Alta</span>`:''}
        </div>`;}).join('')}</div>`
      : `<div class="empty-mini">Niente da fare. Ottimo!</div>`}
      <div class="quick-task">
        <input id="dash-task-input" placeholder="Aggiungi al volo una task…" onkeydown="if(event.key==='Enter'){aggiungiTaskDashboard()}">
        <button class="btn btn-primary" style="padding:8px 14px;" onclick="aggiungiTaskDashboard()">+</button>
      </div>
    </div>`;

  const conti = `
    <div class="card dash-card">
      <div class="dash-card-head"><div class="dash-card-title">Conti <span class="count">${db.accounts.length}</span></div>${dashLink('Gestisci','conti')}</div>
      ${db.accounts.length ? `<div class="mini-list">${db.accounts.map(a=>{
        const pct = D.totalConti>0 ? Math.max(0, Number(a.balance)/D.totalConti*100) : 0;
        return `<div class="mini-row" style="display:block;">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="mini-dot" style="width:30px; height:30px; background:${a.color}22; color:${a.color}; font-size:11px;">${esc(a.icon||a.name.slice(0,2))}</div>
            <div class="mini-main"><div class="mini-title">${esc(a.name)}</div></div>
            <div class="mini-amount">${euro(a.balance)}</div>
          </div>
          <div class="mini-bar"><div style="width:${pct}%; background:${a.color};"></div></div>
        </div>`;}).join('')}</div>`
      : `<div class="empty-mini">Nessun conto. <button onclick="modalAccount()">Aggiungi il primo</button></div>`}
    </div>`;

  const movimenti = `
    <div class="card dash-card">
      <div class="dash-card-head"><div class="dash-card-title">Ultimi movimenti</div>${dashLink('Tutti','spese')}</div>
      ${D.recenti.length ? `<div class="mini-list">${D.recenti.map(m=>{
        const tr = m.type==='trasferimento', us = m.type==='uscita';
        const acc = !tr ? db.accounts.find(a=>a.id===m.accountId) : null;
        const cat = !tr && m.category ? catInfo(m.category) : null;
        return `<div class="mini-row">
          <div class="mini-dot" style="background:${tr?'var(--blue-dim)':us?'rgba(255,55,95,0.14)':'var(--mint-dim)'}; color:${tr?'var(--blue)':us?'#FF375F':'var(--mint)'};">${svgI(tr?'swap':us?'down':'up',14)}</div>
          <div class="mini-main"><div class="mini-title">${esc(m.name)}</div><div class="mini-sub">${fmtDate(m.date)}${acc?' · '+esc(acc.name):''}${cat?' · '+esc(cat.label):''}</div></div>
          <div class="mini-amount" style="color:${tr?'var(--blue)':us?'var(--coral)':'var(--mint)'}">${tr?'':us?'−':'+'} ${euro(m.amount)}</div>
        </div>`;}).join('')}</div>`
      : `<div class="empty-mini">Nessun movimento. <button onclick="modalMovimento(null,'uscita')">Registra il primo</button></div>`}
    </div>`;

  const fisseMese = db.fisse.reduce((s,a)=> s + (a.frequency==='annuale' ? a.amount/12 : a.amount), 0);
  const acqPend = db.acquisti.filter(a=>!a.bought);
  const ricorrenti = `
    <div class="card dash-card">
      <div class="dash-card-head"><div class="dash-card-title">Ricorrenti e acquisti</div></div>
      <div class="mini-list">
        <div class="mini-row clickable" onclick="goToPage('fisse')">
          <div class="mini-dot" style="background:var(--amber-dim); color:var(--amber);">${svgI('repeat',14)}</div>
          <div class="mini-main"><div class="mini-title">Spese fisse</div><div class="mini-sub">${plur(db.fisse.length,'voce ricorrente','voci ricorrenti')}</div></div>
          <div class="mini-amount" style="color:var(--amber)">${euro(fisseMese)}<span style="color:var(--text-faint); font-weight:500; font-size:11px;">/mese</span></div>
        </div>
        <div class="mini-row clickable" onclick="goToPage('acquisti')">
          <div class="mini-dot" style="background:rgba(79,209,232,0.14); color:#4FD1E8;">${svgI('cart',14)}</div>
          <div class="mini-main"><div class="mini-title">Lista acquisti</div><div class="mini-sub">${acqPend.length} da comprare</div></div>
          <div class="mini-amount">${euro(acqPend.reduce((s,a)=>s+Number(a.price||0)*Number(a.qty||1),0))}</div>
        </div>
      </div>
    </div>`;
  return { hero, mese, preventivi, task, conti, movimenti, ricorrenti };
}

function aggiungiTaskDashboard(){
  const input = document.getElementById('dash-task-input');
  const text = input ? input.value.trim() : ''; if(!text) return;
  db.tasks.push({ id:uid(), text, note:'', priority:'', dueDate:'', done:false, subtasks:[], prevId:null, prevNome:'' });
  saveDB(); renderAll(); toast('Task aggiunta.');
  document.getElementById('dash-task-input')?.focus();
}

function renderDashboard(){
  const D = dashData();
  const B = dashBlocks(D);
  const dashboardIsActivePage = document.getElementById('page-dashboard').classList.contains('active');
  const nome = session ? session.name : '';
  const oggiLungo = (d=>d.charAt(0).toUpperCase()+d.slice(1))(new Date().toLocaleDateString('it-IT',{ weekday:'long', day:'numeric', month:'long' }));

  if(isMobileView()){
    document.getElementById('page-dashboard').innerHTML = '';
    const rootEl = document.getElementById('mobile-dash-root');
    if(!dashboardIsActivePage){ rootEl.innerHTML = ''; return; }
    rootEl.innerHTML = mobileDashHtml(D, B, nome, oggiLungo);
    return;
  }

  document.getElementById('mobile-dash-root').innerHTML = '';
  document.getElementById('page-dashboard').innerHTML = `
    <div class="dash-head">
      <div><div class="page-title">Ciao ${esc(nome)}</div><div class="page-sub">${oggiLungo}</div></div>
      <div class="dash-head-actions">
        <button class="btn" onclick="modalMovimento(null,'entrata')">${svgI('up',14)}Entrata</button>
        <button class="btn btn-primary" onclick="modalMovimento(null,'uscita')">${svgI('down',14)}Spesa</button>
        <div class="add-menu" id="add-menu">
          <button class="btn" onclick="toggleAddMenu(event)">+ Aggiungi <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button>
          <div class="add-menu-pop" onclick="event.stopPropagation()">
            ${ADD_ACTIONS.slice(2).map(a=>`<button onclick="document.getElementById('add-menu').classList.remove('open'); ${a.fn}"><span class="qa-icon" style="background:${a.bg}; color:${a.color};">${svgI(a.ico,13)}</span>${a.label}</button>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <div class="dash-grid">
      <div class="span-8">${B.hero}</div>
      <div class="span-4">${B.conti}</div>
      <div class="span-4">${B.preventivi}</div>
      <div class="span-4">${B.task}</div>
      <div class="span-4">${B.mese}</div>
      <div class="span-7">${B.movimenti}</div>
      <div class="span-5">${B.ricorrenti}</div>
    </div>
  `;
  drawTrendChart(getSnapshots());
}

/* ---------- dashboard mobile: stile app bancaria ---------- */
function mobileDashHtml(D, B, nome, oggiLungo){
  const iniziale = (nome||'?').charAt(0).toUpperCase();
  const tr = D.trend;
  const prevAcc = db.preventivati.filter(p=>!isPrevAuto(p) && p.stato==='accettato');
  return `
    <div class="m-hero">
      <div class="m-hero-top">
        <button class="m-avatar" onclick="goToPage('account')">${esc(iniziale)}</button>
        <div class="m-hello"><div>Ciao ${esc(nome)}</div><span>${oggiLungo}</span></div>
        <button class="m-icon-btn" onclick="openSidebar()" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
      </div>
      <div class="m-balance-label">Saldo sui conti</div>
      <div class="m-balance">${euro(D.totalConti)}</div>
      ${tr ? `<div class="hero-balance-trend ${tr.abs>=0?'up':'down'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="${tr.abs>=0?'M5 12l5-5 4 4 5-6':'M5 6l5 5 4-4 5 6'}"/></svg>${tr.abs>=0?'+':'−'}${euro(Math.abs(tr.abs))} in 30 giorni</div>` : ''}
      <div class="m-actions">
        <button class="m-action primary" onclick="modalMovimento(null,'uscita')"><span>${svgI('down',18)}</span>Spesa</button>
        <button class="m-action" onclick="modalMovimento(null,'entrata')"><span>${svgI('up',18)}</span>Entrata</button>
        <button class="m-action" onclick="modalMovimento(null,'trasferimento')"><span>${svgI('swap',18)}</span>Sposta</button>
        <button class="m-action" onclick="modalPreventivato()"><span>${svgI('doc',18)}</span>Preventivo</button>
      </div>
    </div>

    <div class="m-sheet">
      ${db.accounts.length ? `
      <div class="m-section-head"><span>I tuoi conti</span><button class="dash-link" onclick="goToPage('conti')">Gestisci →</button></div>
      <div class="m-cards">
        ${db.accounts.map(a=>`
          <button class="m-acc-card" style="--acc:${a.color}" onclick="modalAccount('${a.id}')">
            <div class="m-acc-top"><span class="m-acc-chip">${esc(a.icon||a.name.slice(0,2))}</span><span class="m-acc-name">${esc(a.name)}</span></div>
            <div class="m-acc-bal">${euro(a.balance)}</div>
            <div class="m-acc-share">${D.totalConti>0?Math.round(Math.max(0,a.balance)/D.totalConti*100):0}% del totale</div>
          </button>`).join('')}
        <button class="m-acc-card add" onclick="modalAccount()"><span>+</span>Nuovo conto</button>
      </div>` : `<button class="m-empty-cta" onclick="modalAccount()">+ Aggiungi il tuo primo conto</button>`}

      <div class="m-stats">
        <button class="m-stat" onclick="goToPage('preventivati')"><span>Da incassare</span><b style="color:var(--blue)">${euro(D.totalPrev)}</b><small>${plur(prevAcc.length,'preventivo','preventivi')}</small></button>
        <button class="m-stat" onclick="goToPage('mancanti')"><span>Mancanti</span><b style="color:#ff8fa8">${euro(D.totalMancanti)}</b><small>da recuperare</small></button>
        <button class="m-stat" onclick="goToPage('spese')"><span>Uscite mese</span><b>${euro(D.uscite)}</b><small>entrate ${euro(D.entrate)}</small></button>
      </div>

      <div class="card m-quick">
        <div class="m-section-head" style="margin:0 0 12px;"><span>Azioni rapide</span></div>
        <div class="m-quick-grid">
          ${ADD_ACTIONS.slice(3).filter(a=>a.label!=='Trasferimento').concat([
            {label:'Clienti', fn:"goToPage('clienti')", bg:'rgba(178,124,255,0.14)', color:'#B27CFF', ico:'users'},
            {label:'Stipendio', fn:"goToPage('stipendio')", bg:'var(--mint-dim)', color:'var(--mint)', ico:'cash'},
            {label:'Simulatore', fn:"goToPage('simulatore')", bg:'rgba(191,90,242,0.14)', color:'#BF5AF2', ico:'flask'}]).slice(0,8).map(a=>`
            <button onclick="${a.fn}"><span style="background:${a.bg}; color:${a.color};">${svgI(a.ico,18)}</span>${a.label}</button>`).join('')}
        </div>
      </div>

      <div class="m-blocks">
        ${B.preventivi}
        ${B.task}
        ${B.mese}
        ${B.movimenti}
        ${B.ricorrenti}
      </div>
    </div>
  `;
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
        x:{ grid:{display:false}, ticks:{ color:'#62786C', font:{size:10} } },
        y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{ color:'#5D7169', font:{size:10}, callback:v=>'€'+v } }
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
      datasets:[{ data: db.accounts.map(a=>Number(a.balance)), backgroundColor: db.accounts.map(a=>a.color), borderWidth:3, borderColor:'#0b1510', borderRadius:6 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'70%',
      plugins:{ legend:{ position:'bottom', labels:{ color:'#9DB3A7', font:{size:11}, padding:12, boxWidth:8 } },
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
      datasets:[{ data: entries.map(c=>speseCategoria[c.key]), backgroundColor: entries.map(c=>c.color), borderWidth:3, borderColor:'#0b1510', borderRadius:6 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'70%',
      plugins:{ legend:{ position:'bottom', labels:{ color:'#9DB3A7', font:{size:11}, padding:12, boxWidth:8 } },
        tooltip:{ callbacks:{ label: c=> `${c.label}: ${euro(c.raw)}` } } }
    }
  });
}
function modalMovimento(id, tipoIniziale){
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
  const isEdit = !!id;
  const m = isEdit ? db.movimenti.find(x=>x.id===id) : null;
  if(m && m.rettifica) return toast('Le rettifiche di saldo non sono modificabili: cambia di nuovo il saldo dal conto se serve.');
  const tipo = m ? m.type : (tipoIniziale || 'uscita');
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
    if(isPrevAuto(p) && p.date && p.date < oggiVal){
      const mancante = { id:uid(), name:p.name, amount:p.amount };
      if(p.fromStipendioId){
        mancante.fromStipendioId = p.fromStipendioId;
        mancante.fromStipendioMese = p.fromStipendioMese;
        mancante.note = "Stima, da confermare all'accredito";
      } else if(Array.isArray(p.voci) && p.voci.some(v=>!v.done)){
        mancante.note = 'Voci da incassare: ' + p.voci.filter(v=>!v.done).map(v=>v.name).join(', ');
      } else if(p.note){
        mancante.note = p.note;
      }
      db.mancanti.push(mancante);
      scollegaTaskEvento(p.id);
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

/* ==================== PREVENTIVATI (con voci espandibili) ====================
   Un preventivato può avere più voci (es. "Acconto", "Saldo", "Extra album").
   Ogni voce si segna come incassata singolarmente scegliendo il conto: il saldo
   del conto sale, viene registrata un'entrata e l'importo del preventivato
   (p.amount) diventa il RESIDUO ancora da incassare. Quando tutte le voci sono
   incassate il preventivato si chiude da solo.
============================================================================= */
/* ==================== PREVENTIVI ====================
   Ogni preventivo ha: numero progressivo, cliente, titolo, stato
   (bozza → inviato → accettato → completato, oppure rifiutato), data del lavoro,
   validità dell'offerta, voci (quantità × prezzo), sconto e note.
   Le voci si incassano una alla volta; quando sono tutte incassate il preventivo
   passa in archivio come "completato" (non viene cancellato, così le task restano collegate).
   Contano nel KPI "Preventivato" solo i preventivi ACCETTATI non ancora incassati;
   se la data del lavoro è passata e manca ancora qualcosa, quella cifra conta come "Mancante".
======================================================== */
const PREV_STATI = [
  { key:'bozza',      label:'Bozza',      color:'#8E8E93' },
  { key:'inviato',    label:'Inviato',    color:'#0A84FF' },
  { key:'accettato',  label:'Accettato',  color:'#30D158' },
  { key:'completato', label:'Completato', color:'#64D2FF' },
  { key:'rifiutato',  label:'Rifiutato',  color:'#FF453A' },
];
const PREV_TABS = [
  { key:'attivi', label:'Attivi', match:p=>['bozza','inviato','accettato'].includes(p.stato) },
  { key:'bozza', label:'Bozze', match:p=>p.stato==='bozza' },
  { key:'inviato', label:'Inviati', match:p=>p.stato==='inviato' },
  { key:'accettato', label:'Accettati', match:p=>p.stato==='accettato' },
  { key:'completato', label:'Completati', match:p=>p.stato==='completato' },
  { key:'rifiutato', label:'Rifiutati', match:p=>p.stato==='rifiutato' },
  { key:'tutti', label:'Tutti', match:()=>true },
];
let prevDrawerId = null;
let prevDraft = [];
let prevTab = 'attivi';
let prevVoceFilter = '';
const ICO_CHECK_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M20 6L9 17l-5-5"/></svg>';
const ICO_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
const ICO_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';

function statoInfo(k){ return PREV_STATI.find(s=>s.key===k) || PREV_STATI[2]; }
function statoPill(k){ const s = statoInfo(k); return `<span class="pill" style="background:${s.color}22; color:${s.color};">${s.label}</span>`; }
function isPrevAuto(p){ return !!p.fromStipendioId; }   // previsioni generate dalla sezione Stipendio
function prossimoNumeroPrev(){
  const anno = new Date().getFullYear();
  const max = db.preventivati.reduce((m,p)=>{
    const r = /^P-(\d{4})-(\d+)$/.exec(p.numero||'');
    return r && Number(r[1])===anno ? Math.max(m, Number(r[2])) : m;
  }, 0);
  return `P-${anno}-${String(max+1).padStart(3,'0')}`;
}
// porta i preventivi creati con le versioni precedenti al nuovo formato

// porta al formato attuale sia gli "eventi" della prima versione sia i preventivi con incassi per voce
function migratePrev(p){
  if(!p.stato){ p.stato = 'accettato'; if(!isPrevAuto(p)) p.importato = true; }
  if(!Array.isArray(p.voci) || !p.voci.length){
    p.voci = [{ id:uid(), name: isPrevAuto(p) ? 'Stipendio' : 'Importo', desc:'', qty:1, price:Number(p.amount)||0, amount:Number(p.amount)||0 }];
  }
  if(!Array.isArray(p.pagamenti)) p.pagamenti = [];
  p.voci.forEach(v=>{
    if(v.qty===undefined) v.qty = 1;
    if(v.price===undefined) v.price = Number(v.amount)||0;
    if(v.desc===undefined) v.desc = '';
    v.amount = Math.round(Number(v.qty)*Number(v.price)*100)/100;
    // versione precedente: le voci si incassavano singolarmente → diventano pagamenti
    if(v.done){
      p.pagamenti.push({ id:uid(), tipo:'pagamento', nota:v.name, amount:Number(v.amount)||0, date:v.doneDate||oggiStr(), accountId:v.accountId||null, giaSulConto:true });
      delete v.done; delete v.doneDate; delete v.accountId;
    }
  });
  if(p.sconto===undefined) p.sconto = 0;
  if(p.acconto===undefined) p.acconto = 0;
  if(!p.numero && !isPrevAuto(p)) p.numero = prossimoNumeroPrev();
  if(p.cliente===undefined) p.cliente = '';
  recalcPrev(p);
}
function prevHasVoci(p){ return Array.isArray(p.voci) && p.voci.length>0; }

function prevStats(p){
  const voci = p.voci||[], pag = p.pagamenti||[];
  const lordo = voci.reduce((s,v)=>s+Number(v.amount||0),0);
  const totale = Math.max(0, Math.round((lordo - Number(p.sconto||0))*100)/100);
  const incassato = Math.round(pag.reduce((s,x)=>s+Number(x.amount||0),0)*100)/100;
  const residuo = Math.max(0, Math.round((totale-incassato)*100)/100);
  const accontoRic = pag.filter(x=>x.tipo==='acconto').reduce((s,x)=>s+Number(x.amount||0),0);
  const accontoDovuto = Math.max(0, Number(p.acconto||0) - accontoRic);
  return { lordo, totale, incassato, residuo, n:voci.length, nPag:pag.length, accontoRic, accontoDovuto, pct: totale ? Math.min(100, Math.round(incassato/totale*100)) : 0 };
}

function recalcPrev(p){
  const st = prevStats(p);
  if(!isPrevAuto(p)){
    if(p.stato==='completato' && st.residuo>0) p.stato = 'accettato';
    if(p.stato==='accettato' && st.residuo<=0 && st.totale>0){ p.stato = 'completato'; if(!p.completatoIl) p.completatoIl = oggiStr(); }
  }
  p.amount = p.stato==='accettato' ? st.residuo : 0;
}

function prevInRitardo(p){ return !isPrevAuto(p) && p.stato==='accettato' && p.amount>0 && !!p.date && p.date < oggiStr(); }
function prevMancanti(){ return db.preventivati.filter(prevInRitardo).sort((a,b)=>(a.date||'').localeCompare(b.date||'')); }
function prevTasks(pid){ return db.tasks.filter(t=>t.prevId===pid); }
function prevTaskStats(pid){
  const l = prevTasks(pid);
  const subs = l.flatMap(t=>t.subtasks||[]);
  return { n:l.length, fatte:l.filter(t=>t.done).length, subN:subs.length, subFatte:subs.filter(s=>s.done).length };
}
// quanti lavori (task + sottotask) sono collegati a una voce e quanti sono fatti

function voceLavori(pid, vid){
  let n=0, f=0;
  prevTasks(pid).forEach(t=>{
    if(t.voceId===vid){ n++; if(t.done) f++; }
    (t.subtasks||[]).forEach(s=>{ if(s.voceId===vid){ n++; if(s.done) f++; } });
  });
  return { n, f };
}
function tipoPagLabel(t){ return t==='acconto' ? 'Acconto' : t==='saldo' ? 'Saldo' : 'Pagamento'; }
function scollegaTaskEvento(pid){ db.tasks.forEach(t=>{ if(t.prevId===pid){ t.prevId = null; t.voceId = null; (t.subtasks||[]).forEach(s=>s.voceId=null); } }); }
function quandoTesto(date){
  if(!date) return 'Senza data';
  const d = daysUntil(date);
  return d===0 ? 'Oggi' : d===1 ? 'Domani' : d<0 ? `${-d} giorn${d===-1?'o':'i'} fa` : d<=14 ? `Tra ${d} giorni` : fmtDate(date);
}
function validitaTesto(p){
  if(!p.validoFino || !['bozza','inviato'].includes(p.stato)) return '';
  const d = daysUntil(p.validoFino);
  if(d<0) return `<span style="color:var(--coral)">Offerta scaduta</span>`;
  return `<span style="color:${d<=3?'var(--amber)':'inherit'}">Valido ${d===0?'fino a oggi':'ancora '+d+' g'}</span>`;
}

/* ---------- riordino generico con trascinamento (mouse e touch) ---------- */
function moveInArray(arr, id, beforeId){
  const i = arr.findIndex(x=>x.id===id); if(i<0) return;
  const [m] = arr.splice(i,1);
  if(beforeId){ let j = arr.findIndex(x=>x.id===beforeId); if(j<0) j = arr.length; arr.splice(j,0,m); }
  else arr.push(m);
}
function attachSortable(container, itemSel, handleSel, onReorder){
  if(!container) return;
  container.querySelectorAll(`:scope > ${itemSel} ${handleSel}`).forEach(h=>{
    if(h.closest(itemSel).parentElement!==container) return;
    h.addEventListener('pointerdown', e=>{
      e.preventDefault(); e.stopPropagation();
      const el = h.closest(itemSel); const startY = e.clientY; let beforeId;
      const sibs = ()=>Array.from(container.children).filter(x=>x!==el && x.matches(itemSel));
      el.classList.add('dragging'); document.body.style.userSelect='none';
      const move = ev=>{
        el.style.transform = `translateY(${ev.clientY-startY}px)`; el.style.zIndex = 5;
        const s = sibs(); s.forEach(x=>x.classList.remove('drag-over-top','drag-over-bottom'));
        const target = s.find(x=>{ const r=x.getBoundingClientRect(); return ev.clientY < r.top + r.height/2; });
        if(target){ target.classList.add('drag-over-top'); beforeId = target.dataset.id; }
        else { beforeId = null; s.length && s[s.length-1].classList.add('drag-over-bottom'); }
      };
      const up = ()=>{
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        document.body.style.userSelect=''; el.classList.remove('dragging'); el.style.transform=''; el.style.zIndex='';
        sibs().forEach(x=>x.classList.remove('drag-over-top','drag-over-bottom'));
        if(beforeId!==undefined && beforeId!==el.dataset.id) onReorder(el.dataset.id, beforeId);
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
  });
}

/* ---------- pagina Preventivi ---------- */
function setPrevTab(k){ prevTab = k; renderPreventivati(); }
function renderPreventivati(){
  const f = filters.preventivati;
  const tutti = db.preventivati.filter(p=>!isPrevAuto(p));
  const auto = db.preventivati.filter(isPrevAuto);
  const tab = PREV_TABS.find(t=>t.key===prevTab) || PREV_TABS[0];
  let list = tutti.filter(tab.match);
  if(f.q) list = list.filter(p=> matches(p.name,f.q) || matches(p.cliente,f.q) || matches(p.numero,f.q) || matches(p.note,f.q) || p.voci.some(v=>matches(v.name,f.q)));
  const ordineStato = { inviato:0, bozza:1, accettato:2, completato:3, rifiutato:4 };
  list.sort((a,b)=> prevTab==='attivi' ? (a.date||'2100').localeCompare(b.date||'2100') : (b.creato||b.date||'').localeCompare(a.creato||a.date||''));

  const trattativa = tutti.filter(p=>['bozza','inviato'].includes(p.stato));
  const valTratt = trattativa.reduce((s,p)=>s+prevStats(p).totale,0);
  const accettati = tutti.filter(p=>p.stato==='accettato');
  const daIncassare = accettati.reduce((s,p)=>s+p.amount,0);
  const anno = String(new Date().getFullYear());
  const incAnno = db.movimenti.filter(m=>m.fromPrev && (m.date||'').startsWith(anno)).reduce((s,m)=>s+Number(m.amount),0);
  const decisi = tutti.filter(p=>['accettato','completato','rifiutato'].includes(p.stato));
  const tasso = decisi.length ? Math.round(decisi.filter(p=>p.stato!=='rifiutato').length/decisi.length*100) : null;

  document.getElementById('page-preventivati').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Preventivi</div><div class="page-sub">${tutti.length} preventivi · ${accettati.length} accettati da incassare</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo preventivo</button></div>
    </div>

    <div class="grid grid-4" style="margin-bottom:20px;">
      <div class="card"><div class="card-title">In trattativa</div><div class="stat-value" style="font-size:20px;">${euro(valTratt)}</div><div class="stat-trend" style="color:var(--text-faint)">${plur(trattativa.length,'bozza o inviato','tra bozze e inviati')}</div></div>
      <div class="card"><div class="card-title">Accettati da incassare</div><div class="stat-value" style="font-size:20px; color:var(--blue);">${euro(daIncassare)}</div><div class="stat-trend" style="color:var(--text-faint)">${plur(accettati.length,'preventivo','preventivi')}</div></div>
      <div class="card"><div class="card-title">Incassato nel ${anno}</div><div class="stat-value" style="font-size:20px; color:var(--mint);">${euro(incAnno)}</div><div class="stat-trend" style="color:var(--text-faint)">dalle voci dei preventivi</div></div>
      <div class="card"><div class="card-title">Tasso di accettazione</div><div class="stat-value" style="font-size:20px;">${tasso===null?'—':tasso+'%'}</div><div class="stat-trend" style="color:var(--text-faint)">${decisi.length ? `su ${plur(decisi.length,'preventivo deciso','preventivi decisi')}` : 'nessuna risposta ancora'}</div></div>
    </div>

    ${tutti.some(p=>p.importato) ? `<div class="import-banner">
      <div><b>${plur(tutti.filter(p=>p.importato).length,'evento importato','eventi importati')} dalla vecchia versione</b><span>Sono già preventivi accettati: aggiungi cliente e acconti ricevuti in un colpo solo.</span></div>
      <button class="btn btn-primary" onclick="modalRevisioneImportati()">Rivedi ora</button>
    </div>` : ''}
    <div class="prev-tabs">
      ${PREV_TABS.map(t=>{ const n = tutti.filter(t.match).length; return `<button class="prev-tab ${prevTab===t.key?'active':''}" onclick="setPrevTab('${t.key}')">${t.label}${n?`<span>${n}</span>`:''}</button>`; }).join('')}
    </div>
    <div class="toolbar-row">
      ${vistaToggle('preventivati')}
      ${calendarState.preventivati.on ? '' : searchBar('preventivati','Cerca per cliente, numero, voce…')}
    </div>
    ${calendarState.preventivati.on ? renderCalendarGrid('preventivati') : `
    <div class="event-grid">
      ${list.length ? list.map(prevCardHtml).join('') : `<div class="card" style="grid-column:1/-1;">${emptyState(tutti.length ? 'Nessun preventivo in questa vista.' : 'Nessun preventivo. Creane uno: voci, sconto, stato e lavori da fare in un solo posto.')}</div>`}
    </div>
    ${auto.length && ['attivi','tutti'].includes(prevTab) ? `
      <div class="section-title">Previsioni automatiche <span class="count">dalla sezione Stipendio</span></div>
      <div class="list">${auto.map(p=>`
        <div class="row-item">
          <div class="row-icon" style="background:var(--blue-dim); color:var(--blue);">€</div>
          <div class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${fmtDate(p.date)} · ${quandoTesto(p.date)}</div></div>
          <div class="row-amount" style="color:var(--blue)">${euro(p.amount)}</div>
          <div class="row-actions"><button class="icon-btn" style="color:var(--mint)" title="Segna come incassato" onclick="convertToAccount('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button></div>
        </div>`).join('')}</div>` : ''}
    `}
  `;
}

function prevCardHtml(p){
  const st = prevStats(p);
  const ts = prevTaskStats(p.id);
  const ritardo = prevInRitardo(p);
  const s = statoInfo(p.stato);
  const dChip = p.date ? (Math.abs(daysUntil(p.date))<=14 ? `${fmtDate(p.date)} · ${quandoTesto(p.date)}` : fmtDate(p.date)) : 'Senza data';
  return `<button class="event-card ${ritardo?'late':''}" onclick="openPrevDrawer('${p.id}')" style="--stato:${ritardo?'#FF453A':s.color}">
    <div class="event-card-top">
      <div class="event-avatar" style="background:${p.color}22; color:${p.color};">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
      <div class="event-card-titles">
        <div class="event-card-name">${esc(p.name)}</div>
        <div class="event-card-date">${p.numero?esc(p.numero)+' · ':''}${esc(p.cliente||'Nessun cliente')}</div>
      </div>
      ${ritardo ? `<span class="pill" style="background:var(--coral-dim); color:var(--coral);">Mancante</span>` : statoPill(p.stato)}
    </div>
    <div class="event-card-amount" style="color:${ritardo?'var(--coral)':p.stato==='accettato'?'var(--blue)':p.stato==='rifiutato'?'var(--text-faint)':'var(--text)'}">
      ${euro(p.stato==='accettato' ? st.residuo : st.totale)}<span>${p.stato==='accettato' ? (st.incassato?`da ricevere su ${euro(st.totale)}`:'da ricevere') : p.stato==='completato' ? 'incassato' : 'totale'}</span>
    </div>
    ${p.stato==='accettato' && st.incassato ? `<div class="progress-track slim"><div class="progress-fill" style="width:${st.pct}%; background:var(--mint);"></div></div>` : ''}
    <div class="event-card-meta">
      <span class="meta-chip">${dChip}</span>
      ${p.importato ? `<span class="meta-chip" style="background:var(--amber-dim); color:var(--amber);">Da rivedere</span>` : ''}
      ${st.accontoRic ? `<span class="meta-chip ok">Acconto ${euro(st.accontoRic)}</span>` : (st.accontoDovuto && p.stato!=='rifiutato' ? `<span class="meta-chip" style="color:var(--amber)">Acconto ${euro(st.accontoDovuto)} da ricevere</span>` : '')}
      ${ts.n ? `<span class="meta-chip ${ts.fatte===ts.n?'ok':''}">${ts.fatte}/${ts.n} lavori</span>` : ''}
      ${validitaTesto(p) ? `<span class="meta-chip">${validitaTesto(p)}</span>` : ''}
    </div>
  </button>`;
}
/* ---------- pannello di dettaglio preventivo ---------- */
function openPrevDrawer(id){
  const p = db.preventivati.find(x=>x.id===id);
  if(p && isPrevAuto(p)) return convertToAccount(id);
  if(prevDrawerId!==id) prevVoceFilter = '';
  prevDrawerId = id;
  renderPrevDrawer();
  document.getElementById('drawer-overlay').classList.add('active');
}
function closePrevDrawer(){
  prevDrawerId = null;
  document.getElementById('drawer-overlay').classList.remove('active');
}
function setPrevStato(id, stato){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  p.stato = stato;
  if(stato==='inviato' && !p.inviatoIl) p.inviatoIl = oggiStr();
  if(stato==='accettato' && !p.accettatoIl) p.accettatoIl = oggiStr();
  recalcPrev(p); saveDB(); renderAll(); toast(`Preventivo ${statoInfo(stato).label.toLowerCase()}.`);
}
function voceSelectHtml(p, current, onchange, cls){
  return `<select class="voce-select ${cls||''}" onclick="event.stopPropagation()" onchange="${onchange}" title="Collega a una voce del preventivo">
    <option value="">Nessuna voce</option>
    ${p.voci.map(v=>`<option value="${v.id}" ${current===v.id?'selected':''}>${esc(v.name)}</option>`).join('')}
  </select>`;
}

function renderPrevDrawer(){
  if(!prevDrawerId) return;
  const p = db.preventivati.find(x=>x.id===prevDrawerId);
  if(!p){ closePrevDrawer(); return; }
  const st = prevStats(p);
  const ts = prevTaskStats(p.id);
  const ritardo = prevInRitardo(p);
  const fVoce = prevVoceFilter && p.voci.some(v=>v.id===prevVoceFilter) ? prevVoceFilter : '';
  let tasks = prevTasks(p.id);
  if(fVoce) tasks = tasks.filter(t=>t.voceId===fVoce || (t.subtasks||[]).some(x=>x.voceId===fVoce));
  const tasksLibere = db.tasks.filter(t=>!t.prevId && !t.done);
  const passi = ['bozza','inviato','accettato','completato'];
  const idxStato = passi.indexOf(p.stato);
  const pagOrd = [...p.pagamenti].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const puoIncassare = p.stato!=='rifiutato' && st.residuo>0;

  document.getElementById('drawer').innerHTML = `
    <div class="drawer-head">
      <div class="event-avatar lg" style="background:${p.color}22; color:${p.color};">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
      <div style="flex:1; min-width:0;">
        <div class="drawer-title">${esc(p.name)}</div>
        <div class="drawer-sub">${p.numero?esc(p.numero)+' · ':''}${p.cliente?`<a href="#" onclick="closePrevDrawer(); apriCliente('${esc(p.cliente).replace(/'/g,"\\'")}'); return false;" style="color:var(--text-dim);">${esc(p.cliente)}</a>`:'Nessun cliente'}</div>
      </div>
      <button class="icon-btn" title="Chiudi (Esc)" onclick="closePrevDrawer()">${ICO_X}</button>
    </div>

    ${p.importato ? `<div class="drawer-alert amber">Importato dalla vecchia sezione Eventi: controlla cliente, voci e se hai già ricevuto un acconto. <button onclick="modalPreventivato('${p.id}')">Rivedi</button></div>` : ''}
    ${ritardo ? `<div class="drawer-alert coral">Lavoro del ${fmtDate(p.date)} già svolto: <b>${euro(st.residuo)}</b> risultano <b>mancanti</b>. <button onclick="modalPagamento('${p.id}','saldo')">Registra pagamento</button></div>` : ''}

    <div class="stato-stepper">
      ${passi.map((k,i)=>`<button class="stato-step ${p.stato==='rifiutato'?'':i<=idxStato?'done':''} ${p.stato===k?'current':''}" onclick="setPrevStato('${p.id}','${k}')"><i></i>${statoInfo(k).label}</button>`).join('')}
      <button class="stato-step reject ${p.stato==='rifiutato'?'current':''}" onclick="setPrevStato('${p.id}','${p.stato==='rifiutato'?'bozza':'rifiutato'}')" title="${p.stato==='rifiutato'?'Riapri come bozza':'Segna come rifiutato'}">${p.stato==='rifiutato'?'Riapri':'Rifiutato'}</button>
    </div>

    <div class="drawer-hero">
      <div class="drawer-hero-grid">
        <div><div class="drawer-hero-label">Totale preventivo</div><div class="drawer-hero-amount">${euro(st.totale)}</div></div>
        <div><div class="drawer-hero-label">Ricevuto</div><div class="drawer-hero-mid" style="color:var(--mint)">${euro(st.incassato)}</div></div>
        <div><div class="drawer-hero-label">${ritardo?'Mancante':'Da ricevere'}</div><div class="drawer-hero-mid" style="color:${ritardo?'var(--coral)':'var(--blue)'}">${euro(st.residuo)}</div></div>
      </div>
      <div class="progress-track slim"><div class="progress-fill" style="width:${st.pct}%; background:var(--mint);"></div></div>
      <div class="drawer-hero-sub">
        ${p.date?`Lavoro: <b>${fmtDate(p.date)}</b> (${quandoTesto(p.date).toLowerCase()})`:'Nessuna data lavoro'}
        ${p.validoFino && ['bozza','inviato'].includes(p.stato) ? ` · ${validitaTesto(p)} (${fmtDate(p.validoFino)})` : ''}
      </div>
    </div>

    <div class="drawer-actions five">
      <button class="action-tile primary" onclick="modalPagamento('${p.id}','${st.accontoDovuto&&!st.incassato?'acconto':'saldo'}')" ${puoIncassare?'':'disabled'}>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12l7 7 7-7"/></svg></span>${st.accontoDovuto&&!st.incassato?'Acconto':'Incassa'}
      </button>
      <button class="action-tile" onclick="modalPreventivato('${p.id}')">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></span>Modifica
      </button>
      <button class="action-tile" onclick="copiaPreventivo('${p.id}')">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></span>Copia testo
      </button>
      <button class="action-tile" onclick="duplicaPreventivo('${p.id}')">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4h10a2 2 0 012 2v10M4 8h10a2 2 0 012 2v10H6a2 2 0 01-2-2z"/></svg></span>Duplica
      </button>
      <button class="action-tile danger" onclick="modalEliminaPreventivato('${p.id}')">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></span>Elimina
      </button>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-head"><span>Pagamenti</span><span class="count">${euro(st.incassato)} su ${euro(st.totale)}</span></div>
      <div class="sheet-list">
        ${Number(p.acconto)>0 ? `<div class="voce-row pay-acconto">
          <div class="pay-dot" style="background:${st.accontoDovuto?'var(--amber-dim)':'var(--mint-dim)'}; color:${st.accontoDovuto?'var(--amber)':'var(--mint)'};">A</div>
          <div class="voce-name">Acconto richiesto<small>${st.accontoDovuto ? `mancano ${euro(st.accontoDovuto)}` : 'ricevuto'}</small></div>
          ${st.accontoDovuto && p.stato!=='rifiutato' ? `<button class="btn btn-sm" onclick="modalPagamento('${p.id}','acconto')">Registra</button>` : ''}
          <div class="voce-amount">${euro(p.acconto)}</div>
        </div>` : ''}
        ${pagOrd.map(x=>{
          const acc = x.accountId ? db.accounts.find(a=>a.id===x.accountId) : null;
          return `<div class="voce-row">
            <div class="pay-dot" style="background:var(--mint-dim); color:var(--mint);">${ICO_CHECK_SM}</div>
            <div class="voce-name">${tipoPagLabel(x.tipo)}${x.nota?' · '+esc(x.nota):''}<small>${fmtDate(x.date)}${acc?' · '+esc(acc.name):''}${x.giaSulConto?' · già sul conto':''}</small></div>
            <button class="icon-btn" title="Annulla questo pagamento" onclick="modalAnnullaPagamento('${p.id}','${x.id}')">${ICO_X}</button>
            <div class="voce-amount" style="color:var(--mint)">+ ${euro(x.amount)}</div>
          </div>`;}).join('')}
        ${!pagOrd.length && !Number(p.acconto) ? `<div class="voce-row"><div class="voce-name" style="color:var(--text-faint); font-weight:500;">Nessun pagamento ricevuto</div></div>` : ''}
        ${puoIncassare ? `<div class="pay-actions">
          ${st.accontoDovuto ? `<button class="btn btn-sm" onclick="modalPagamento('${p.id}','acconto')">+ Acconto</button>` : ''}
          <button class="btn btn-sm" onclick="modalPagamento('${p.id}','pagamento')">+ Pagamento parziale</button>
          <button class="btn btn-sm btn-primary" onclick="modalPagamento('${p.id}','saldo')">Incassa saldo ${euro(st.residuo)}</button>
        </div>` : ''}
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-head"><span>Voci</span><span class="count">${plur(st.n,'articolo','articoli')}</span></div>
      <div class="sheet-list">
        ${p.voci.map(v=>{
          const lav = voceLavori(p.id, v.id);
          return `<div class="voce-row">
            <div class="voce-name">
              <span class="voce-label">${esc(v.name)}</span>
              ${v.desc ? `<span class="voce-desc">${esc(v.desc)}</span>` : ''}
              ${Number(v.qty)!==1 ? `<small>${v.qty} × ${euro(v.price)}</small>` : ''}
            </div>
            ${lav.n ? `<button class="voce-lavori ${fVoce===v.id?'active':''} ${lav.f===lav.n?'ok':''}" onclick="filtraLavoriVoce('${v.id}')" title="Mostra i lavori di questa voce">${lav.f}/${lav.n} lavori</button>` : ''}
            <div class="voce-amount">${euro(v.amount)}</div>
          </div>`;
        }).join('')}
        ${Number(p.sconto)>0 ? `<div class="voce-row total-row"><div class="voce-name">Sconto</div><div class="voce-amount" style="color:var(--coral)">− ${euro(p.sconto)}</div></div>` : ''}
        <div class="voce-row total-row"><div class="voce-name"><b>Totale</b></div><div class="voce-amount"><b>${euro(st.totale)}</b></div></div>
      </div>
    </div>

    <div class="drawer-section">
      <div class="drawer-section-head">
        <span>Lavori da fare</span>
        <span class="count">${ts.fatte}/${ts.n} task${ts.subN?` · ${ts.subFatte}/${ts.subN} sottotask`:''}</span>
      </div>
      ${p.voci.length>1 ? `<div class="voce-filter">
        <button class="${!fVoce?'active':''}" onclick="filtraLavoriVoce('')">Tutte le voci</button>
        ${p.voci.map(v=>`<button class="${fVoce===v.id?'active':''}" onclick="filtraLavoriVoce('${v.id}')">${esc(v.name)}</button>`).join('')}
      </div>` : ''}
      <div class="lavori-list" id="lavori-list">
        ${tasks.map(t=>lavoroHtml(p, t, fVoce)).join('') || `<div class="sheet-empty">${fVoce?'Nessun lavoro collegato a questa voce.':'Nessun lavoro ancora. Aggiungi qui sotto le cose da fare per questo preventivo.'}</div>`}
      </div>
      <div class="sheet-add standalone">
        <input id="drawer-task-input" placeholder="Nuovo lavoro (es. Selezione foto)…" onkeydown="if(event.key==='Enter'){aggiungiTaskEvento('${p.id}')}">
        ${voceSelectHtml(p, fVoce, '', 'compact" id="drawer-task-voce')}
        <button onclick="aggiungiTaskEvento('${p.id}')">Aggiungi</button>
      </div>
      ${tasksLibere.length ? `
      <div class="sheet-link">
        <select id="drawer-link-select"><option value="">Collega una task esistente…</option>${tasksLibere.map(t=>`<option value="${t.id}">${esc(t.text)}</option>`).join('')}</select>
        <button class="btn" onclick="collegaTaskEsistente('${p.id}')">Collega</button>
      </div>` : ''}
    </div>

    ${p.note ? `<div class="drawer-section"><div class="drawer-section-head"><span>Note</span></div><div class="sheet-empty" style="color:var(--text-dim); white-space:pre-wrap;">${esc(p.note)}</div></div>` : ''}
    <div class="drawer-foot">Creato ${p.creato?fmtDate(p.creato):'—'}${p.inviatoIl?` · inviato ${fmtDate(p.inviatoIl)}`:''}${p.accettatoIl?` · accettato ${fmtDate(p.accettatoIl)}`:''}${p.completatoIl?` · completato ${fmtDate(p.completatoIl)}`:''}</div>
  `;
  if(!fVoce){
    attachSortable(document.getElementById('lavori-list'), '.lavoro', '.lavoro-head .drag-handle', (id, beforeId)=>{ moveInArray(db.tasks, id, beforeId); saveDB(); renderAll(); });
    document.querySelectorAll('#lavori-list .sub-list').forEach(el=>{
      const t = db.tasks.find(x=>x.id===el.dataset.task);
      attachSortable(el, '.sub-row', '.drag-handle', (id, beforeId)=>{ moveInArray(t.subtasks, id, beforeId); saveDB(); renderAll(); });
    });
  }
}
function lavoroHtml(p, t, fVoce){
  let subs = t.subtasks||[];
  if(fVoce && t.voceId!==fVoce) subs = subs.filter(s=>s.voceId===fVoce);
  const done = (t.subtasks||[]).filter(s=>s.done).length, tot = (t.subtasks||[]).length;
  return `<div class="lavoro ${t.done?'done':''}" data-id="${t.id}">
    <div class="lavoro-head">
      ${fVoce?'':`<span class="drag-handle" title="Trascina per riordinare">${ICO_GRIP}</span>`}
      <button class="voce-check ${t.done?'checked':''}" title="${t.done?'Riapri':'Completa'}" onclick="toggleTaskEvento('${t.id}')">${ICO_CHECK_SM}</button>
      <div class="voce-name" style="cursor:pointer;" onclick="modalTask('${t.id}')">
        <span class="voce-label">${esc(t.text)}</span>
        ${(t.dueDate||t.priority||tot)?`<small>${[t.priority, t.dueDate?'entro '+fmtDate(t.dueDate):'', tot?`${done}/${tot} sottotask`:''].filter(Boolean).join(' · ')}</small>`:''}
      </div>
      ${voceSelectHtml(p, t.voceId||'', `setVoceTask('${t.id}', this.value)`, 'compact')}
      <button class="icon-btn" title="Scollega dal preventivo" onclick="scollegaTask('${t.id}')">${ICO_X}</button>
    </div>
    <div class="sub-list" data-task="${t.id}">
      ${subs.map(s=>`
        <div class="sub-row ${s.done?'done':''}" data-id="${s.id}">
          ${fVoce?'':`<span class="drag-handle" title="Trascina per riordinare">${ICO_GRIP}</span>`}
          <input type="checkbox" class="subtask-check" ${s.done?'checked':''} onchange="toggleSubtaskPrev('${t.id}','${s.id}')">
          <div class="sub-text">${esc(s.text)}</div>
          ${voceSelectHtml(p, s.voceId||'', `setVoceSub('${t.id}','${s.id}', this.value)`, 'mini')}
          <button class="subtask-del" title="Elimina sottotask" onclick="eliminaSubPrev('${t.id}','${s.id}')">${ICO_X}</button>
        </div>`).join('')}
    </div>
    <div class="sub-add"><input id="sub-add-${t.id}" placeholder="+ Aggiungi sottotask" onkeydown="if(event.key==='Enter'){aggiungiSubPrev('${t.id}')}"></div>
  </div>`;
}
function filtraLavoriVoce(vid){ prevVoceFilter = prevVoceFilter===vid ? '' : vid; renderPrevDrawer(); }
function setVoceTask(tid, vid){ const t=db.tasks.find(x=>x.id===tid); if(!t) return; t.voceId = vid||null; saveDB(); renderAll(); }
function setVoceSub(tid, sid, vid){ const t=db.tasks.find(x=>x.id===tid); const s=t&&(t.subtasks||[]).find(x=>x.id===sid); if(!s) return; s.voceId = vid||null; saveDB(); renderAll(); }
function toggleSubtaskPrev(tid, sid){ const t=db.tasks.find(x=>x.id===tid); const s=t&&(t.subtasks||[]).find(x=>x.id===sid); if(!s) return; s.done=!s.done; saveDB(); renderAll(); }
function eliminaSubPrev(tid, sid){ const t=db.tasks.find(x=>x.id===tid); if(!t) return; t.subtasks=(t.subtasks||[]).filter(x=>x.id!==sid); saveDB(); renderAll(); }
function aggiungiSubPrev(tid){
  const input = document.getElementById('sub-add-'+tid);
  const text = input ? input.value.trim() : ''; if(!text) return;
  const t = db.tasks.find(x=>x.id===tid); if(!t) return;
  if(!t.subtasks) t.subtasks=[];
  t.subtasks.push({ id:uid(), text, done:false, voceId: prevVoceFilter || null });
  saveDB(); renderAll();
  document.getElementById('sub-add-'+tid)?.focus();
}
function toggleTaskEvento(tid){ const t=db.tasks.find(x=>x.id===tid); if(!t) return; t.done=!t.done; saveDB(); renderAll(); }
function aggiungiTaskEvento(pid){
  const input = document.getElementById('drawer-task-input');
  const text = input ? input.value.trim() : ''; if(!text) return;
  const p = db.preventivati.find(x=>x.id===pid);
  const voceId = document.getElementById('drawer-task-voce')?.value || null;
  db.tasks.push({ id:uid(), text, note:'', priority:'', dueDate: p&&p.date ? p.date : '', done:false, subtasks:[], prevId:pid, prevNome:p?p.name:'', voceId });
  saveDB(); renderAll();
  document.getElementById('drawer-task-input')?.focus();
}
function collegaTaskEsistente(pid){
  const sel = document.getElementById('drawer-link-select');
  const t = sel && db.tasks.find(x=>x.id===sel.value);
  const p = db.preventivati.find(x=>x.id===pid);
  if(!t || !p) return toast('Scegli una task.');
  t.prevId = pid; t.prevNome = p.name; t.voceId = null;
  saveDB(); renderAll(); toast('Task collegata.');
}
function scollegaTask(tid){
  const t = db.tasks.find(x=>x.id===tid); if(!t) return;
  t.prevId = null; t.prevNome = ''; t.voceId = null; (t.subtasks||[]).forEach(s=>s.voceId=null);
  saveDB(); renderAll(); toast('Task scollegata: resta nella lista Task.');
}

/* ---------- strumenti: duplica, copia, stampa ---------- */

function duplicaPreventivo(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  const nuovo = JSON.parse(JSON.stringify(p));
  Object.assign(nuovo, { id:uid(), numero:prossimoNumeroPrev(), name:p.name+' (copia)', stato:'bozza', creato:oggiStr(), inviatoIl:null, accettatoIl:null, completatoIl:null, pagamenti:[], importato:false });
  const mappaVoci = {};
  nuovo.voci.forEach(v=>{ const old=v.id; v.id=uid(); mappaVoci[old]=v.id; });
  recalcPrev(nuovo);
  db.preventivati.push(nuovo);
  prevTasks(id).forEach(t=>{
    db.tasks.push({ ...JSON.parse(JSON.stringify(t)), id:uid(), done:false, prevId:nuovo.id, prevNome:nuovo.name, voceId: t.voceId?mappaVoci[t.voceId]||null:null,
      subtasks:(t.subtasks||[]).map(s=>({ ...s, id:uid(), done:false, voceId: s.voceId?mappaVoci[s.voceId]||null:null })) });
  });
  saveDB(); renderAll(); openPrevDrawer(nuovo.id); toast('Preventivo duplicato come bozza, con i suoi lavori.');
}

function testoPreventivo(p){
  const st = prevStats(p);
  const righe = [];
  p.voci.forEach(v=>{
    righe.push(`• ${v.name}${Number(v.qty)!==1?` (${v.qty} × ${euro(v.price)})`:''}: ${euro(v.amount)}`);
    if(v.desc) righe.push(`   ${v.desc}`);
  });
  const out = [
    `Preventivo ${p.numero||''}${p.cliente?' per '+p.cliente:''}`.trim(),
    p.name,
    p.date ? `Data: ${new Date(p.date+'T00:00:00').toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'})}` : null,
    '',
    ...righe,
    '',
    Number(p.sconto)>0 ? `Sconto: −${euro(p.sconto)}` : null,
    `Totale: ${euro(st.totale)}`,
    Number(p.acconto)>0 ? `Acconto alla conferma: ${euro(p.acconto)}` : null,
    st.incassato>0 ? `Già ricevuto: ${euro(st.incassato)} · da saldare: ${euro(st.residuo)}` : null,
    p.validoFino && ['bozza','inviato'].includes(p.stato) ? `Offerta valida fino al ${fmtDate(p.validoFino)}` : null,
    p.note ? `\n${p.note}` : null,
  ].filter(r=>r!==null);
  return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
function copiaPreventivo(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  const testo = testoPreventivo(p);
  (navigator.clipboard ? navigator.clipboard.writeText(testo) : Promise.reject())
    .then(()=>toast('Testo copiato: incollalo in WhatsApp o email.'))
    .catch(()=>openModal(`<h3>Copia il testo</h3><div class="field"><textarea style="min-height:220px;" readonly>${esc(testo)}</textarea></div><div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div>`));
}

/* ---------- elimina ---------- */
function modalEliminaPreventivato(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  const n = prevTasks(id).length;
  openModal(`
    <h3>Eliminare "${esc(p.name)}"?</h3>
    <p style="color:var(--text-dim); font-size:13px; line-height:1.5;">Il preventivo e le sue voci verranno rimossi. I soldi già incassati restano sui conti.${n?` Le ${n} task collegate restano nella lista Task.`:''}<br>Se vuoi solo toglierlo dalla vista, segnalo come <b>Rifiutato</b>.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-danger-solid" onclick="confermaEliminaPreventivato('${id}')">Elimina</button>
    </div>
  `);
}
function confermaEliminaPreventivato(id){
  scollegaTaskEvento(id);
  db.preventivati = db.preventivati.filter(x=>x.id!==id);
  closeModal(); closePrevDrawer();
  saveDB(); renderAll(); toast('Preventivo eliminato.');
}

/* ---------- crea / modifica ---------- */

function modalPreventivato(id, presetCliente){
  const isEdit = !!id;
  const p = isEdit ? db.preventivati.find(x=>x.id===id) : null;
  prevDraft = p ? p.voci.map(v=>({...v})) : [{ id:uid(), name:'', desc:'', qty:1, price:'' }];
  const clienti = elencoClientiNomi();
  const validDefault = (()=>{ const d=new Date(); d.setDate(d.getDate()+30); return dateKeyFromDate(d); })();
  const st = p ? prevStats(p) : null;
  openModal(`
    <h3>${isEdit?'Modifica preventivo':'Nuovo preventivo'}</h3>
    ${p && p.importato ? `<div class="drawer-alert amber" style="margin:0 0 14px;">Questo arriva dalla vecchia sezione Eventi. Aggiungi il cliente, dividi l'importo in voci se vuoi e indica se avevi già ricevuto un acconto.</div>` : ''}
    <div class="field-row">
      <div class="field"><label>Cliente</label><input id="f-cliente" list="dl-clienti" value="${p?esc(p.cliente||''):esc(presetCliente||'')}" placeholder="Es. Marco Rossi"><datalist id="dl-clienti">${clienti.map(c=>`<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label>Numero</label><input id="f-numero" value="${p?esc(p.numero||''):prossimoNumeroPrev()}"></div>
    </div>
    <div class="field"><label>Titolo del lavoro</label><input id="f-name" value="${p?esc(p.name):''}" placeholder="Es. Servizio fotografico matrimonio"></div>
    <div class="field-row">
      <div class="field"><label>Data del lavoro</label><input id="f-date" type="date" value="${p?p.date||'':''}"></div>
      <div class="field"><label>Offerta valida fino al</label><input id="f-valido" type="date" value="${p?p.validoFino||'':validDefault}"></div>
    </div>
    <div class="field"><label>Stato</label><select id="f-stato">
      ${PREV_STATI.filter(s=>s.key!=='completato' || (p && p.stato==='completato')).map(s=>`<option value="${s.key}" ${(p?p.stato:'bozza')===s.key?'selected':''}>${s.label}</option>`).join('')}
    </select></div>
    <div class="field">
      <label>Voci (articoli)</label>
      <div class="voci-editor">
        <div class="voci-editor-row voci-editor-labels"><span>Articolo e descrizione</span><span>Q.tà</span><span>Prezzo €</span><span>Importo</span><span></span></div>
        <div id="voci-editor-rows"></div>
        <button type="button" class="voci-editor-add" onclick="aggiungiVoceDraft()">+ Aggiungi voce</button>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Sconto (€)</label><input id="f-sconto" type="number" step="0.01" min="0" value="${p&&p.sconto?p.sconto:''}" placeholder="0.00" oninput="aggiornaTotaleVoci()"></div>
      <div class="field"><label>Totale</label><div class="voci-total-box" id="voci-total">—</div></div>
    </div>
    <div class="field">
      <label>Acconto richiesto (€)</label>
      <div class="acconto-row">
        <input id="f-acconto" type="number" step="0.01" min="0" value="${p&&p.acconto?p.acconto:''}" placeholder="Nessun acconto">
        <button type="button" class="btn btn-sm" onclick="setAccontoPct(30)">30%</button>
        <button type="button" class="btn btn-sm" onclick="setAccontoPct(50)">50%</button>
      </div>
      ${!st || !st.accontoRic ? `<label class="chip-check" style="margin-top:10px; font-size:12.5px; color:var(--text-dim);"><input type="checkbox" id="f-acconto-ricevuto"> L'acconto l'ho già ricevuto (te lo faccio registrare subito)</label>` : `<div class="row-sub" style="margin-top:8px;">Acconto già registrato: ${euro(st.accontoRic)}</div>`}
    </div>
    <div class="field"><label>Note per il cliente (opzionale)</label><textarea id="f-note" rows="3" placeholder="Es. saldo il giorno del lavoro tramite bonifico">${p?esc(p.note||''):''}</textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="savePreventivato('${id||''}')">${isEdit?'Salva':'Crea preventivo'}</button>
    </div>
  `);
  modalEl.classList.add('modal-wide');
  renderVociDraft();
}
function setAccontoPct(pct){
  const lordo = prevDraft.reduce((s,v)=>s+(Number(v.qty)||0)*(Number(v.price)||0),0);
  const sconto = parseFloat(document.getElementById('f-sconto')?.value)||0;
  document.getElementById('f-acconto').value = (Math.round(Math.max(0,lordo-sconto)*pct)/100).toFixed(2);
}

function renderVociDraft(){
  const box = document.getElementById('voci-editor-rows'); if(!box) return;
  box.innerHTML = prevDraft.map(v=>`
    <div class="voci-editor-row" data-id="${v.id}">
      <div class="voci-editor-text">
        <input class="ve-name" value="${esc(v.name||'')}" placeholder="Articolo (es. Servizio 8 ore)" oninput="aggiornaVoceDraft('${v.id}','name',this.value)">
        <input class="ve-desc" value="${esc(v.desc||'')}" placeholder="Descrizione (es. preparativi, cerimonia e ricevimento)" oninput="aggiornaVoceDraft('${v.id}','desc',this.value)">
      </div>
      <input type="number" step="0.5" min="0" value="${v.qty??1}" oninput="aggiornaVoceDraft('${v.id}','qty',this.value)" title="Quantità">
      <input type="number" step="0.01" value="${v.price===''||v.price===undefined?'':v.price}" placeholder="0.00" oninput="aggiornaVoceDraft('${v.id}','price',this.value)" title="Prezzo unitario">
      <span class="voci-editor-amount" id="va-${v.id}">${euro((Number(v.qty)||0)*(Number(v.price)||0))}</span>
      <button type="button" class="icon-btn btn-danger" title="Rimuovi voce" onclick="rimuoviVoceDraft('${v.id}')">${ICO_X}</button>
    </div>`).join('');
  aggiornaTotaleVoci();
}
function aggiornaTotaleVoci(){
  const el = document.getElementById('voci-total'); if(!el) return;
  const lordo = prevDraft.reduce((s,v)=>s+(Number(v.qty)||0)*(Number(v.price)||0),0);
  const sconto = parseFloat(document.getElementById('f-sconto')?.value)||0;
  el.innerHTML = `<b>${euro(Math.max(0, lordo-sconto))}</b>${sconto?` <span>(${euro(lordo)} − ${euro(sconto)})</span>`:''}`;
}

function aggiungiVoceDraft(){
  prevDraft.push({ id:uid(), name:'', desc:'', qty:1, price:'' });
  renderVociDraft();
  const rows = document.querySelectorAll('#voci-editor-rows .voci-editor-row');
  rows[rows.length-1]?.querySelector('input')?.focus();
}

function aggiornaVoceDraft(vid, campo, valore){
  const v = prevDraft.find(x=>x.id===vid); if(!v) return;
  v[campo] = valore;
  const a = document.getElementById('va-'+vid); if(a) a.textContent = euro((Number(v.qty)||0)*(Number(v.price)||0));
  aggiornaTotaleVoci();
}

function rimuoviVoceDraft(vid){ prevDraft = prevDraft.filter(x=>x.id!==vid); renderVociDraft(); }

function savePreventivato(id){
  const name = document.getElementById('f-name').value.trim();
  const cliente = document.getElementById('f-cliente').value.trim();
  if(!name) return toast('Dai un titolo al lavoro.');
  const voci = prevDraft
    .map(v=>({ id:v.id, name:String(v.name||'').trim(), desc:String(v.desc||'').trim(), qty: parseFloat(v.qty)||0, price: parseFloat(v.price)||0 }))
    .filter(v=> v.name || v.price>0)
    .map(v=>({ ...v, name:v.name||'Voce', amount: Math.round(v.qty*v.price*100)/100 }));
  if(!voci.length) return toast('Aggiungi almeno una voce con un prezzo.');
  const accontoRicevuto = !!document.getElementById('f-acconto-ricevuto')?.checked;
  const dati = {
    name, cliente,
    numero: document.getElementById('f-numero').value.trim(),
    date: document.getElementById('f-date').value,
    validoFino: document.getElementById('f-valido').value,
    stato: document.getElementById('f-stato').value,
    sconto: Math.max(0, parseFloat(document.getElementById('f-sconto').value)||0),
    acconto: Math.max(0, parseFloat(document.getElementById('f-acconto').value)||0),
    note: document.getElementById('f-note').value.trim(),
    importato: false,
  };
  let p;
  if(id){ p = db.preventivati.find(x=>x.id===id); Object.assign(p, dati); }
  else { p = { id:uid(), ...dati, pagamenti:[], creato:oggiStr(), color: ICON_COLORS[Math.floor(Math.random()*ICON_COLORS.length)] }; db.preventivati.push(p); }
  p.voci = voci;
  const idsVoci = new Set(voci.map(v=>v.id));
  prevTasks(p.id).forEach(t=>{ t.prevNome = p.name; if(t.voceId && !idsVoci.has(t.voceId)) t.voceId=null; (t.subtasks||[]).forEach(s=>{ if(s.voceId && !idsVoci.has(s.voceId)) s.voceId=null; }); });
  if(p.stato==='accettato' && !p.accettatoIl) p.accettatoIl = oggiStr();
  if(p.stato==='inviato' && !p.inviatoIl) p.inviatoIl = oggiStr();
  recalcPrev(p);
  prevDraft = [];
  saveDB(); closeModal(); renderAll(); toast(id?'Preventivo aggiornato.':'Preventivo creato.');
  if(!id || prevDrawerId!==p.id) openPrevDrawer(p.id);
  if(accontoRicevuto && p.acconto>0) modalPagamento(p.id, 'acconto');
}
/* ---------- incassi ---------- */

function modalPagamento(pid, tipo){
  const p = db.preventivati.find(x=>x.id===pid); if(!p) return;
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
  const st = prevStats(p);
  const proposto = tipo==='acconto' ? Math.min(st.accontoDovuto || p.acconto, st.residuo) : tipo==='saldo' ? st.residuo : '';
  openModal(`
    <h3>${tipo==='acconto'?'Registra acconto':tipo==='saldo'?'Incassa saldo':'Registra pagamento'}</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px; line-height:1.5;"><strong style="color:var(--text);">${esc(p.name)}</strong>${p.cliente?' · '+esc(p.cliente):''}<br>Totale ${euro(st.totale)} · già ricevuto ${euro(st.incassato)} · resta ${euro(st.residuo)}${p.stato!=='accettato'?'<br>Il preventivo verrà segnato come <b>accettato</b>.':''}</p>
    <div class="field-row">
      <div class="field"><label>Importo (€)</label><input id="f-pag-importo" type="number" step="0.01" value="${proposto===''?'':Number(proposto).toFixed(2)}" placeholder="0.00"></div>
      <div class="field"><label>Data</label><input id="f-pag-data" type="date" value="${oggiStr()}"></div>
    </div>
    <div class="field"><label>Tipo</label><div style="display:flex;">
      <label class="chip-check"><input type="radio" name="f-pag-tipo" value="acconto" ${tipo==='acconto'?'checked':''}> Acconto</label>
      <label class="chip-check"><input type="radio" name="f-pag-tipo" value="pagamento" ${tipo==='pagamento'?'checked':''}> Parziale</label>
      <label class="chip-check"><input type="radio" name="f-pag-tipo" value="saldo" ${tipo==='saldo'?'checked':''}> Saldo</label>
    </div></div>
    <div class="field"><label>Conto su cui è arrivato</label><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <label class="chip-check" style="font-size:12.5px; color:var(--text-dim);"><input type="checkbox" id="f-pag-gia"> Questi soldi sono già nel saldo del conto (non aggiungerli di nuovo)</label>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confermaPagamento('${pid}')">Registra</button>
    </div>
  `);
}
function confermaPagamento(pid){
  const p = db.preventivati.find(x=>x.id===pid); if(!p) return;
  const importo = parseFloat(document.getElementById('f-pag-importo').value)||0;
  const date = document.getElementById('f-pag-data').value || oggiStr();
  const tipo = document.querySelector('input[name="f-pag-tipo"]:checked')?.value || 'pagamento';
  const acc = db.accounts.find(x=>x.id===document.getElementById('f-account').value);
  const gia = document.getElementById('f-pag-gia').checked;
  if(importo<=0) return toast('Inserisci un importo valido.');
  if(!acc) return toast('Seleziona un conto.');
  const pag = { id:uid(), tipo, amount:importo, date, accountId:acc.id };
  if(gia) pag.giaSulConto = true;
  else {
    acc.balance = Number(acc.balance) + importo;
    const mov = { id:uid(), type:'entrata', name:`${p.name} · ${tipoPagLabel(tipo).toLowerCase()}`, amount:importo, date, accountId:acc.id, category:'lavoro', fromPrev:p.id };
    db.movimenti.push(mov); pag.movId = mov.id;
  }
  p.pagamenti.push(pag);
  if(['bozza','inviato'].includes(p.stato)){ p.stato='accettato'; if(!p.accettatoIl) p.accettatoIl = oggiStr(); }
  recalcPrev(p);
  saveDB(); closeModal(); renderAll();
  toast(p.stato==='completato' ? `Tutto ricevuto: "${p.name}" completato 🎉` : `${euro(importo)} registrati · restano ${euro(prevStats(p).residuo)}`);
}
function modalAnnullaPagamento(pid, payId){
  const p = db.preventivati.find(x=>x.id===pid); const x = p && p.pagamenti.find(y=>y.id===payId); if(!x) return;
  openModal(`
    <h3>Annullare questo pagamento?</h3>
    <p style="color:var(--text-dim); font-size:13px; line-height:1.5;">${tipoPagLabel(x.tipo)} di ${euro(x.amount)} del ${fmtDate(x.date)}.${x.movId?' Verrà tolto anche dal saldo del conto e dalla lista Spese.':''}</p>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">No</button><button class="btn btn-danger-solid" onclick="annullaPagamento('${pid}','${payId}')">Annulla pagamento</button></div>
  `);
}
function annullaPagamento(pid, payId){
  const p = db.preventivati.find(x=>x.id===pid); const x = p && p.pagamenti.find(y=>y.id===payId); if(!x) return;
  if(x.movId){
    const acc = db.accounts.find(a=>a.id===x.accountId);
    if(acc) acc.balance = Number(acc.balance) - Number(x.amount);
    db.movimenti = db.movimenti.filter(m=>m.id!==x.movId);
  }
  p.pagamenti = p.pagamenti.filter(y=>y.id!==payId);
  recalcPrev(p);
  saveDB(); closeModal(); renderAll(); toast('Pagamento annullato.');
}


function segnaStipendioRicevuto(p){
  if(!p.fromStipendioId) return;
  const st = db.stipendi.find(x=>x.id===p.fromStipendioId);
  if(st && !st.ricevuti.includes(p.fromStipendioMese)) st.ricevuti.push(p.fromStipendioMese);
}

function convertToAccount(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  if(!isPrevAuto(p)) return modalPagamento(id, 'saldo');
  if(!db.accounts.length) return toast('Crea prima almeno un conto.');
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
  const p = db.preventivati.find(x=>x.id===id);
  const acc = db.accounts.find(x=>x.id===document.getElementById('f-account').value);
  if(!p || !acc) return toast('Seleziona un conto.');
  const importo = Number(p.amount)||0;
  acc.balance = Number(acc.balance) + importo;
  db.movimenti.push({ id:uid(), type:'entrata', name:p.name, amount:importo, date:oggiStr(), accountId:acc.id, category:'altro' });
  segnaStipendioRicevuto(p);
  db.preventivati = db.preventivati.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(importo)} aggiunti a ${acc.name}.`);
}

/* ---------- revisione guidata dei vecchi "eventi" importati ---------- */
function modalRevisioneImportati(){
  const lista = db.preventivati.filter(p=>p.importato);
  if(!lista.length) return toast('Niente da rivedere.');
  const clienti = elencoClientiNomi();
  openModal(`
    <h3>Rivedi gli eventi importati</h3>
    <p style="color:var(--text-dim); font-size:13px; line-height:1.55; margin-bottom:14px;">
      Questi erano nella vecchia sezione <b>Eventi</b> e sono già diventati preventivi <b>accettati</b>, con un'unica voce pari all'importo.
      Per ognuno indica il cliente, lo stato giusto e quanto avevi <b>già ricevuto</b> (acconti). L'importo ricevuto viene registrato senza toccare il saldo dei conti, perché quei soldi li avevi già.
    </p>
    <datalist id="dl-clienti">${clienti.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
    <div class="import-list">
      ${lista.map(p=>`
        <div class="import-row" data-id="${p.id}">
          <div class="import-head"><b>${esc(p.name)}</b><span>${p.date?fmtDate(p.date):'senza data'} · ${euro(prevStats(p).totale)}</span></div>
          <div class="import-fields">
            <input class="imp-cliente" list="dl-clienti" placeholder="Cliente" value="${esc(p.cliente||'')}">
            <select class="imp-stato">
              <option value="accettato" selected>Accettato</option>
              <option value="inviato">Inviato (in attesa)</option>
              <option value="bozza">Bozza</option>
              <option value="rifiutato">Rifiutato</option>
            </select>
            <input class="imp-ricevuto" type="number" step="0.01" min="0" placeholder="Già ricevuto €">
          </div>
        </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Più tardi</button>
      <button class="btn btn-primary" onclick="salvaRevisioneImportati()">Conferma tutti</button>
    </div>
  `);
  modalEl.classList.add('modal-wide');
}
function salvaRevisioneImportati(){
  document.querySelectorAll('.import-row').forEach(row=>{
    const p = db.preventivati.find(x=>x.id===row.dataset.id); if(!p) return;
    p.cliente = row.querySelector('.imp-cliente').value.trim();
    p.stato = row.querySelector('.imp-stato').value;
    if(p.stato==='accettato' && !p.accettatoIl) p.accettatoIl = oggiStr();
    const ric = parseFloat(row.querySelector('.imp-ricevuto').value)||0;
    if(ric>0) p.pagamenti.push({ id:uid(), tipo:'acconto', amount:ric, date:oggiStr(), accountId:null, giaSulConto:true, nota:'registrato in revisione' });
    p.importato = false;
    recalcPrev(p);
  });
  saveDB(); closeModal(); renderAll(); toast('Preventivi aggiornati.');
}
// un vecchio "mancante" (es. evento passato della versione precedente) diventa un preventivo vero
function trasformaMancanteInPreventivo(mid){
  const m = db.mancanti.find(x=>x.id===mid); if(!m) return;
  const ieri = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return dateKeyFromDate(d); })();
  const p = { id:uid(), name:m.name, cliente:'', numero:prossimoNumeroPrev(), date:ieri, stato:'accettato', accettatoIl:oggiStr(), creato:oggiStr(),
    voci:[{ id:uid(), name:m.name, desc:m.note||'', qty:1, price:Number(m.amount)||0, amount:Number(m.amount)||0 }], pagamenti:[], sconto:0, acconto:0, note:'', color: ICON_COLORS[0] };
  recalcPrev(p);
  db.preventivati.push(p);
  db.mancanti = db.mancanti.filter(x=>x.id!==mid);
  saveDB(); renderAll(); openPrevDrawer(p.id); modalPreventivato(p.id);
  toast('Trasformato in preventivo: completa cliente e data del lavoro.');
}
/* ==================== CLIENTI (costruiti dai preventivi) ==================== */
function chiaveCliente(n){ return String(n||'').trim().toLowerCase(); }
function elencoClientiNomi(){
  const m = new Map();
  db.preventivati.forEach(p=>{ if(p.cliente && !m.has(chiaveCliente(p.cliente))) m.set(chiaveCliente(p.cliente), p.cliente.trim()); });
  return [...m.values()].sort((a,b)=>a.localeCompare(b,'it'));
}
function datiClienti(){
  const m = new Map();
  db.preventivati.filter(p=>!isPrevAuto(p)).forEach(p=>{
    const k = chiaveCliente(p.cliente) || '_';
    if(!m.has(k)) m.set(k, { nome: p.cliente ? p.cliente.trim() : 'Senza cliente', key:k, prev:[], lavorato:0, incassato:0, daIncassare:0, trattativa:0, ultimo:'' });
    const c = m.get(k), st = prevStats(p);
    c.prev.push(p);
    if(['accettato','completato'].includes(p.stato)) c.lavorato += st.totale;
    c.incassato += st.incassato;
    if(p.stato==='accettato') c.daIncassare += st.residuo;
    if(['bozza','inviato'].includes(p.stato)) c.trattativa += st.totale;
    const d = p.date || p.creato || '';
    if(d > c.ultimo) c.ultimo = d;
  });
  return [...m.values()];
}
function renderClienti(){
  const f = filters.clienti;
  let list = datiClienti().sort((a,b)=> b.lavorato-a.lavorato || a.nome.localeCompare(b.nome));
  if(f.q) list = list.filter(c=>matches(c.nome,f.q));
  const conDebiti = list.filter(c=>c.daIncassare>0);
  document.getElementById('page-clienti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Clienti</div><div class="page-sub">${plur(list.filter(c=>c.key!=='_').length,'cliente','clienti')} · si aggiornano da soli dai preventivi</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo preventivo</button></div>
    </div>
    ${conDebiti.length ? `<div class="card" style="margin-bottom:18px; border-color:rgba(10,132,255,0.3);">
      <div class="card-title">Da sollecitare</div>
      <div class="row-sub" style="white-space:normal; font-size:12.5px; margin-top:6px;">${conDebiti.map(c=>`<b style="color:var(--text)">${esc(c.nome)}</b> ${euro(c.daIncassare)}`).join(' · ')}</div>
    </div>` : ''}
    ${searchBar('clienti','Cerca cliente…')}
    <div class="list">
      ${list.length ? list.map(c=>`
        <div class="row-item" style="cursor:pointer;" onclick="apriCliente('${esc(c.nome).replace(/'/g,"\\'")}')">
          <div class="row-icon" style="background:var(--mint-dim); color:var(--mint);">${esc(c.nome.charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(c.nome)}</div>
            <div class="row-sub">${plur(c.prev.length,'preventivo','preventivi')}${c.daIncassare>0?` · <span style="color:var(--blue)">${euro(c.daIncassare)} da incassare</span>`:''}${c.trattativa?` · ${euro(c.trattativa)} in trattativa`:''}${c.ultimo?' · ultimo '+fmtDate(c.ultimo):''}</div>
          </div>
          <div class="row-amount" title="Totale lavori accettati">${euro(c.lavorato)}</div>
        </div>`).join('') : emptyState('Nessun cliente ancora: compaiono qui quando scrivi il nome del cliente in un preventivo.')}
    </div>
  `;
}
function apriCliente(nome){
  const c = datiClienti().find(x=>x.key===chiaveCliente(nome)) ; if(!c) return;
  const ord = [...c.prev].sort((a,b)=>(b.date||b.creato||'').localeCompare(a.date||a.creato||''));
  openModal(`
    <h3>${esc(c.nome)}</h3>
    <div class="grid" style="grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:16px;">
      <div class="card" style="padding:12px;"><div class="card-title">Lavorato</div><div class="stat-value" style="font-size:16px;">${euro(c.lavorato)}</div></div>
      <div class="card" style="padding:12px;"><div class="card-title">Incassato</div><div class="stat-value" style="font-size:16px; color:var(--mint);">${euro(c.incassato)}</div></div>
      <div class="card" style="padding:12px;"><div class="card-title">Da incassare</div><div class="stat-value" style="font-size:16px; color:var(--blue);">${euro(c.daIncassare)}</div></div>
    </div>
    <div class="list">
      ${ord.map(p=>`<div class="row-item" style="cursor:pointer;" onclick="closeModal(); openPrevDrawer('${p.id}')">
        <div class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${esc(p.numero||'')} · ${p.date?fmtDate(p.date):'senza data'}</div></div>
        ${statoPill(p.stato)}
        <div class="row-amount">${euro(prevStats(p).totale)}</div>
      </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Chiudi</button>
      ${c.key!=='_'?`<button class="btn btn-primary" onclick="closeModal(); modalPreventivato(null, '${esc(c.nome).replace(/'/g,"\\'")}')">+ Preventivo per ${esc(c.nome)}</button>`:''}
    </div>
  `);
  modalEl.classList.add('modal-wide');
}

/* ==================== MANCANTI ==================== */

function renderMancanti(){
  const f = filters.mancanti;
  const daPrev = prevMancanti();
  const totPrev = daPrev.reduce((s,p)=>s+Number(p.amount),0);
  const totMan = db.mancanti.reduce((s,m)=>s+Number(m.amount),0);
  let list = [...db.mancanti];
  let listPrev = [...daPrev];
  if(f.q){
    list = list.filter(m=> matches(m.name,f.q) || matches(m.note,f.q));
    listPrev = listPrev.filter(p=> matches(p.name,f.q) || matches(p.cliente,f.q));
  }
  const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
  document.getElementById('page-mancanti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Soldi mancanti</div><div class="page-sub">Totale <strong style="color:var(--coral)">${euro(totPrev+totMan)}</strong> · ${plur(daPrev.length,'lavoro già svolto','lavori già svolti')} da saldare · ${plur(db.mancanti.length,'altra voce','altre voci')}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalMancante()">+ Aggiungi</button></div>
    </div>
    ${searchBar('mancanti','Cerca voce, lavoro o cliente...')}

    <div class="section-title" style="margin-top:6px;">Da preventivi <span class="count">${euro(totPrev)}</span></div>
    <p class="section-help">Quando la data di un preventivo accettato è passata e non hai ricevuto tutto, il resto finisce qui in automatico.</p>
    <div class="list">
      ${listPrev.length ? listPrev.map(p=>{
        const st = prevStats(p);
        const giorni = -daysUntil(p.date);
        return `<div class="row-item" style="cursor:pointer;" onclick="openPrevDrawer('${p.id}')">
          <div class="row-icon" style="background:var(--coral-dim); color:var(--coral);">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(p.name)}${p.cliente?` <span style="color:var(--text-faint); font-weight:500;">· ${esc(p.cliente)}</span>`:''}</div>
            <div class="row-sub">Lavoro del ${fmtDate(p.date)} · ${giorni===1?'ieri':giorni+' giorni fa'}${st.incassato?` · ricevuti ${euro(st.incassato)} su ${euro(st.totale)}`:' · nessun pagamento ricevuto'}</div>
          </div>
          <div class="row-amount" style="color:var(--coral)">${euro(p.amount)}</div>
          <div class="row-actions" onclick="event.stopPropagation()">
            <button class="btn btn-sm btn-primary" onclick="modalPagamento('${p.id}','saldo')">Registra pagamento</button>
          </div>
        </div>`;}).join('') : emptyState(daPrev.length ? 'Nessun lavoro corrisponde alla ricerca.' : 'Nessun preventivo da saldare: tutti i lavori passati sono pagati.')}
    </div>

    <div class="section-title">Altri soldi da ricevere <span class="count">${euro(totMan)}</span></div>
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
            ${isStipendio ? `<button class="icon-btn" style="color:var(--mint)" title="Accredita su un conto" onclick="modalAccreditaStipendio('${m.id}')">${ICO_OK}</button>` : `<button class="icon-btn" style="color:var(--mint)" title="Accredita su un conto" onclick="modalAccreditaMancante('${m.id}')">${ICO_OK}</button>
            <button class="icon-btn" title="Trasforma in preventivo (es. un vecchio evento)" onclick="trasformaMancanteInPreventivo('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></svg></button>`}
            <button class="icon-btn" title="Modifica" onclick="modalMancante('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" title="Elimina" onclick="deleteItem('mancanti','${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>
      `;}).join('') : emptyState(db.mancanti.length ? 'Nessuna voce corrisponde alla ricerca.' : 'Nessun altro pagamento mancante.')}
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

/* ==================== TASK — To-Do list con sotto-task ==================== */
let taskExpanded = new Set(); // stato solo di sessione: quali task hanno la checklist aperta

function taskProgress(t){
  const subs = t.subtasks || [];
  const total = subs.length;
  const done = subs.filter(s=>s.done).length;
  return { total, done, pct: total ? Math.round(done/total*100) : 0 };
}

function renderTask(){
  const f = filters.task;
  const pending = db.tasks.filter(t=>!t.done);
  const subtasksAperti = db.tasks.reduce((s,t)=> s + (t.subtasks||[]).filter(st=>!st.done).length, 0);

  // L'ordine manuale (trascinamento) viene preservato: ordiniamo solo per stato
  // completato/non completato (i completati vanno in fondo), il sort è stabile
  // quindi a parità di stato l'ordine dell'array (db.tasks) resta quello scelto dall'utente.
  let list = db.tasks.slice().sort((a,b)=> (a.done?1:0) - (b.done?1:0));
  const dragDisabled = !!f.q || !!f.prev;
  if(f.q) list = list.filter(t=> matches(t.text,f.q) || matches(t.note,f.q) || matches(t.prevNome,f.q) || (t.subtasks||[]).some(st=>matches(st.text,f.q)));
  if(f.prev==='_none') list = list.filter(t=>!t.prevId);
  else if(f.prev) list = list.filter(t=>t.prevId===f.prev);
  const prevFilterHtml = db.preventivati.length ? `
    <select class="filter-select" onchange="setFilter('task','prev',this.value)">
      <option value="">Tutti i preventivi</option>
      <option value="_none" ${f.prev==='_none'?'selected':''}>Senza preventivo</option>
      ${db.preventivati.filter(p=>!isPrevAuto(p) && p.stato!=='rifiutato').map(p=>`<option value="${p.id}" ${f.prev===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
    </select>` : '';

  document.getElementById('page-task').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Task</div><div class="page-sub">${pending.length} da fare${subtasksAperti?' · '+subtasksAperti+' sotto-task aperti':''}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalTask()">+ Nuovo task</button></div>
    </div>

    ${searchBar('task','Cerca task, sottotask o preventivo...', prevFilterHtml)}
    <div class="task-list" id="task-list">
      ${list.length ? list.map(t=>taskCardHtml(t, dragDisabled)).join('') : emptyState(db.tasks.length ? 'Nessun task corrisponde alla ricerca.' : 'Nessun task ancora. Aggiungi il primo lavoro da fare e organizzalo in sotto-task.')}
    </div>
  `;
  attachTaskDragHandlers();
  document.querySelectorAll('#task-list .subtask-list').forEach(el=>{
    const t = db.tasks.find(x=>x.id===el.dataset.task);
    attachSortable(el, '.subtask-item', '.drag-handle', (id, beforeId)=>{ moveInArray(t.subtasks, id, beforeId); saveDB(); renderAll(); });
  });
}

function taskCardHtml(t, dragDisabled){
  const subs = t.subtasks || [];
  const { total, done, pct } = taskProgress(t);
  const expanded = taskExpanded.has(t.id);
  const overdue = t.dueDate && !t.done && daysUntil(t.dueDate) < 0;
  const evTask = t.prevId ? db.preventivati.find(p=>p.id===t.prevId) : null;
  const prColor = t.priority==='Alta' ? 'var(--coral)' : t.priority==='Media' ? 'var(--amber)' : t.priority==='Bassa' ? 'var(--blue)' : null;
  const prBg = t.priority==='Alta' ? 'var(--coral-dim)' : t.priority==='Media' ? 'var(--amber-dim)' : t.priority==='Bassa' ? 'var(--blue-dim)' : null;

  return `
  <div class="task-card ${t.done?'done':''} ${expanded?'expanded':''} ${overdue?'overdue':''}" data-task-id="${t.id}">
    <div class="task-head" onclick="toggleTaskExpand('${t.id}')">
      ${dragDisabled ? '' : `<div class="task-drag-handle" title="Trascina per riordinare" onclick="event.stopPropagation()"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg></div>`}
      <div class="task-check-wrap" onclick="event.stopPropagation(); toggleTask('${t.id}')">
        <div class="task-check ${t.done?'checked':''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div>
      </div>
      <div class="task-main">
        <div class="task-title-row">
          <div class="task-title ${t.done?'done':''}">${esc(t.text)}</div>
        </div>
        ${t.note ? `<div class="task-note">${esc(t.note)}</div>` : ''}
        <div class="task-meta-row">
          ${evTask ? `<span class="task-pill event-link" onclick="event.stopPropagation(); openPrevDrawer('${evTask.id}')" title="Apri preventivo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${esc(evTask.name)}${t.voceId && evTask.voci ? (v=>v?' · '+esc(v.name):'')(evTask.voci.find(v=>v.id===t.voceId)) : ''}</span>` : (t.prevNome ? `<span class="task-pill" style="background:var(--surface-2); color:var(--text-faint);" title="Preventivo eliminato">${esc(t.prevNome)}</span>` : '')}
          ${t.priority ? `<span class="task-pill" style="background:${prBg}; color:${prColor};">${esc(t.priority)}</span>` : ''}
          ${t.dueDate ? `<span class="task-pill" style="background:${overdue?'var(--coral-dim)':'var(--surface-2)'}; color:${overdue?'var(--coral)':'var(--text-dim)'};">${overdue?'Scaduto ':''}${fmtDate(t.dueDate)}</span>` : ''}
          ${total ? `<span class="task-pill" style="background:var(--surface-2); color:var(--text-dim);">${done}/${total} sotto-task</span>` : ''}
        </div>
        ${total ? `<div class="task-progress-mini"><div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${done===total?'var(--mint)':'var(--blue)'};"></div></div><span>${pct}%</span></div>` : ''}
      </div>
      <div class="task-actions" onclick="event.stopPropagation()">
        <button class="icon-btn" onclick="modalTask('${t.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn btn-danger" onclick="deleteItem('tasks','${t.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
      </div>
      <button class="task-expand-btn" onclick="event.stopPropagation(); toggleTaskExpand('${t.id}')" title="Mostra sotto-task">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    ${expanded ? `
    <div class="task-body">
      <div class="subtask-list" data-task="${t.id}">
        ${subs.length ? subs.map(st=>`
          <div class="subtask-item" data-id="${st.id}">
            <span class="drag-handle" title="Trascina per riordinare">${ICO_GRIP}</span>
            <input type="checkbox" class="subtask-check" ${st.done?'checked':''} onchange="toggleSubtask('${t.id}','${st.id}')">
            <div class="subtask-text ${st.done?'done':''}">${esc(st.text)}</div>
            ${evTask ? voceSelectHtml(evTask, st.voceId||'', `setVoceSub('${t.id}','${st.id}', this.value)`, 'mini') : ''}
            <button class="subtask-del" onclick="deleteSubtask('${t.id}','${st.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
          </div>
        `).join('') : `<div class="row-sub" style="padding:4px;">Nessun sotto-task ancora. Suddividi questo lavoro in passi più piccoli.</div>`}
      </div>
      <div class="add-subtask-row">
        <input type="text" id="subtask-input-${t.id}" placeholder="Aggiungi un sotto-task..." onkeydown="if(event.key==='Enter'){addSubtask('${t.id}')}">
        <button onclick="addSubtask('${t.id}')">+ Aggiungi</button>
      </div>
    </div>
    ` : ''}
  </div>`;
}

function toggleTaskExpand(id){
  if(taskExpanded.has(id)) taskExpanded.delete(id); else taskExpanded.add(id);
  renderTask();
}

/* ---- Riordino task via trascinamento (Pointer Events: funziona con mouse e touch) ---- */
let taskDrag = null;
function attachTaskDragHandlers(){
  document.querySelectorAll('#task-list .task-drag-handle').forEach(handle=>{
    handle.addEventListener('pointerdown', onTaskDragStart);
  });
}
function onTaskDragStart(e){
  e.preventDefault(); e.stopPropagation();
  const card = e.currentTarget.closest('.task-card');
  const listEl = document.getElementById('task-list');
  if(!card || !listEl) return;
  taskDrag = { id: card.dataset.taskId, card, listEl, startY: e.clientY, dropBeforeId: undefined };
  card.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.addEventListener('pointermove', onTaskDragMove);
  document.addEventListener('pointerup', onTaskDragEnd);
}
function onTaskDragMove(e){
  if(!taskDrag) return;
  const dy = e.clientY - taskDrag.startY;
  taskDrag.card.style.transform = `translateY(${dy}px)`;
  taskDrag.card.style.zIndex = 10;
  const siblings = Array.from(taskDrag.listEl.children).filter(c=>c!==taskDrag.card && c.classList.contains('task-card'));
  siblings.forEach(c=>c.classList.remove('drag-over-top'));
  let target = null;
  for(const c of siblings){
    const rect = c.getBoundingClientRect();
    if(e.clientY < rect.top + rect.height/2){ target = c; break; }
  }
  if(target){ target.classList.add('drag-over-top'); taskDrag.dropBeforeId = target.dataset.taskId; }
  else { taskDrag.dropBeforeId = null; } // null = sposta in fondo al gruppo
}
function onTaskDragEnd(){
  if(!taskDrag) return;
  document.removeEventListener('pointermove', onTaskDragMove);
  document.removeEventListener('pointerup', onTaskDragEnd);
  document.body.style.userSelect = '';
  const { id, dropBeforeId } = taskDrag;
  taskDrag.card.classList.remove('dragging');
  taskDrag.card.style.transform = '';
  taskDrag.card.style.zIndex = '';
  document.querySelectorAll('#task-list .task-card').forEach(c=>c.classList.remove('drag-over-top'));
  taskDrag = null;
  if(dropBeforeId !== undefined) reorderTask(id, dropBeforeId);
}
function reorderTask(id, dropBeforeId){
  const fromIdx = db.tasks.findIndex(t=>t.id===id);
  if(fromIdx<0) return;
  const [moved] = db.tasks.splice(fromIdx,1);
  if(dropBeforeId){
    let toIdx = db.tasks.findIndex(t=>t.id===dropBeforeId);
    if(toIdx<0) toIdx = db.tasks.length;
    db.tasks.splice(toIdx,0,moved);
  } else {
    db.tasks.push(moved);
  }
  saveDB(); renderTask();
}

function modalTask(id, presetPrevId){
  const isEdit = !!id;
  const t = isEdit ? db.tasks.find(x=>x.id===id) : null;
  const prevSel = t ? (t.prevId||'') : (presetPrevId||'');
  openModal(`
    <h3>${isEdit?'Modifica task':'Nuovo task'}</h3>
    <div class="field"><label>Cosa c'è da fare</label><input id="f-name" value="${t?esc(t.text):''}" placeholder="Es. Completare il report mensile"></div>
    <div class="field"><label>Note (opzionale)</label><input id="f-note" value="${t?esc(t.note||''):''}" placeholder="Dettagli aggiuntivi"></div>
    <div class="field-row">
      <div class="field"><label>Priorità</label><select id="f-priority">
        <option value="" ${t&&!t.priority?'selected':''}>—</option>
        <option value="Bassa" ${t&&t.priority==='Bassa'?'selected':''}>Bassa</option>
        <option value="Media" ${t&&t.priority==='Media'?'selected':''}>Media</option>
        <option value="Alta" ${t&&t.priority==='Alta'?'selected':''}>Alta</option>
      </select></div>
      <div class="field"><label>Scadenza (opzionale)</label><input id="f-due" type="date" value="${t?t.dueDate||'':''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Preventivo collegato</label><select id="f-task-prev" onchange="aggiornaVociTaskModal()">
        <option value="">Nessuno</option>
        ${db.preventivati.filter(p=>!isPrevAuto(p)).map(p=>`<option value="${p.id}" ${prevSel===p.id?'selected':''}>${esc(p.name)}${p.cliente?' · '+esc(p.cliente):''}</option>`).join('')}
      </select></div>
      <div class="field"><label>Voce del preventivo</label><select id="f-task-voce" data-current="${t?t.voceId||'':''}"></select></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveTask('${id||''}')">${isEdit?'Salva':'Aggiungi'}</button>
    </div>
  `);
  aggiornaVociTaskModal();
}
function aggiornaVociTaskModal(){
  const sel = document.getElementById('f-task-voce'); if(!sel) return;
  const p = db.preventivati.find(x=>x.id===document.getElementById('f-task-prev').value);
  const cur = sel.value || sel.dataset.current || '';
  sel.disabled = !p;
  sel.innerHTML = `<option value="">${p?'Nessuna voce':'—'}</option>` + (p ? p.voci.map(v=>`<option value="${v.id}" ${cur===v.id?'selected':''}>${esc(v.name)}</option>`).join('') : '');
}
function saveTask(id){
  const text = document.getElementById('f-name').value.trim();
  const note = document.getElementById('f-note').value.trim();
  const priority = document.getElementById('f-priority').value;
  const dueDate = document.getElementById('f-due').value;
  const prevId = document.getElementById('f-task-prev').value || null;
  const ev = prevId ? db.preventivati.find(p=>p.id===prevId) : null;
  if(!text) return toast('Inserisci una descrizione.');
  if(id){
    const t = db.tasks.find(x=>x.id===id);
    t.text=text; t.note=note; t.priority=priority; t.dueDate=dueDate;
    if(prevId!==t.prevId){ t.prevId = prevId; t.prevNome = ev ? ev.name : ''; (t.subtasks||[]).forEach(s=>s.voceId=null); }
    t.voceId = ev ? (document.getElementById('f-task-voce').value || null) : null;
  } else {
    db.tasks.push({ id:uid(), text, note, priority, dueDate, done:false, subtasks:[], prevId, prevNome: ev?ev.name:'', voceId: ev ? (document.getElementById('f-task-voce').value||null) : null });
  }
  saveDB(); closeModal(); renderAll(); toast(id?'Task aggiornato.':'Task aggiunto.');
}
function toggleTask(id){ const t=db.tasks.find(x=>x.id===id); t.done=!t.done; saveDB(); renderTask(); updateBadge(); }

function addSubtask(taskId){
  const input = document.getElementById('subtask-input-'+taskId);
  const text = input.value.trim();
  if(!text) return;
  const t = db.tasks.find(x=>x.id===taskId);
  if(!t.subtasks) t.subtasks = [];
  t.subtasks.push({ id:uid(), text, done:false });
  taskExpanded.add(taskId);
  saveDB(); renderTask(); updateBadge();
  const newInput = document.getElementById('subtask-input-'+taskId);
  if(newInput) newInput.focus();
}
function toggleSubtask(taskId, subId){
  const t = db.tasks.find(x=>x.id===taskId);
  const st = (t.subtasks||[]).find(x=>x.id===subId);
  if(!st) return;
  st.done = !st.done;
  saveDB(); renderTask(); updateBadge();
}
function deleteSubtask(taskId, subId){
  const t = db.tasks.find(x=>x.id===taskId);
  t.subtasks = (t.subtasks||[]).filter(x=>x.id!==subId);
  saveDB(); renderTask(); updateBadge();
}

/* ==================== LISTA ACQUISTI ==================== */
function renderAcquisti(){
  const f = filters.acquisti;
  const pending = db.acquisti.filter(a=>!a.bought);
  const totalPending = pending.reduce((s,a)=>s+Number(a.price||0)*Number(a.qty||1),0);
  let list = db.acquisti.slice().sort((a,b)=>a.bought-b.bought);
  if(f.q) list = list.filter(a=> matches(a.name,f.q));
  const now = Date.now();
  const risparmiato = Number(db.risparmiatoRinunce)||0;
  document.getElementById('page-acquisti').innerHTML = `
    <div class="topbar">
      <div>
        <div class="page-title">Lista Acquisti</div>
        <div class="page-sub">${pending.length} da comprare · ${euro(totalPending)} previsti${risparmiato>0?` · <span style="color:var(--mint-strong); font-weight:700;">${euro(risparmiato)} risparmiati rinunciando</span>`:''}</div>
      </div>
      <div class="topbar-actions">
        <button class="btn" onclick="modalOreSettimanali()" title="Imposta le ore settimanali usate per calcolare il costo in ore di lavoro">⏱ ${db.oreSettimanali||40} h/sett.</button>
        <button class="btn btn-primary" onclick="modalAcquisto()">+ Aggiungi</button>
      </div>
    </div>
    ${searchBar('acquisti','Cerca articolo...')}
    <div class="list">
      ${list.length ? list.map(a=>{
        const qty = Number(a.qty||1);
        const totale = Number(a.price||0) * qty;
        const giorniRimasti = a.speseRegistrata && a.dataSpesa ? Math.max(0, 3 - Math.floor((new Date(oggiStr()) - new Date(a.dataSpesa))/86400000)) : null;
        const inRiflessione = a.cooldownUntil && !a.bought;
        const scaduta = inRiflessione && new Date(a.cooldownUntil).getTime() <= now;
        const oreTesto = oreLavoroTesto(totale);
        let subRow;
        if(a.speseRegistrata){
          subRow = `<div class="row-sub">Spesa registrata · verrà rimosso ${giorniRimasti===0?'oggi':'tra '+giorniRimasti+' giorn'+(giorniRimasti===1?'o':'i')}</div>`;
        } else if(inRiflessione && !scaduta){
          const msRimasti = new Date(a.cooldownUntil).getTime() - now;
          const oreRim = Math.floor(msRimasti/3600000), minRim = Math.floor((msRimasti%3600000)/60000);
          subRow = `<div class="row-sub" style="color:var(--amber);">⏳ Ci stai pensando: ancora ${oreRim>0?oreRim+'h ':''}${minRim}min</div>`;
        } else if(a.priority || oreTesto){
          subRow = `<div class="row-sub">${a.priority?'Priorità: '+esc(a.priority):''}${a.priority&&oreTesto?' · ':''}${oreTesto?'≈ '+oreTesto:''}</div>`;
        } else subRow = '';
        return `
        <div class="row-item" style="${a.bought?'opacity:.65;':''} flex-wrap:wrap;">
          <div class="chip-check"><input type="checkbox" ${a.bought?'checked':''} onchange="toggleAcquisto('${a.id}')" ${inRiflessione&&!scaduta?'disabled title="Rifletti ancora prima di comprarlo"':''}></div>
          <div class="row-main">
            <div class="row-title" style="${a.bought?'text-decoration:line-through;':''}">${esc(a.name)}${qty>1?` <span style="color:var(--text-faint); font-weight:500;">× ${qty}</span>`:''}</div>
            ${subRow}
          </div>
          <div class="row-amount">${a.price?euro(totale):'—'}</div>
          <div class="row-actions">
            ${a.bought && !a.speseRegistrata ? `<button class="icon-btn" style="color:var(--coral)" title="Segna come spesa" onclick="modalSpesaAcquisto('${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg></button>` : ''}
            ${!a.bought && !inRiflessione && oreTesto ? `<button class="icon-btn" style="color:var(--amber)" title="Fammi riflettere prima di comprarlo" onclick="modalRiflessione('${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></button>` : ''}
            <button class="icon-btn" onclick="modalAcquisto('${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('acquisti','${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
          ${scaduta ? `
          <div style="flex:1 1 100%; display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; padding:10px 12px; border-radius:12px; background:var(--amber-dim);">
            <span style="font-size:12.5px; font-weight:600; color:var(--amber);">Il tempo per riflettere è finito: lo vuoi ancora?</span>
            <div style="display:flex; gap:8px; flex-shrink:0;">
              <button class="btn" style="padding:6px 12px; font-size:12px;" onclick="decisioneRiflessione('${a.id}', false)">No, rinuncio</button>
              <button class="btn btn-primary" style="padding:6px 12px; font-size:12px;" onclick="decisioneRiflessione('${a.id}', true)">Sì, lo voglio</button>
            </div>
          </div>
          ` : ''}
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

function modalRiflessione(id){
  const a = db.acquisti.find(x=>x.id===id);
  if(!a) return;
  const totale = Number(a.price||0) * Number(a.qty||1);
  const oreTesto = oreLavoroTesto(totale);
  openModal(`
    <h3>Fammi riflettere prima</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">
      "${esc(a.name)}" costa ${euro(totale)}${oreTesto?` — circa <strong style="color:var(--text);">${oreTesto}</strong>`:''}.
      Scegli tra quanto tempo l'app ti chiederà "lo vuoi ancora?".
    </p>
    <div class="field"><label>Tempo per riflettere</label>
      <select id="f-cooldown">
        <option value="24">24 ore</option>
        <option value="72" selected>3 giorni</option>
        <option value="168">7 giorni</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="avviaRiflessione('${id}')">Avvia</button>
    </div>
  `);
}
function avviaRiflessione(id){
  const a = db.acquisti.find(x=>x.id===id);
  if(!a) return;
  const ore = parseInt(document.getElementById('f-cooldown').value,10);
  a.cooldownUntil = new Date(Date.now() + ore*3600000).toISOString();
  a.cooldownHours = ore;
  saveDB(); closeModal(); renderAll(); toast('Ok, te lo richiedo tra qualche giorno.');
}
function decisioneRiflessione(id, lovuoi){
  const a = db.acquisti.find(x=>x.id===id);
  if(!a) return;
  const totale = Number(a.price||0) * Number(a.qty||1);
  if(lovuoi){
    delete a.cooldownUntil; delete a.cooldownHours;
    saveDB(); renderAll(); toast('Va bene, resta nella lista.');
  } else {
    db.acquisti = db.acquisti.filter(x=>x.id!==id);
    db.risparmiatoRinunce = Number(db.risparmiatoRinunce||0) + totale;
    saveDB(); renderAll(); toast(`Bravo! ${euro(totale)} risparmiati.`);
  }
}
function modalOreSettimanali(){
  openModal(`
    <h3>Ore di lavoro settimanali</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Uso il tuo stipendio totale e queste ore per calcolare quanto "costano" in tempo di lavoro i tuoi acquisti.</p>
    <div class="field"><label>Ore a settimana</label><input id="f-ore-sett" type="number" min="1" max="80" step="1" value="${db.oreSettimanali||40}"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaOreSettimanali()">Salva</button>
    </div>
  `);
}
function salvaOreSettimanali(){
  const ore = parseFloat(document.getElementById('f-ore-sett').value);
  if(!ore || ore<=0) return toast('Inserisci un numero valido di ore.');
  db.oreSettimanali = ore;
  saveDB(); closeModal(); renderAll(); toast('Aggiornato.');
}

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
      <div class="row-sub" style="margin:6px 0 14px;">Elimina definitivamente il tuo account e tutti i dati salvati (conti, spese, stipendio, preventivi e tutto il resto). Questa azione non è reversibile.</div>
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
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Questa azione elimina definitivamente il tuo account e tutti i dati salvati: conti, spese, stipendio, preventivi e tutto il resto. Non si può annullare.</p>
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
  if(collection==='preventivati') scollegaTaskEvento(id);
  db[collection] = db[collection].filter(x=>x.id!==id);
  saveDB(); renderAll(); toast('Eliminato.');
}
