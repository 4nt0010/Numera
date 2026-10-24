/* ===================== NUMERA — app.js =====================
   Dati su Firebase: un documento per utente in "numera_data" (tutto il db)
   e uno in "numera_snapshots" (andamento del saldo, un punto al giorno).
   Il salvataggio è raggruppato (debounce) e viene forzato quando l'app
   va in background; al ritorno in primo piano i dati vengono riletti,
   così un altro dispositivo non viene sovrascritto con dati vecchi.
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

/* ---------- Firebase / Firestore / Auth ---------- */
// window._fb e window._fbReady sono impostati dal modulo di init in index.html (eseguito prima di questo file)
const {
  db: firestoreDB, doc, getDoc, setDoc, deleteDoc, auth,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail,
  updateEmail, updatePassword, deleteUser,
  reauthenticateWithCredential, EmailAuthProvider
} = window._fb;

function userRef(collection, uid){ return doc(firestoreDB, collection, uid); }
async function fbLoadDB(uid){
  const snap = await getDoc(userRef('numera_data', uid));
  // merge con i default: i documenti salvati prima dell'introduzione di un campo non lo contengono
  return snap.exists() ? { ...seedDB(), ...snap.data() } : seedDB();
}
async function fbLoadSnapshots(uid){
  const snap = await getDoc(userRef('numera_snapshots', uid));
  return snap.exists() ? (snap.data().list || []) : [];
}
// JSON round-trip: Firestore rifiuta i valori "undefined", così non può mai fallire per quello
function pulito(o){ return JSON.parse(JSON.stringify(o)); }
async function fbPersist(uid, dbData, snaps){
  await Promise.all([
    setDoc(userRef('numera_data', uid), pulito(dbData)),
    setDoc(userRef('numera_snapshots', uid), { list: pulito(snaps) })
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
    'auth/missing-email': 'Inserisci la tua email.',
    'auth/user-not-found': 'Nessun account con questa email.',
    'auth/wrong-password': 'Password errata.',
    'auth/invalid-credential': 'Email o password non corretti.',
    'auth/missing-password': 'Inserisci la password.',
    'auth/email-already-in-use': 'Esiste già un account con questa email.',
    'auth/weak-password': 'La password deve avere almeno 6 caratteri.',
    'auth/too-many-requests': 'Troppi tentativi. Riprova tra qualche minuto.',
    'auth/network-request-failed': 'Errore di connessione. Controlla la rete.',
    'auth/requires-recent-login': 'Per sicurezza, reinserisci la password attuale e riprova.',
    'auth/operation-not-allowed': "Questa operazione richiede di verificare prima la nuova email.",
  };
  return map[code] || 'Si è verificato un errore. Riprova.';
}

/* ---------- stato iniziale vuoto per ogni nuovo utente ---------- */
function seedDB(){
  return {
    accounts: [],
    preventivati: [],
    previsioni: [],
    mancanti: [],
    fisse: [],
    acquisti: [],
    tasks: [],
    stipendi: [],
    movimenti: [],
    budget: {},
    oreSettimanali: 40,
    risparmiatoRinunce: 0,
  };
}

/* ---------- utilità ---------- */
function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
// formato fisso all'italiana (€ 1.288,00) uguale su tutti i browser, anche per le migliaia
function euro(n){
  n = Number(n)||0; if(Math.abs(n)<0.005) n = 0;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return (n<0?'-':'') + '€ ' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}
function fmtNum(n){ return (Number(n)||0).toLocaleString('it-IT',{maximumFractionDigits:2}); }
// legge un importo scritto all'italiana o all'inglese: "1.234,56", "1234,5", "12.50", "€ 40"
function parseNum(v){
  if(typeof v==='number') return isFinite(v) ? v : 0;
  let s = String(v==null?'':v).trim().replace(/[€\s]/g,'');
  if(!s) return 0;
  const hasComma = s.includes(','), dots = (s.match(/\./g)||[]).length;
  if(hasComma){ s = s.replace(/\./g,'').replace(',', '.').replace(/,/g,''); }
  else if(dots>1){ s = s.replace(/\./g,''); }
  else if(dots===1 && /^\-?\d{1,3}\.\d{3}$/.test(s)){ s = s.replace('.',''); }   // "1.500" = millecinquecento
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
// escape per testo e attributi HTML (anche virgolette e apostrofi)
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// argomento stringa sicuro dentro onclick="..." (es. nomi come Dell'Acqua o "Studio")
function jsArg(s){ return esc(JSON.stringify(String(s==null?'':s))); }
/* Helper "chiave" data/mese SENZA toISOString(): .toISOString() converte in UTC e
   con il fuso italiano una mezzanotte locale può scivolare nel giorno precedente. */
function dateKeyFromDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function meseKeyFromDate(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function oggiStr(){ return dateKeyFromDate(new Date()); }
function fmtDate(d){ if(!d) return '—'; const dt = new Date(d+'T00:00:00'); if(isNaN(dt)) return '—'; const opt = {day:'numeric', month:'short'}; if(dt.getFullYear()!==new Date().getFullYear()) opt.year='numeric'; return dt.toLocaleDateString('it-IT',opt); }
function fmtMese(m){ if(!m) return '—'; const [y,mm] = m.split('-'); const dt = new Date(Number(y), Number(mm)-1, 1); const s = dt.toLocaleDateString('it-IT',{month:'long', year:'numeric'}); return s.charAt(0).toUpperCase()+s.slice(1); }
function daysUntil(d){ const dt=new Date(d+'T00:00:00'); const now=new Date(); now.setHours(0,0,0,0); return Math.round((dt-now)/86400000); }

/* ---------- layout: lo stesso criterio del CSS mobile ---------- */
const MOBILE_MQ = window.matchMedia('(max-width:900px), (max-height:500px) and (pointer:coarse)');
function isMobileView(){ return MOBILE_MQ.matches; }
const _onLayoutChange = ()=>{ if(db && session){ renderAll(); } };
if(MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', _onLayoutChange); else if(MOBILE_MQ.addListener) MOBILE_MQ.addListener(_onLayoutChange);

/* ---------- tastiera iOS: il foglio dei modal segue il viewport visibile ---------- */
(function trackVisualViewport(){
  const vv = window.visualViewport; if(!vv) return;
  const root = document.documentElement;
  let raf = 0;
  const update = ()=>{
    raf = 0;
    root.style.setProperty('--vvh', vv.height+'px');
    root.style.setProperty('--vvt', vv.offsetTop+'px');
    const kb = window.innerHeight - vv.height > 140;
    root.classList.toggle('kb-open', kb);
  };
  const schedule = ()=>{ if(!raf) raf = requestAnimationFrame(update); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  update();
})();
// quando un campo viene messo a fuoco dentro un foglio, lo porta in vista sopra la tastiera
document.addEventListener('focusin', e=>{
  const el = e.target;
  if(!(el instanceof HTMLElement) || !el.matches('input, textarea, select')) return;
  if(!el.closest('.modal, .drawer')) return;
  setTimeout(()=>{ try{ el.scrollIntoView({ block:'center', behavior:'smooth' }); }catch(_){} }, 300);
});

setInterval(()=>{
  const activePage = document.querySelector('.page.active');
  const typing = document.activeElement && document.activeElement.matches('input, textarea, select');
  if(activePage && activePage.id==='page-acquisti' && db && !typing && !document.getElementById('modal-overlay').classList.contains('active')) renderAcquisti();
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

/* ---------- salvataggio ---------- */
let _saveTimer = null, _saving = false, _dirty = false, _sizeWarned = false;
function setSyncStatus(txt, warn){
  const el = document.getElementById('sync-status');
  if(el){ el.textContent = txt; el.style.color = warn ? 'var(--coral-soft)' : ''; }
}
function saveDB(){
  if(!session || !db) return;
  const today = oggiStr();
  const total = Math.round(db.accounts.reduce((s,a)=>s+Number(a.balance||0),0)*100)/100;
  const idx = snapshots.findIndex(s=>s.date===today);
  if(idx>=0) snapshots[idx].total = total; else snapshots.push({date:today, total});
  snapshots.sort((a,b)=>a.date.localeCompare(b.date));
  snapshots = snapshots.slice(-370);
  db._rev = Date.now();
  _dirty = true;
  setSyncStatus('Salvataggio…');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, 500);
}
async function flushSave(){
  clearTimeout(_saveTimer); _saveTimer = null;
  if(!_dirty || !session || !db) return;
  if(_saving){ _saveTimer = setTimeout(flushSave, 400); return; }
  _saving = true; _dirty = false;
  const uidNow = session.uid;
  try{
    await fbPersist(uidNow, db, snapshots);
    if(!_dirty) setSyncStatus('Sincronizzato');
    if(!_sizeWarned){
      const kb = JSON.stringify(db).length/1024;
      if(kb > 800){ _sizeWarned = true; toast('Archivio quasi pieno: elimina i movimenti più vecchi che non ti servono.'); }
    }
  }catch(err){
    console.error('Errore salvataggio Firebase:', err);
    _dirty = true;
    setSyncStatus(navigator.onLine===false ? 'Offline · non salvato' : 'Non salvato · riprovo', true);
    _saveTimer = setTimeout(flushSave, 5000);
  }finally{ _saving = false; }
}
function getSnapshots(){ return snapshots; }
// l'app va in background (iPhone: cambio app, blocco schermo): salva subito
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='hidden') flushSave();
  else ricaricaSeCambiato();
});
window.addEventListener('pagehide', ()=>{ flushSave(); });
window.addEventListener('online', ()=>{ if(_dirty) flushSave(); });
window.addEventListener('beforeunload', e=>{ if(_dirty){ flushSave(); e.preventDefault(); e.returnValue=''; } });
// al ritorno in primo piano: se un altro dispositivo ha salvato nel frattempo, ricarica
let _lastCheck = 0;
async function ricaricaSeCambiato(){
  if(!session || !db || _dirty || _saving) return;
  if(Date.now() - _lastCheck < 15000) return;
  _lastCheck = Date.now();
  try{
    const remote = await fbLoadDB(session.uid);
    if(_dirty || !remote || !(remote._rev > (db._rev||0))) return;
    db = remote;
    normalizzaDB();
    snapshots = await fbLoadSnapshots(session.uid);
    renderAll();
    toast('Dati aggiornati dalle modifiche fatte su un altro dispositivo.');
  }catch(err){ console.warn('Controllo aggiornamenti non riuscito:', err); }
}

/* ==================== AUTH ==================== */
let authMode = 'login';
function setAuthMode(mode){
  authMode = mode;
  const isReg = mode==='register';
  document.getElementById('field-name').style.display = isReg ? 'block' : 'none';
  document.getElementById('login-forgot').style.display = isReg ? 'none' : 'block';
  document.getElementById('login-heading').textContent = isReg ? 'Crea account' : 'Bentornato';
  document.getElementById('login-sub').textContent = isReg
    ? 'Registrati con la tua email per proteggere e sincronizzare i tuoi dati finanziari.'
    : 'Accedi al tuo cockpit finanziario per gestire preventivi, conti e clienti.';
  document.getElementById('login-submit').textContent = isReg ? 'Crea account' : 'Accedi';
  document.getElementById('toggle-text').textContent = isReg ? 'Hai già un account?' : 'Non hai un account?';
  document.getElementById('toggle-link').textContent = isReg ? 'Accedi' : 'Registrati';
  document.getElementById('login-password').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
  document.getElementById('login-error').style.display='none';
}
document.getElementById('toggle-link').addEventListener('click', (e)=>{ e.preventDefault(); setAuthMode(authMode==='login' ? 'register' : 'login'); });

document.getElementById('forgot-link').addEventListener('click', async (e)=>{
  e.preventDefault();
  const errBox = document.getElementById('login-error');
  const email = document.getElementById('login-email').value.trim();
  if(!email){ errBox.textContent='Scrivi la tua email qui sopra, poi tocca di nuovo "Password dimenticata?".'; errBox.style.display='block'; return; }
  try{
    await sendPasswordResetEmail(auth, email);
    errBox.style.display='none';
    toast('Email di ripristino inviata: controlla la posta (anche lo spam).');
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
  const showErr = msg=>{ errBox.textContent = msg; errBox.style.display='block'; };
  errBox.style.display='none';
  const submitBtn = document.getElementById('login-submit');
  const prevLabel = submitBtn.textContent;
  try{
    if(authMode==='register'){
      const name = document.getElementById('reg-name').value.trim();
      if(!name || !email || !password) return showErr('Compila nome, email e password.');
      if(password.length < 6) return showErr('La password deve avere almeno 6 caratteri.');
      submitBtn.disabled = true; submitBtn.textContent = 'Attendere…';
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await startSession(name, cred.user.uid);
    } else {
      if(!email || !password) return showErr('Inserisci email e password.');
      submitBtn.disabled = true; submitBtn.textContent = 'Attendere…';
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const name = cred.user.displayName || cred.user.email.split('@')[0];
      await startSession(name, cred.user.uid);
    }
  } catch(err){
    console.error(err);
    showErr(err && err.code ? friendlyAuthError(err.code) : 'Non riesco a caricare i tuoi dati. Controlla la connessione e riprova.');
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = prevLabel;
  }
});

document.getElementById('logout-btn').addEventListener('click', async (e)=>{
  e.stopPropagation();
  await flushSave();
  if(_dirty && !confirm('Alcune modifiche non sono ancora state salvate (sei offline?). Uscire comunque?')) return;
  await signOut(auth).catch(()=>{});
  session = null; db = null; snapshots = []; _dirty = false;
  closeModal(); closePrevDrawer(); closeSidebar();
  Object.values(filters).forEach(f=>Object.keys(f).forEach(k=>f[k]=''));
  prevTab = null;
  document.getElementById('app').classList.remove('active');
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('login-form').reset();
  setAuthMode('login');
});
document.getElementById('user-chip').addEventListener('click', ()=> goToPage('account'));

// porta i dati salvati da qualsiasi versione precedente al formato attuale
function normalizzaDB(){
  const def = seedDB();
  Object.keys(def).forEach(k=>{ if(db[k]===undefined || db[k]===null) db[k] = def[k]; });
  ['accounts','preventivati','previsioni','mancanti','fisse','acquisti','tasks','stipendi','movimenti'].forEach(k=>{ if(!Array.isArray(db[k])) db[k] = []; });
  if(db.stipendio){
    // vecchio modello a singolo stipendio
    if(!db.stipendi.length) db.stipendi = [{ id:uid(), nome:'Stipendio', base:db.stipendio.base||0, eccezioni:db.stipendio.eccezioni||[], ricevuti:db.stipendio.ricevuti||[] }];
    delete db.stipendio;
  }
  db.stipendi.forEach(st=>{ if(!Array.isArray(st.eccezioni)) st.eccezioni=[]; if(!Array.isArray(st.ricevuti)) st.ricevuti=[]; });
  delete db.obiettivi;
  // le previsioni dello stipendio stavano dentro i preventivi: ora hanno una lista loro
  db.preventivati = db.preventivati.filter(p=>{
    if(p && p.fromStipendioId){
      if(!db.previsioni.some(x=>x.fromStipendioId===p.fromStipendioId && x.fromStipendioMese===p.fromStipendioMese))
        db.previsioni.push({ id:p.id, name:p.name, amount:Number(p.amount)||0, date:p.date, fromStipendioId:p.fromStipendioId, fromStipendioMese:p.fromStipendioMese });
      return false;
    }
    return !!p;
  });
  db.tasks.forEach(t=>{ if(!Array.isArray(t.subtasks)) t.subtasks = []; });
  db.accounts.forEach(a=>{ a.balance = Number(a.balance)||0; });
}

let _starting = null;
async function startSession(name, userId){
  if(_starting) return _starting;
  _starting = (async ()=>{
    const loadedDb = await fbLoadDB(userId);
    const loadedSnaps = await fbLoadSnapshots(userId);
    session = { name, uid: userId };
    db = loadedDb;
    normalizzaDB();
    snapshots = loadedSnaps;
    document.getElementById('login-screen').style.display='none';
    document.getElementById('app').classList.add('active');
    document.getElementById('user-name-display').textContent = name;
    document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
    goToPage('dashboard', true);
    renderAll();
    saveDB();
  })();
  try{ await _starting; } finally { _starting = null; }
}

/* auto-login: se Firebase Auth ha già un utente valido (sessione persistente) */
(async function initAuth(){
  const user = await window._fbReady;
  if(user){
    const name = user.displayName || (user.email ? user.email.split('@')[0] : 'Utente');
    try{ await startSession(name, user.uid); }
    catch(err){
      console.error(err);
      const errBox = document.getElementById('login-error');
      errBox.textContent = 'Non riesco a caricare i tuoi dati. Controlla la connessione e accedi di nuovo.';
      errBox.style.display = 'block';
    }
  }
})();

/* ==================== NAV ==================== */
let currentPage = 'dashboard';
function goToPage(pageKey, silent){
  if(!document.getElementById('page-'+pageKey)) pageKey = 'dashboard';
  const cambio = pageKey!==currentPage;
  currentPage = pageKey;
  document.querySelectorAll('.nav-item').forEach(i=>i.classList.toggle('active', i.dataset.page===pageKey));
  document.querySelectorAll('.bn-item[data-page]').forEach(i=>i.classList.toggle('active', i.dataset.page===pageKey));
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.id==='page-'+pageKey));
  const mainEl = document.getElementById('main');
  mainEl.classList.toggle('dash-active', pageKey==='dashboard');
  mainEl.classList.toggle('sim-active', pageKey==='simulatore');
  if(prevDrawerId) closePrevDrawer();
  closeSidebar();
  if(!db) return;
  if(pageKey==='dashboard') renderDashboard();
  if(pageKey==='simulatore'){
    if(!simInitialized){ simState.saldo = computeTotals().totalConti; simInitialized = true; }
    renderSimulatore();
    if(cambio && !silent) playSimIntro();
  }
  if(cambio || silent){ mainEl.scrollTop = 0; animaEntrata(pageKey); }
}
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click', ()=> goToPage(item.dataset.page));
});
document.querySelectorAll('.bn-item[data-page]').forEach(item=>{
  item.addEventListener('click', ()=>{
    // tocco sulla pagina già aperta: torna in cima, come nelle app iOS
    if(item.dataset.page===currentPage){ document.getElementById('main').scrollTo({ top:0, behavior:'smooth' }); return; }
    goToPage(item.dataset.page);
  });
});

// effetto di comparsa: solo quando si cambia pagina, non a ogni aggiornamento dei dati
let _enterTimer;
function animaEntrata(pageKey){
  const els = [document.getElementById('page-'+pageKey), pageKey==='dashboard' ? document.getElementById('mobile-dash-root') : null].filter(Boolean);
  els.forEach(el=>{ el.classList.remove('page-enter'); void el.offsetWidth; el.classList.add('page-enter'); });
  clearTimeout(_enterTimer);
  _enterTimer = setTimeout(()=> els.forEach(el=>el.classList.remove('page-enter')), 900);
}

/* ==================== MENU LATERALE (mobile) ==================== */
function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('active');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
}
document.getElementById('bn-menu-btn').addEventListener('click', openSidebar);
document.getElementById('sidebar-close-btn').addEventListener('click', closeSidebar);
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

/* ==================== KPI ==================== */
function computeTotals(){
  const r2 = n=>Math.round(n*100)/100;
  const totalConti = r2(db.accounts.reduce((s,a)=>s+Number(a.balance||0),0));
  const prevOk = db.preventivati.filter(p=>p.stato==='accettato' && !prevInRitardo(p)).reduce((s,p)=>s+Number(p.amount||0),0);
  const stipendiPrevisti = db.previsioni.reduce((s,p)=>s+Number(p.amount||0),0);
  const totalPrev = r2(prevOk + stipendiPrevisti);
  const totalMancanti = r2(db.mancanti.reduce((s,a)=>s+Number(a.amount||0),0) + db.preventivati.filter(prevInRitardo).reduce((s,p)=>s+Number(p.amount||0),0));
  const totaleGenerale = r2(totalConti + totalPrev + totalMancanti);
  return { totalConti, totalPrev, totalMancanti, totaleGenerale };
}
function computeTrendPct(currentTotal){
  const t = dashTrend();
  return t && t.pct!==null && isFinite(t.pct) ? t.pct : null;
}
function getStipendioMensileTotale(){
  return db.stipendi.reduce((s,st)=> s + Number(st.base||0), 0);
}
function getTariffaOraria(){
  const mensile = getStipendioMensileTotale();
  const oreSett = Number(db.oreSettimanali) || 40;
  if(!mensile || !oreSett) return 0;
  return mensile / (oreSett * 4.345); // 4,345 = settimane medie in un mese
}
function oreLavoroTesto(prezzo){
  const tariffa = getTariffaOraria();
  if(!tariffa || !prezzo) return null;
  const ore = prezzo / tariffa;
  if(ore < 1) return Math.max(1, Math.round(ore*60)) + ' min di lavoro';
  if(ore < 10) return ore.toFixed(1).replace(/\.0$/,'').replace('.',',') + ' h di lavoro';
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
  if(pct===null){ trendEl.style.display = 'none'; return; }
  const up = pct>=0;
  trendEl.style.display = 'inline-flex';
  trendEl.style.background = up ? 'var(--mint-dim)' : 'var(--coral-dim)';
  trendEl.style.color = up ? 'var(--mint-strong)' : 'var(--coral-soft)';
  trendEl.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5">${up ? '<path d="M5 12l5-5 5 5M10 7v10"/>' : '<path d="M5 12l5 5 5-5M10 17V7"/>'}</svg>${Math.abs(pct).toFixed(1).replace('.',',')}%`;
}

/* ==================== TOAST ==================== */
let toastTimer, toastAction = null;
function toast(msg, action){
  const t = document.getElementById('toast');
  document.getElementById('toast-text').textContent = msg;
  let btn = t.querySelector('.toast-action');
  if(action){
    if(!btn){
      btn = document.createElement('button'); btn.className = 'toast-action';
      btn.addEventListener('click', ()=>{ const f = toastAction; toastAction = null; t.classList.remove('show'); if(f) f(); });
      t.appendChild(btn);
    }
    btn.textContent = action.label; btn.style.display = '';
    toastAction = action.fn;
  } else if(btn){ btn.style.display = 'none'; toastAction = null; }
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ t.classList.remove('show'); toastAction = null; }, action ? 6000 : Math.min(5000, 1800 + msg.length*30));
}

/* ==================== MODAL ==================== */
const overlay = document.getElementById('modal-overlay');
const modalEl = document.getElementById('modal-content');
function syncOverlayState(){
  const aperto = overlay.classList.contains('active') || !!prevDrawerId;
  document.documentElement.classList.toggle('modal-open', aperto);
}
function openModal(html, extraClass){
  document.getElementById('dr-menu')?.classList.remove('open');
  modalEl.className = 'modal' + (extraClass ? ' '+extraClass : '');
  modalEl.innerHTML = html;
  modalEl.scrollTop = 0;
  overlay.classList.add('active');
  syncOverlayState();
  // su desktop porta subito il cursore nel primo campo; su iPhone no (aprirebbe la tastiera sopra il foglio)
  if(!isMobileView()){
    const first = modalEl.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([readonly]), textarea:not([readonly])');
    if(first) setTimeout(()=>first.focus(), 60);
  }
}
function closeModal(){
  if(document.activeElement && modalEl.contains(document.activeElement)) document.activeElement.blur();
  overlay.classList.remove('active');
  modalEl.innerHTML='';
  syncOverlayState();
}
overlay.addEventListener('click', (e)=>{ if(e.target===overlay) closeModal(); });
document.getElementById('drawer-overlay').addEventListener('click', (e)=>{ if(e.target.id==='drawer-overlay') closePrevDrawer(); });
document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape'){
    if(overlay.classList.contains('active')) closeModal();
    else if(prevDrawerId) closePrevDrawer();
    else closeSidebar();
    return;
  }
  // Invio in un campo di un modal = pulsante principale (tranne nelle aree di testo)
  if(e.key==='Enter' && overlay.classList.contains('active') && e.target.matches('.modal input:not([type=checkbox]):not([type=radio])') && !e.target.closest('.ve-row') && !e.isComposing){
    const primary = modalEl.querySelector('.modal-actions .btn-primary, .modal-actions .btn-danger-solid');
    if(primary){ e.preventDefault(); primary.click(); }
  }
});

/* ==================== RENDER ==================== */
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
      el.focus({ preventScroll:true });
      if(selStart!==null && el.setSelectionRange){ try{ el.setSelectionRange(selStart, selEnd); }catch(_){} }
    }
  }
}
function searchBar(page, placeholder, extraHtml){
  return `
    <div class="filter-bar">
      <div class="search-input">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="search-${page}" type="search" enterkeyhint="search" autocomplete="off" value="${esc(filters[page].q)}" placeholder="${esc(placeholder)}" oninput="setFilter('${page}','q',this.value)" aria-label="${esc(placeholder)}">
      </div>
      ${extraHtml||''}
    </div>
  `;
}
function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
function matches(text, q){ return !q || norm(text).includes(norm(q.trim())); }

/* ==================== VISTA CALENDARIO (preventivi) ==================== */
let calendarState = {
  preventivati: { on:false, mese:null },
};
function setVistaCalendario(pageKey, on){
  if(!calendarState[pageKey].mese) calendarState[pageKey].mese = meseChiave(0);
  calendarState[pageKey].on = on;
  renderPreventivati();
}
function cambiaMeseCalendario(pageKey, delta){
  const st = calendarState[pageKey];
  const [y,m] = st.mese.split('-').map(Number);
  st.mese = meseKeyFromDate(new Date(y, m-1+delta, 1));
  renderPreventivati();
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
    if(p.stato!=='rifiutato' && p.date && p.date.slice(0,7)===meseKey){
      const giorno = Number(p.date.slice(8,10));
      (eventiPerGiorno[giorno] = eventiPerGiorno[giorno] || []).push(p);
    }
  });
  const colore = p=> prevInRitardo(p) ? '#FF453A' : statoInfo(p.stato).color;
  const celle = [];
  for(let i=0;i<primoGiornoIdx;i++) celle.push('<div class="cal-day cal-day-empty"></div>');
  for(let d=1; d<=giorni; d++){
    const dataStr = `${meseKey}-${String(d).padStart(2,'0')}`;
    const evs = eventiPerGiorno[d] || [];
    celle.push(`
      <div class="cal-day ${dataStr===oggiVal?'cal-day-oggi':''} ${evs.length?'has-events':''}" ${evs.length?`onclick="modalGiornoEventi('${dataStr}')" role="button" aria-label="${evs.length} preventivi il ${d}"`:''}>
        <div class="cal-day-num">${d}</div>
        <div class="cal-day-events">
          ${evs.slice(0,2).map(e=>`<div class="cal-event" style="background:${colore(e)}22; color:${colore(e)};">${esc(e.name)}</div>`).join('')}
          ${evs.length>2 ? `<div class="cal-event-more">+${evs.length-2} altri</div>` : ''}
        </div>
        ${evs.length ? `<div class="cal-dots">${evs.slice(0,4).map(e=>`<i style="background:${colore(e)}"></i>`).join('')}</div>` : ''}
      </div>
    `);
  }
  return `
    <div class="cal-header">
      <button class="icon-btn" aria-label="Mese precedente" onclick="cambiaMeseCalendario('${pageKey}',-1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
      <div class="cal-header-title">${fmtMese(meseKey)}</div>
      <button class="icon-btn" aria-label="Mese successivo" onclick="cambiaMeseCalendario('${pageKey}',1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
    <div class="cal-grid cal-grid-labels">
      <div class="cal-weekday">Lun</div><div class="cal-weekday">Mar</div><div class="cal-weekday">Mer</div><div class="cal-weekday">Gio</div><div class="cal-weekday">Ven</div><div class="cal-weekday">Sab</div><div class="cal-weekday">Dom</div>
    </div>
    <div class="cal-grid">${celle.join('')}</div>
  `;
}
function modalGiornoEventi(dataStr){
  const evs = db.preventivati.filter(p=>p.date===dataStr && p.stato!=='rifiutato');
  if(!evs.length) return;
  if(evs.length===1) return openPrevDrawer(evs[0].id);
  openModal(`
    <h3>${fmtDate(dataStr)}</h3>
    <div class="list" style="margin-top:14px;">
      ${evs.map(p=>`
        <div class="row-item clickable" onclick="closeModal(); openPrevDrawer('${p.id}')">
          <div class="row-icon" style="background:${p.color}1f; color:${p.color};">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
          <div class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${esc(p.cliente||'')} ${statoInfo(p.stato).label}</div></div>
          <div class="row-amount">${euro(prevStats(p).totale)}</div>
        </div>
      `).join('')}
    </div>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div>
  `);
}

function renderAll(){
  if(!db) return;
  [ ()=>checkStipendioAutomatico(), ()=>checkPrevisioniScadute(), ()=>checkSpeseFisseAutomatiche(), ()=>checkAcquistiDaRimuovere() ]
    .forEach(fn=>{ try{ fn(); }catch(err){ console.error('Controllo automatico non riuscito:', err); } });
  db.preventivati.forEach(p=>{ try{ migratePrev(p); }catch(err){ console.error('Preventivo non valido:', p, err); } });
  const renderers = [renderKpiBar, renderDashboard, renderConti, renderSpese, renderStipendio, renderPreventivati, renderMancanti, renderFisse, renderClienti, renderAcquisti, renderTask, renderAccount, renderPrevDrawer];
  if(currentPage==='simulatore') renderers.push(renderSimulatore);
  renderers.forEach(fn=>{
    try{ fn(); }
    catch(err){ console.error(`Errore in ${fn.name}:`, err); }
  });
  updateBadge();
}
function setBadge(id, n){
  const b = document.getElementById(id);
  b.textContent = n || '';
  b.style.display = n ? 'inline-block' : 'none';
}
function updateBadge(){
  setBadge('badge-mancanti', db.mancanti.length + prevMancanti().length);
  const imminenti = db.preventivati.filter(p=>{
    if(!p.date || !['accettato','inviato'].includes(p.stato)) return false;
    const d = daysUntil(p.date);
    return d>=0 && d<=3;
  }).length;
  setBadge('badge-preventivati', imminenti);
  document.getElementById('badge-preventivati').classList.add('amber');
  setBadge('badge-task', db.tasks.filter(t=>!t.done).length);
}

/* ==================== DASHBOARD ==================== */
let chartTrend;
/*
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
  { label:'Da ricevere', fn:'modalMancante()', bg:'var(--coral-dim)', color:'var(--coral)', ico:'alert' },
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
  if(snaps.length < 2) return null;
  const totalConti = computeTotals().totalConti;
  const d = new Date(); d.setDate(d.getDate()-30);
  const cutoff = dateKeyFromDate(d);
  const past = snaps.filter(s=> s.date <= cutoff);
  const ref = past.length ? past[past.length-1] : snaps[0];
  if(!ref || ref.date===oggiStr()) return null;
  const abs = Math.round((totalConti - Number(ref.total||0))*100)/100;
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
  const prevSeguire = db.preventivati.filter(p=>['accettato','inviato'].includes(p.stato))
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
  const accettati = db.preventivati.filter(p=>p.stato==='accettato').length;

  const hero = `
    <div class="card dash-card dash-hero">
      <div class="dash-hero-top">
        <div><div class="dash-hero-label">Saldo sui conti</div><div class="dash-hero-amount">${euro(D.totalConti)}</div></div>
        ${trendHtml}
      </div>
      <div class="dash-hero-chart"><canvas id="chart-trend"></canvas></div>
      <div class="dash-hero-stats">
        <button class="dash-hero-stat" onclick="goToPage('preventivati')">
          <div class="dash-hero-stat-label"><i style="background:var(--blue)"></i>In arrivo</div>
          <div class="dash-hero-stat-value" style="color:var(--blue)">${euro(D.totalPrev)}</div>
          <div class="dash-hero-stat-hint">${plur(accettati,'preventivo confermato','preventivi confermati')}</div>
        </button>
        <button class="dash-hero-stat" onclick="goToPage('mancanti')">
          <div class="dash-hero-stat-label"><i style="background:var(--coral)"></i>In ritardo</div>
          <div class="dash-hero-stat-value" style="color:var(--coral-soft)">${euro(D.totalMancanti)}</div>
          <div class="dash-hero-stat-hint">in ritardo o da recuperare</div>
        </button>
        <div class="dash-hero-stat">
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
        return `<div class="mini-row block">
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
            <div class="mini-sub">${p.stato==='inviato'?'<span style="color:var(--blue-soft)">In attesa di risposta</span>':rit?'<span style="color:var(--coral-soft)">In ritardo · lavoro già svolto</span>':quandoTesto(p.date)}${p.cliente?' · '+esc(p.cliente):''}${ts.n?` · ${ts.fatte}/${ts.n} lavori`:''}</div>
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
        return `<div class="mini-row block">
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
  const prevAcc = db.preventivati.filter(p=>p.stato==='accettato');
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
        <button class="m-stat" onclick="goToPage('preventivati')"><span>In arrivo</span><b style="color:var(--blue-soft)">${euro(D.totalPrev)}</b><small>previsti</small></button>
        <button class="m-stat" onclick="goToPage('mancanti')"><span>In ritardo</span><b style="color:var(--coral-soft)">${euro(D.totalMancanti)}</b><small>da recuperare</small></button>
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
        x:{ grid:{display:false}, ticks:{ color:'#66796F', font:{size:10}, maxTicksLimit:6, maxRotation:0 } },
        y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{ color:'#66796F', font:{size:10}, maxTicksLimit:5, callback:v=>'€ '+Number(v).toLocaleString('it-IT',{maximumFractionDigits:0}) } }
      }
    }
  });
}
function emptyState(msg){
  return `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 15c1 1.2 2.4 2 4 2s3-.8 4-2"/></svg><p>${msg}</p></div>`;
}

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
    <div class="field"><label>Saldo attuale (€)</label><input id="f-balance" type="text" inputmode="decimal" autocomplete="off" value="${a?a.balance:''}" placeholder="0,00"></div>
    ${isEdit ? `<p style="color:var(--text-faint); font-size:11.5px; margin:-8px 0 12px;">Se cambi il saldo, l'app registra da sola un movimento di rettifica per tenere tutto coerente.</p>` : ''}
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
  const balance = parseNum(document.getElementById('f-balance').value)||0;
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
      <div><div class="page-title">Movimenti</div><div class="page-sub">${plur(db.movimenti.length,'movimento','movimenti')} · aggiornano il saldo del conto in automatico</div></div>
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
      <div class="segmented">
        <label><input type="radio" name="f-mov-tipo" value="uscita" ${tipo==='uscita'?'checked':''} onchange="toggleMovTipo('uscita')">Spesa</label>
        <label><input type="radio" name="f-mov-tipo" value="entrata" ${tipo==='entrata'?'checked':''} onchange="toggleMovTipo('entrata')">Entrata</label>
        <label><input type="radio" name="f-mov-tipo" value="trasferimento" ${tipo==='trasferimento'?'checked':''} onchange="toggleMovTipo('trasferimento')">Sposta</label>
      </div>
    </div>
    <div class="field"><label>Descrizione</label><input id="f-mov-name" value="${m?esc(m.name):(tipo==='trasferimento'?'Trasferimento':'')}" placeholder="Es. Spesa al supermercato"></div>
    <div class="field-row">
      <div class="field"><label>Importo (€)</label><input id="f-mov-amount" type="text" inputmode="decimal" autocomplete="off" value="${m?m.amount:''}" placeholder="0,00"></div>
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
  const amount = Math.round(parseNum(document.getElementById('f-mov-amount').value)*100)/100;
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
    // incasso di un preventivo: tiene allineato il pagamento collegato
    if(m.fromPrev){
      const p = db.preventivati.find(x=>x.id===m.fromPrev);
      const pag = p && p.pagamenti.find(x=>x.movId===m.id);
      if(pag){
        if(m.type==='entrata'){ pag.amount = m.amount; pag.date = m.date; pag.accountId = m.accountId; }
        else { p.pagamenti = p.pagamenti.filter(x=>x!==pag); delete m.fromPrev; }
        recalcPrev(p);
      }
    }
  } else {
    const m = { id:uid(), ...data };
    db.movimenti.push(m);
    applyMovimentoEffect(m, +1);
  }

  saveDB(); closeModal(); renderAll();
  toast(type==='trasferimento' ? 'Trasferimento registrato.' : type==='uscita' ? 'Spesa registrata, saldo aggiornato.' : 'Entrata registrata, saldo aggiornato.');
}
function modalBudget(){
  openModal(`
    <h3>Budget mensile per categoria</h3>
    <p style="color:var(--text-dim); font-size:13px; margin-bottom:16px;">Imposta un limite di spesa mensile per ogni categoria. Lascia vuoto per non impostare un limite.</p>
    ${CATEGORIE.map(c=>`
      <div class="field">
        <label>${esc(c.label)}</label>
        <input id="f-budget-${c.key}" type="text" inputmode="decimal" autocomplete="off" value="${db.budget[c.key]||''}" placeholder="Nessun limite">
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
    const val = parseNum(document.getElementById(`f-budget-${c.key}`).value);
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
    const giaInPreventivati = db.previsioni.some(p=>p.fromStipendioId===st.id && p.fromStipendioMese===meseScorso);
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
    const giaTracciatoCorrente = db.previsioni.some(p=>p.fromStipendioId===st.id && p.fromStipendioMese===meseCorrente) || db.mancanti.some(m=>m.fromStipendioId===st.id && m.fromStipendioMese===meseCorrente);
    if(!giaRicevutoCorrente && !giaTracciatoCorrente){
      const stima = stipendioPerMese(st, meseCorrente);
      if(stima>0){
        db.previsioni.push({ id:uid(), name:`${st.nome} ${fmtMese(meseCorrente)}`, amount:stima, date:ultimoGiornoMese(meseCorrente), note:'Stima automatica dalla sezione Stipendio', color:'#0A84FF', fromStipendioId:st.id, fromStipendioMese:meseCorrente });
        changed = true;
      }
    }
  });

  if(changed) saveDB();
}
function checkPrevisioniScadute(){
  // la previsione dello stipendio ha come data l'ultimo giorno del mese:
  // il giorno dopo, se non è stata segnata come ricevuta, passa in "Da ricevere".
  if(!db || !session) return;
  const oggiVal = oggiStr();
  let changed = false;
  db.previsioni = db.previsioni.filter(p=>{
    if(p.date && p.date < oggiVal){
      db.mancanti.push({ id:uid(), name:p.name, amount:p.amount, fromStipendioId:p.fromStipendioId, fromStipendioMese:p.fromStipendioMese, note:"Stima, da confermare all'accredito" });
      changed = true;
      return false;
    }
    return true;
  });
  if(changed) saveDB();
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
  const preventivoCorrente = db.previsioni.find(p=>p.fromStipendioId===st.id && p.fromStipendioMese===meseCorrente);

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
            <div class="row-sub">${ricevutoScorso ? 'Già accreditato su un conto' : mancanteScorso ? "Non ancora arrivato · è tra i soldi da ricevere" : 'Nessuna stima disponibile'}</div>
          </div>
          ${ricevutoScorso ? `<span class="pill" style="background:var(--mint-dim); color:var(--mint);">✓ Ricevuto</span>` : mancanteScorso ? `<button class="btn btn-sm btn-primary" onclick="modalAccreditaStipendio('${mancanteScorso.id}')">Ricevuto</button>` : ''}
        </div>
        <div class="row-item">
          <div class="row-icon" style="background:var(--blue-dim); color:var(--blue);">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          </div>
          <div class="row-main">
            <div class="row-title">Stipendio di ${fmtMese(meseCorrente)}</div>
            <div class="row-sub">${preventivoCorrente ? `${euro(preventivoCorrente.amount)} previsti a fine mese · se non lo segni come ricevuto, il 1° ${fmtMese(meseSuccessivoChiave(meseCorrente)).toLowerCase()} passa in "Da ricevere"` : 'Nessuna stima disponibile'}</div>
          </div>
          ${preventivoCorrente ? `<button class="btn btn-sm btn-primary" onclick="incassaPrevisione('${preventivoCorrente.id}')">Ricevuto</button>` : ''}
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
    <div class="field"><label>Importo mensile (€)</label><input id="f-stip-base-nuovo" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="creaStipendio()">Crea</button>
    </div>
  `);
}
function creaStipendio(){
  const nome = document.getElementById('f-stip-nome').value.trim();
  const base = parseNum(document.getElementById('f-stip-base-nuovo').value)||0;
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
    <div class="field"><label>Importo mensile (€)</label><input id="f-stip-base" type="text" inputmode="decimal" autocomplete="off" value="${st.base || ''}" placeholder="0,00"></div>
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
  const amount = parseNum(document.getElementById('f-stip-base').value)||0;
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
      <div class="field"><label>Importo (€)</label><input id="f-ecc-amount" type="text" inputmode="decimal" autocomplete="off" value="${e?e.amount:''}" placeholder="0,00"></div>
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
  const amount = parseNum(document.getElementById('f-ecc-amount').value)||0;
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

/* ==================== PREVENTIVI ====================
   Un preventivo ha: numero, cliente, titolo, data del lavoro, voci (quantità × prezzo),
   sconto, acconto richiesto, note e una lista di pagamenti ricevuti.
   Stati (le chiavi restano quelle salvate su Firebase, cambiano solo le etichette):
     bozza → inviato → accettato ("Confermato") → completato ("Pagato", solo in automatico)
     rifiutato = archiviato
   Il KPI "In arrivo" conta il residuo dei preventivi confermati; se la data del lavoro
   è passata e manca ancora qualcosa, quel residuo conta come "In ritardo".
   Le previsioni dello stipendio NON sono preventivi: vivono in db.previsioni.
======================================================== */
const PREV_STATI = [
  { key:'bozza',      label:'Bozza',      color:'#9AA3A0' },
  { key:'inviato',    label:'Inviato',    color:'#0A84FF' },
  { key:'accettato',  label:'Confermato', color:'#30D158' },
  { key:'completato', label:'Pagato',     color:'#64D2FF' },
  { key:'rifiutato',  label:'Rifiutato',  color:'#FF453A' },
];
const PREV_TABS = [
  { key:'incassare', label:'Da incassare', match:p=>p.stato==='accettato' },
  { key:'attesa',    label:'In attesa',    match:p=>p.stato==='bozza' || p.stato==='inviato' },
  { key:'archivio',  label:'Archivio',     match:p=>p.stato==='completato' || p.stato==='rifiutato' },
];
let prevTab = null;            // scelta automatica alla prima apertura
let prevDrawerId = null;
let prevDrawerTab = 'voci';
let prevVoceFilter = '';
let prevDraft = [];

const ICO_CHECK_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M20 6L9 17l-5-5"/></svg>';
const ICO_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
const ICO_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
const ICO_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const ICO_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>';
const ICO_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg>';
const ICO_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
const ICO_DUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4h10a2 2 0 012 2v10M4 8h10a2 2 0 012 2v10H6a2 2 0 01-2-2z"/></svg>';
const ICO_FLAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22V4M4 4h13l-2 4 2 4H4"/></svg>';
const ICO_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>';
const ICO_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';

function statoInfo(k){ return PREV_STATI.find(s=>s.key===k) || PREV_STATI[0]; }
function statoBadge(k){ const s = statoInfo(k); return `<span class="pv-badge" style="background:${s.color}22; color:${s.color};">${s.label}</span>`; }
function statoPill(k){ const s = statoInfo(k); return `<span class="pill" style="background:${s.color}22; color:${s.color};">${s.label}</span>`; }
function prossimoNumeroPrev(){
  const anno = new Date().getFullYear();
  const max = db.preventivati.reduce((m,p)=>{
    const r = /^P-(\d{4})-(\d+)$/.exec(p.numero||'');
    return r && Number(r[1])===anno ? Math.max(m, Number(r[2])) : m;
  }, 0);
  return `P-${anno}-${String(max+1).padStart(3,'0')}`;
}
function round2(n){ return Math.round((Number(n)||0)*100)/100; }

// porta al formato attuale i preventivi di tutte le versioni precedenti
function migratePrev(p){
  if(!p.stato){ p.stato = 'accettato'; p.importato = true; }
  if(!PREV_STATI.some(s=>s.key===p.stato)) p.stato = 'bozza';
  if(!p.name) p.name = 'Preventivo';
  if(!p.color) p.color = ICON_COLORS[0];
  if(!Array.isArray(p.voci) || !p.voci.length){
    p.voci = [{ id:uid(), name:'Importo', desc:'', qty:1, price:Number(p.amount)||0, amount:Number(p.amount)||0 }];
  }
  if(!Array.isArray(p.pagamenti)) p.pagamenti = [];
  p.voci.forEach(v=>{
    if(!v.id) v.id = uid();
    if(v.qty===undefined || v.qty==='') v.qty = 1;
    if(v.price===undefined || v.price==='') v.price = Number(v.amount)||0;
    if(v.desc===undefined) v.desc = '';
    v.amount = round2(Number(v.qty)*Number(v.price));
    // versione precedente: le voci si incassavano singolarmente → diventano pagamenti
    if(v.done){
      p.pagamenti.push({ id:uid(), tipo:'pagamento', nota:v.name, amount:Number(v.amount)||0, date:v.doneDate||oggiStr(), accountId:v.accountId||null, giaSulConto:true });
      delete v.done; delete v.doneDate; delete v.accountId;
    }
  });
  if(p.sconto===undefined) p.sconto = 0;
  if(p.acconto===undefined) p.acconto = 0;
  if(!p.numero) p.numero = prossimoNumeroPrev();
  if(p.cliente===undefined) p.cliente = '';
  recalcPrev(p);
}

function prevStats(p){
  const voci = p.voci||[], pag = p.pagamenti||[];
  const lordo = round2(voci.reduce((s,v)=>s+Number(v.amount||0),0));
  const totale = Math.max(0, round2(lordo - Number(p.sconto||0)));
  const incassato = round2(pag.reduce((s,x)=>s+Number(x.amount||0),0));
  const residuo = Math.max(0, round2(totale-incassato));
  const accontoRic = round2(pag.filter(x=>x.tipo==='acconto').reduce((s,x)=>s+Number(x.amount||0),0));
  // l'acconto si considera ricevuto anche se è arrivato come pagamento generico
  const accontoDovuto = Math.max(0, round2(Math.min(Number(p.acconto||0), totale) - incassato));
  return { lordo, totale, incassato, residuo, n:voci.length, nPag:pag.length, accontoRic, accontoDovuto, pct: totale ? Math.min(100, Math.round(incassato/totale*100)) : 0 };
}
function recalcPrev(p){
  const st = prevStats(p);
  if(p.stato==='completato' && st.residuo>0){ p.stato = 'accettato'; p.completatoIl = null; }
  if(p.stato==='accettato' && st.residuo<=0 && st.totale>0){ p.stato = 'completato'; if(!p.completatoIl) p.completatoIl = oggiStr(); }
  p.amount = p.stato==='accettato' ? st.residuo : 0;
}
function prevInRitardo(p){ return p.stato==='accettato' && p.amount>0 && !!p.date && p.date < oggiStr(); }
function prevMancanti(){ return db.preventivati.filter(prevInRitardo).sort((a,b)=>(a.date||'').localeCompare(b.date||'')); }
function prevTasks(pid){ return db.tasks.filter(t=>t.prevId===pid); }
function prevTaskStats(pid){
  const l = prevTasks(pid);
  const subs = l.flatMap(t=>t.subtasks||[]);
  return { n:l.length, fatte:l.filter(t=>t.done).length, subN:subs.length, subFatte:subs.filter(s=>s.done).length };
}
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
  return d===0 ? 'Oggi' : d===1 ? 'Domani' : d===-1 ? 'Ieri' : d<0 ? `${-d} giorni fa` : d<=14 ? `Tra ${d} giorni` : fmtDate(date);
}
function validita(p){
  if(!p.validoFino || !['bozza','inviato'].includes(p.stato)) return null;
  const d = daysUntil(p.validoFino);
  if(d<0) return { text:'Offerta scaduta', cls:'red' };
  if(d===0) return { text:'Scade oggi', cls:'amber' };
  return { text:`Valida ancora ${d} g`, cls: d<=3 ? 'amber' : 'gray' };
}
function prevAmountInfo(p, st){
  if(p.stato==='accettato'){
    const late = prevInRitardo(p);
    return { value:st.residuo, label: late ? 'in ritardo' : (st.incassato ? 'ancora da incassare' : 'da incassare'), color: late ? 'var(--coral-soft)' : 'var(--blue-soft)' };
  }
  if(p.stato==='completato') return { value:st.totale, label:'incassato', color:'var(--mint)' };
  if(p.stato==='rifiutato') return { value:st.totale, label:'non accettato', color:'var(--text-faint)' };
  return { value:st.totale, label: p.stato==='inviato' ? 'in attesa di risposta' : 'bozza da inviare', color:'var(--text)' };
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
  container.querySelectorAll(handleSel).forEach(h=>{
    const el = h.closest(itemSel);
    if(!el || el.parentElement!==container) return;
    h.addEventListener('pointerdown', e=>{
      if(e.button>0) return;
      e.preventDefault(); e.stopPropagation();
      const startY = e.clientY; let beforeId;
      const sibs = ()=>Array.from(container.children).filter(x=>x!==el && x.matches(itemSel));
      el.classList.add('dragging'); document.body.style.userSelect='none';
      try{ h.setPointerCapture(e.pointerId); }catch(_){}
      const move = ev=>{
        el.style.transform = `translateY(${ev.clientY-startY}px)`;
        const s = sibs(); s.forEach(x=>x.classList.remove('drag-over-top','drag-over-bottom'));
        const target = s.find(x=>{ const r=x.getBoundingClientRect(); return ev.clientY < r.top + r.height/2; });
        if(target){ target.classList.add('drag-over-top'); beforeId = target.dataset.id; }
        else { beforeId = null; s.length && s[s.length-1].classList.add('drag-over-bottom'); }
      };
      const up = ()=>{
        h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
        document.body.style.userSelect=''; el.classList.remove('dragging'); el.style.transform='';
        sibs().forEach(x=>x.classList.remove('drag-over-top','drag-over-bottom'));
        if(beforeId!==undefined && beforeId!==el.dataset.id) onReorder(el.dataset.id, beforeId);
      };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
  });
}

/* ---------- pagina Preventivi ---------- */
function setPrevTab(k){ prevTab = k; calendarState.preventivati.on = false; renderPreventivati(); }
function renderPreventivati(){
  const f = filters.preventivati;
  const tutti = db.preventivati;
  if(!prevTab) prevTab = tutti.some(PREV_TABS[0].match) || !tutti.some(PREV_TABS[1].match) ? 'incassare' : 'attesa';
  const tab = PREV_TABS.find(t=>t.key===prevTab) || PREV_TABS[0];
  let list = tutti.filter(tab.match);
  if(f.q) list = tutti.filter(p=> matches(p.name,f.q) || matches(p.cliente,f.q) || matches(p.numero,f.q) || matches(p.note,f.q) || p.voci.some(v=>matches(v.name,f.q)));
  if(f.q) list.sort((a,b)=>(b.date||b.creato||'').localeCompare(a.date||a.creato||''));
  else if(prevTab==='incassare') list.sort((a,b)=> (prevInRitardo(b)-prevInRitardo(a)) || (a.date||'2100').localeCompare(b.date||'2100'));
  else if(prevTab==='attesa') list.sort((a,b)=> ((a.stato==='inviato'?0:1)-(b.stato==='inviato'?0:1)) || (a.date||'2100').localeCompare(b.date||'2100'));
  else list.sort((a,b)=>(b.completatoIl||b.date||b.creato||'').localeCompare(a.completatoIl||a.date||a.creato||''));

  const confermati = tutti.filter(p=>p.stato==='accettato');
  const daIncassare = round2(confermati.reduce((s,p)=>s+p.amount,0));
  const inRitardo = round2(confermati.filter(prevInRitardo).reduce((s,p)=>s+p.amount,0));
  const attesa = tutti.filter(p=>p.stato==='bozza' || p.stato==='inviato');
  const valAttesa = round2(attesa.reduce((s,p)=>s+prevStats(p).totale,0));
  const anno = String(new Date().getFullYear());
  const incAnno = round2(tutti.reduce((s,p)=> s + (p.pagamenti||[]).filter(x=>(x.date||'').startsWith(anno)).reduce((a,x)=>a+Number(x.amount||0),0), 0));
  const decisi = tutti.filter(p=>['accettato','completato','rifiutato'].includes(p.stato));
  const tasso = decisi.length ? Math.round(decisi.filter(p=>p.stato!=='rifiutato').length/decisi.length*100) : null;
  const inviati = attesa.filter(p=>p.stato==='inviato').length;
  const calOn = calendarState.preventivati.on;

  document.getElementById('page-preventivati').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Preventivi</div><div class="page-sub">${tutti.length ? `${plur(tutti.length,'preventivo','preventivi')}${tasso!==null?` · ${tasso}% accettati`:''}` : 'Crea offerte, segui le risposte e registra i pagamenti'}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo preventivo</button></div>
    </div>

    ${tutti.length ? `
    <div class="pv-summary">
      <button class="pv-sum" onclick="setPrevTab('incassare')">
        <div class="pv-sum-label"><i style="background:var(--blue)"></i>Da incassare</div>
        <div class="pv-sum-value" style="color:var(--blue-soft)">${euro(daIncassare)}</div>
        <div class="pv-sum-hint">${inRitardo ? `<span style="color:var(--coral-soft)">${euro(inRitardo)} in ritardo</span> · ` : ''}${plur(confermati.length,'confermato','confermati')}</div>
      </button>
      <button class="pv-sum" onclick="setPrevTab('attesa')">
        <div class="pv-sum-label"><i style="background:var(--text-dim)"></i>In attesa</div>
        <div class="pv-sum-value">${euro(valAttesa)}</div>
        <div class="pv-sum-hint">${inviati} inviat${inviati===1?'o':'i'} · ${attesa.length-inviati} bozz${attesa.length-inviati===1?'a':'e'}</div>
      </button>
      <div class="pv-sum">
        <div class="pv-sum-label"><i style="background:var(--mint)"></i>Incassato ${anno}</div>
        <div class="pv-sum-value" style="color:var(--mint)">${euro(incAnno)}</div>
        <div class="pv-sum-hint">dai preventivi</div>
      </div>
    </div>` : ''}

    ${tutti.some(p=>p.importato) ? `<div class="import-banner">
      <div><b>${plur(tutti.filter(p=>p.importato).length,'evento importato','eventi importati')} dalla vecchia versione</b><span>Aggiungi cliente e acconti già ricevuti in un colpo solo.</span></div>
      <button class="btn btn-primary btn-sm" onclick="modalRevisioneImportati()">Rivedi ora</button>
    </div>` : ''}

    ${tutti.length ? `
    <div class="toolbar-row">
      <div class="seg" role="tablist">
        ${PREV_TABS.map(t=>{ const n = tutti.filter(t.match).length; return `<button class="seg-btn ${!calOn && !f.q && prevTab===t.key?'active':''}" role="tab" onclick="setPrevTab('${t.key}')">${t.label}${n?`<span class="n">${n}</span>`:''}</button>`; }).join('')}
      </div>
      <div class="filter-bar">
        ${calOn ? '<div style="flex:1"></div>' : `<div class="search-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input id="search-preventivati" type="search" enterkeyhint="search" autocomplete="off" value="${esc(f.q)}" placeholder="Cerca cliente, numero o voce…" oninput="setFilter('preventivati','q',this.value)" aria-label="Cerca preventivi">
        </div>`}
        <button class="btn ${calOn?'btn-primary':''}" onclick="setVistaCalendario('preventivati', ${!calOn})" aria-pressed="${calOn}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${calOn?'Chiudi calendario':'Calendario'}</button>
      </div>
    </div>` : ''}

    ${calOn ? `<div class="card">${renderCalendarGrid('preventivati')}</div>` : `
      ${f.q ? `<div class="section-help">Risultati in tutti i preventivi</div>` : ''}
      <div class="pv-list">
        ${list.length ? list.map(prevCardHtml).join('') : `<div class="card" style="grid-column:1/-1;">${prevEmptyHtml(tutti.length, f.q)}</div>`}
      </div>`}
  `;
}
function prevEmptyHtml(n, q){
  if(!n) return `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg><p>Nessun preventivo ancora. Crea il primo: cliente, voci e prezzo, il resto lo calcola l'app.</p><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo preventivo</button></div>`;
  if(q) return emptyState('Nessun preventivo corrisponde alla ricerca.');
  return emptyState(prevTab==='incassare' ? 'Nessun preventivo confermato da incassare.' : prevTab==='attesa' ? 'Nessuna offerta in attesa di risposta.' : "L'archivio è vuoto.");
}
function prevCardHtml(p){
  const st = prevStats(p);
  const ts = prevTaskStats(p.id);
  const late = prevInRitardo(p);
  const am = prevAmountInfo(p, st);
  const val = validita(p);
  const badges = [];
  if(p.stato!=='accettato' || late) badges.push(late ? `<span class="pv-badge red">In ritardo</span>` : statoBadge(p.stato));
  if(p.date) badges.push(`<span class="pv-badge gray">${esc(quandoTesto(p.date))}</span>`);
  if(p.stato==='accettato' && st.accontoDovuto>0 && !st.incassato) badges.push(`<span class="pv-badge amber">Acconto ${euro(st.accontoDovuto)}</span>`);
  if(val) badges.push(`<span class="pv-badge ${val.cls}">${val.text}</span>`);
  if(ts.n) badges.push(`<span class="pv-badge ${ts.fatte===ts.n?'green':'gray'}">${ts.fatte}/${ts.n} lavori</span>`);
  if(p.importato) badges.push(`<span class="pv-badge amber">Da rivedere</span>`);
  return `<button class="pv-card ${late?'late':''}" onclick="openPrevDrawer('${p.id}')">
    <div class="pv-card-top">
      <div class="pv-avatar" style="background:${p.color}22; color:${p.color};">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
      <div class="pv-titles">
        <div class="pv-name">${esc(p.name)}</div>
        <div class="pv-meta">${esc(p.cliente||'Nessun cliente')} · ${esc(p.numero||'')}</div>
      </div>
    </div>
    <div class="pv-amount-row">
      <div><div class="pv-amount" style="color:${am.color}">${euro(am.value)}</div><div class="pv-amount-label">${am.label}</div></div>
    </div>
    ${p.stato==='accettato' ? `<div class="pv-paybar"><div class="progress-track"><div class="progress-fill" style="width:${st.pct}%; background:var(--mint);"></div></div><span>${euro(st.incassato)} di ${euro(st.totale)}</span></div>` : ''}
    ${badges.length ? `<div class="pv-badges">${badges.join('')}</div>` : ''}
  </button>`;
}

/* ---------- pannello di dettaglio ---------- */
function openPrevDrawer(id, tab){
  if(!db.preventivati.some(x=>x.id===id)) return;
  if(prevDrawerId!==id){ prevVoceFilter = ''; prevDrawerTab = tab || 'voci'; }
  else if(tab) prevDrawerTab = tab;
  const wasOpen = !!prevDrawerId;
  prevDrawerId = id;
  renderPrevDrawer(!wasOpen);
  document.getElementById('drawer-overlay').classList.add('active');
  syncOverlayState();
}
function closePrevDrawer(){
  prevDrawerId = null;
  document.getElementById('drawer-overlay').classList.remove('active');
  syncOverlayState();
}
function setDrawerTab(t){ prevDrawerTab = t; renderPrevDrawer(true); }
function toggleDrMenu(e){ e.stopPropagation(); document.getElementById('dr-menu')?.classList.toggle('open'); }
document.addEventListener('click', ()=> document.getElementById('dr-menu')?.classList.remove('open'));

function setPrevStato(id, stato){
  const p = db.preventivati.find(x=>x.id===id); if(!p || stato==='completato') return;
  p.stato = stato;
  if(stato==='inviato' && !p.inviatoIl) p.inviatoIl = oggiStr();
  if(stato==='accettato' && !p.accettatoIl) p.accettatoIl = oggiStr();
  recalcPrev(p);
  saveDB(); renderAll();
  const msg = { bozza:'Riportato in bozza.', inviato:'Segnato come inviato.', accettato:'Confermato: ora è tra quelli da incassare.', rifiutato:'Archiviato come rifiutato.' };
  toast(p.stato==='completato' ? 'Già tutto incassato: segnato come pagato.' : msg[stato]);
}
function voceSelectHtml(p, current, onchange){
  if(!p || !p.voci || p.voci.length<2) return '';
  return `<select class="voce-chip ${current?'set':''}" onclick="event.stopPropagation()" onchange="${onchange}" aria-label="Collega a una voce del preventivo">
    <option value="">${current?'Nessuna voce':'+ Voce'}</option>
    ${p.voci.map(v=>`<option value="${v.id}" ${current===v.id?'selected':''}>${esc(v.name)}</option>`).join('')}
  </select>`;
}

function renderPrevDrawer(resetScroll){
  if(!prevDrawerId) return;
  const p = db.preventivati.find(x=>x.id===prevDrawerId);
  if(!p){ closePrevDrawer(); return; }
  const drawer = document.getElementById('drawer');
  const oldBody = drawer.querySelector('.dr-body');
  const scroll = !resetScroll && oldBody ? oldBody.scrollTop : 0;

  const st = prevStats(p);
  const ts = prevTaskStats(p.id);
  const late = prevInRitardo(p);
  const am = prevAmountInfo(p, st);
  const val = validita(p);
  const passi = ['bozza','inviato','accettato','completato'];
  const idx = passi.indexOf(p.stato);
  const puoIncassare = p.stato!=='rifiutato' && p.stato!=='completato' && st.residuo>0;
  const tab = ['voci','pagamenti','lavori'].includes(prevDrawerTab) ? prevDrawerTab : 'voci';

  // azione principale, una sola, decisa dallo stato
  let cta = '';
  if(p.stato==='bozza') cta = `<button class="btn btn-primary" onclick="setPrevStato('${p.id}','inviato')">${ICO_SEND}Segna come inviato</button><button class="btn secondary" onclick="condividiPreventivo('${p.id}')">Invia testo</button>`;
  else if(p.stato==='inviato') cta = `<button class="btn btn-primary" onclick="setPrevStato('${p.id}','accettato')">${ICO_CHECK_SM}Il cliente ha accettato</button><button class="btn secondary btn-danger" onclick="setPrevStato('${p.id}','rifiutato')">Rifiutato</button>`;
  else if(p.stato==='accettato') cta = `<button class="btn btn-primary" onclick="modalPagamento('${p.id}')">${st.accontoDovuto>0 && !st.incassato ? `Registra acconto ${euro(st.accontoDovuto)}` : 'Registra pagamento'}</button>`;
  else if(p.stato==='rifiutato') cta = `<button class="btn" onclick="setPrevStato('${p.id}','bozza')">Riapri come bozza</button>`;

  const facts = p.stato==='bozza' || p.stato==='inviato' || p.stato==='rifiutato'
    ? [ ['Lavoro', p.date ? fmtDate(p.date) : '—'], ['Acconto', Number(p.acconto)>0 ? euro(p.acconto) : '—'], ['Valida fino', p.validoFino ? fmtDate(p.validoFino) : '—'] ]
    : [ ['Lavoro', p.date ? fmtDate(p.date) : '—'], ['Acconto', !Number(p.acconto) ? '—' : st.accontoDovuto>0 ? `<span style="color:var(--amber)">${euro(st.accontoDovuto)} da ric.</span>` : '<span style="color:var(--mint)">Ricevuto</span>'], ['Lavori', ts.n ? `${ts.fatte}/${ts.n}` : '—'] ];

  drawer.innerHTML = `
    <div class="dr-head">
      <div class="pv-avatar lg" style="background:${p.color}22; color:${p.color};">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
      <div class="dr-head-main">
        <div class="dr-title">${esc(p.name)}</div>
        <div class="dr-sub">${esc(p.numero||'')} · ${p.cliente ? `<button onclick="apriCliente(${jsArg(p.cliente)})">${esc(p.cliente)}</button>` : 'Nessun cliente'}</div>
      </div>
      <div class="dr-menu-wrap">
        <button class="icon-btn" aria-label="Altre azioni" onclick="toggleDrMenu(event)">${ICO_DOTS}</button>
        <div class="dr-menu" id="dr-menu" onclick="event.stopPropagation()">
          <button onclick="modalPreventivato('${p.id}')">${ICO_EDIT}Modifica preventivo</button>
          <button onclick="condividiPreventivo('${p.id}')">${ICO_SEND}Invia / condividi testo</button>
          <button onclick="copiaPreventivo('${p.id}')">${ICO_COPY}Copia testo</button>
          <button onclick="duplicaPreventivo('${p.id}')">${ICO_DUP}Duplica come bozza</button>
          <button onclick="modalCambiaStato('${p.id}')">${ICO_FLAG}Cambia stato…</button>
          <hr>
          <button class="danger" onclick="modalEliminaPreventivato('${p.id}')">${ICO_TRASH}Elimina</button>
        </div>
      </div>
      <button class="icon-btn" title="Chiudi" aria-label="Chiudi" onclick="closePrevDrawer()">${ICO_X}</button>
    </div>

    <div class="dr-body">
      ${p.stato==='rifiutato'
        ? `<div class="dr-rejected">${ICO_FLAG.replace('<svg','<svg width="16" height="16"')}Rifiutato dal cliente · archiviato</div>`
        : `<div class="dr-steps">${passi.map((k,i)=>`<div class="dr-step ${i<idx?'done':''} ${i===idx?'current':''}"><i></i>${statoInfo(k).label}</div>`).join('')}</div>`}

      <div class="dr-hero ${late?'late':''}">
        <div class="dr-hero-label">${late ? 'In ritardo · da incassare' : p.stato==='accettato' ? 'Da incassare' : p.stato==='completato' ? 'Pagato per intero' : 'Totale offerta'}</div>
        <div class="dr-hero-amount" style="color:${am.color}">${euro(am.value)}</div>
        ${p.stato==='accettato' ? `
          <div class="progress-track slim"><div class="progress-fill" style="width:${st.pct}%; background:var(--mint);"></div></div>
          <div class="dr-hero-line">Ricevuti <b>${euro(st.incassato)}</b> di <b>${euro(st.totale)}</b>${late?` · il lavoro era ${esc(quandoTesto(p.date).toLowerCase())}`:''}</div>` : ''}
        <div class="dr-facts">${facts.map(([k,v])=>`<div class="dr-fact"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
        ${cta ? `<div class="dr-cta">${cta}</div>` : ''}
      </div>

      ${p.importato ? `<div class="dr-alert amber">${ICO_ALERT}<span>Arriva dalla vecchia sezione Eventi: controlla cliente e voci. <a href="#" onclick="modalPreventivato('${p.id}'); return false;">Rivedi</a></span></div>` : ''}
      ${val && val.cls!=='gray' ? `<div class="dr-alert ${val.cls==='red'?'coral':'amber'}">${ICO_ALERT}<span>${val.text} (${fmtDate(p.validoFino)}).</span></div>` : ''}

      <div class="dr-tabs" role="tablist">
        <button class="dr-tab ${tab==='voci'?'active':''}" onclick="setDrawerTab('voci')">Voci<span class="n">${st.n}</span></button>
        <button class="dr-tab ${tab==='pagamenti'?'active':''}" onclick="setDrawerTab('pagamenti')">Pagamenti${st.nPag?`<span class="n">${st.nPag}</span>`:''}</button>
        <button class="dr-tab ${tab==='lavori'?'active':''}" onclick="setDrawerTab('lavori')">Lavori${ts.n?`<span class="n">${ts.fatte}/${ts.n}</span>`:''}</button>
      </div>

      ${tab==='voci' ? drawerVociHtml(p, st) : tab==='pagamenti' ? drawerPagamentiHtml(p, st, puoIncassare) : drawerLavoriHtml(p)}

      <div class="dr-foot">Creato ${p.creato?fmtDate(p.creato):'—'}${p.inviatoIl?` · inviato ${fmtDate(p.inviatoIl)}`:''}${p.accettatoIl?` · confermato ${fmtDate(p.accettatoIl)}`:''}${p.completatoIl?` · pagato ${fmtDate(p.completatoIl)}`:''}</div>
    </div>
  `;
  const body = drawer.querySelector('.dr-body');
  if(body) body.scrollTop = scroll;

  if(tab==='lavori' && !prevVoceFilter){
    attachSortable(document.getElementById('lavori-list'), '.lavoro', '.lavoro-head > .drag-handle', (id, beforeId)=>{ moveInArray(db.tasks, id, beforeId); saveDB(); renderAll(); });
    document.querySelectorAll('#lavori-list .sub-list').forEach(el=>{
      const t = db.tasks.find(x=>x.id===el.dataset.task);
      if(t) attachSortable(el, '.sub-row', '.drag-handle', (id, beforeId)=>{ moveInArray(t.subtasks, id, beforeId); saveDB(); renderAll(); });
    });
  }
}

function drawerVociHtml(p, st){
  return `
    <div class="sheet-list">
      ${p.voci.map(v=>{
        const lav = voceLavori(p.id, v.id);
        return `<div class="sheet-row">
          <div class="sheet-row-main">
            <div class="sheet-row-title">${esc(v.name)}</div>
            ${v.desc ? `<div class="sheet-row-desc">${esc(v.desc)}</div>` : ''}
            ${Number(v.qty)!==1 ? `<div class="sheet-row-sub">${fmtNum(v.qty)} × ${euro(v.price)}</div>` : ''}
          </div>
          ${lav.n && p.voci.length>1 ? `<button class="voci-tag ${lav.f===lav.n?'ok':''}" onclick="prevVoceFilter='${v.id}'; setDrawerTab('lavori')">${lav.f}/${lav.n} lavori</button>` : ''}
          <div class="sheet-row-amount">${euro(v.amount)}</div>
        </div>`;
      }).join('')}
      ${Number(p.sconto)>0 ? `<div class="sheet-row total"><div class="sheet-row-main"><div class="sheet-row-sub" style="margin:0">Subtotale ${euro(st.lordo)}</div><div class="sheet-row-title">Sconto</div></div><div class="sheet-row-amount" style="color:var(--coral-soft)">− ${euro(p.sconto)}</div></div>` : ''}
      <div class="sheet-row total"><div class="sheet-row-main"><div class="sheet-row-title">Totale</div>${Number(p.acconto)>0?`<div class="sheet-row-sub">Acconto richiesto alla conferma: ${euro(p.acconto)}</div>`:''}</div><div class="sheet-row-amount" style="font-size:16px;">${euro(st.totale)}</div></div>
    </div>
    <div class="dr-actions-row"><button class="btn btn-sm" onclick="modalPreventivato('${p.id}')">${ICO_EDIT}Modifica voci e prezzi</button></div>
    ${p.note ? `<div class="dr-section-label">Note</div><div class="sheet-note">${esc(p.note)}</div>` : ''}
  `;
}
function drawerPagamentiHtml(p, st, puoIncassare){
  const pagOrd = [...p.pagamenti].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  return `
    ${pagOrd.length ? `<div class="sheet-list">
      ${pagOrd.map(x=>{
        const acc = x.accountId ? db.accounts.find(a=>a.id===x.accountId) : null;
        return `<div class="sheet-row">
          <div class="pay-dot" style="background:var(--mint-dim); color:var(--mint);">${ICO_CHECK_SM}</div>
          <div class="sheet-row-main">
            <div class="sheet-row-title">${tipoPagLabel(x.tipo)}${x.nota?' · '+esc(x.nota):''}</div>
            <div class="sheet-row-sub">${fmtDate(x.date)}${acc?' · '+esc(acc.name):''}${x.giaSulConto?' · già sul conto':''}</div>
          </div>
          <div class="sheet-row-amount" style="color:var(--mint)">+ ${euro(x.amount)}</div>
          <button class="icon-btn" title="Annulla pagamento" aria-label="Annulla pagamento" onclick="modalAnnullaPagamento('${p.id}','${x.id}')">${ICO_X}</button>
        </div>`;}).join('')}
      <div class="sheet-row total"><div class="sheet-row-main"><div class="sheet-row-title">${st.residuo>0?'Resta da ricevere':'Tutto ricevuto'}</div></div><div class="sheet-row-amount" style="color:${st.residuo>0?'var(--blue-soft)':'var(--mint)'}">${euro(st.residuo)}</div></div>
    </div>` : `<div class="sheet-empty">${p.stato==='bozza'||p.stato==='inviato' ? 'Nessun pagamento ancora. Quando il cliente ti paga (anche solo l\'acconto) registralo qui: il preventivo passa a Confermato da solo.' : 'Nessun pagamento ricevuto.'}</div>`}
    ${puoIncassare ? `<div class="dr-actions-row"><button class="btn btn-primary" onclick="modalPagamento('${p.id}')">+ Registra pagamento</button></div>` : ''}
  `;
}
function drawerLavoriHtml(p){
  const fVoce = prevVoceFilter && p.voci.some(v=>v.id===prevVoceFilter) ? prevVoceFilter : '';
  if(!fVoce) prevVoceFilter = '';
  let tasks = prevTasks(p.id);
  const tutte = tasks.length;
  if(fVoce) tasks = tasks.filter(t=>t.voceId===fVoce || (t.subtasks||[]).some(x=>x.voceId===fVoce));
  const libere = db.tasks.filter(t=>!t.prevId && !t.done);
  return `
    ${p.voci.length>1 && tutte ? `<div class="chip-filter">
      <button class="${!fVoce?'active':''}" onclick="prevVoceFilter=''; renderPrevDrawer()">Tutti</button>
      ${p.voci.map(v=>`<button class="${fVoce===v.id?'active':''}" onclick="prevVoceFilter='${v.id}'; renderPrevDrawer()">${esc(v.name)}</button>`).join('')}
    </div>` : ''}
    <div class="lavori-list" id="lavori-list">
      ${tasks.map(t=>lavoroHtml(p, t, fVoce)).join('') || `<div class="sheet-empty">${fVoce?'Nessun lavoro collegato a questa voce.':'Le cose da fare per questo lavoro (es. selezione foto, consegna album). Compaiono anche nella pagina Task.'}</div>`}
    </div>
    <div class="add-row">
      <input id="drawer-task-input" placeholder="Nuovo lavoro…" enterkeyhint="done" onkeydown="if(event.key==='Enter'){event.preventDefault(); aggiungiTaskEvento('${p.id}')}">
      ${p.voci.length>1 ? `<select id="drawer-task-voce" aria-label="Voce"><option value="">Tutte le voci</option>${p.voci.map(v=>`<option value="${v.id}" ${fVoce===v.id?'selected':''}>${esc(v.name)}</option>`).join('')}</select>` : ''}
      <button onclick="aggiungiTaskEvento('${p.id}')">Aggiungi</button>
    </div>
    ${libere.length ? `<div class="link-row">
      <select id="drawer-link-select" aria-label="Collega una task esistente"><option value="">Collega una task già esistente…</option>${libere.map(t=>`<option value="${t.id}">${esc(t.text)}</option>`).join('')}</select>
      <button class="btn btn-sm" onclick="collegaTaskEsistente('${p.id}')">Collega</button>
    </div>` : ''}
  `;
}
function lavoroHtml(p, t, fVoce){
  let subs = t.subtasks||[];
  if(fVoce && t.voceId!==fVoce) subs = subs.filter(s=>s.voceId===fVoce);
  const done = (t.subtasks||[]).filter(s=>s.done).length, tot = (t.subtasks||[]).length;
  const over = t.dueDate && !t.done && daysUntil(t.dueDate)<0;
  return `<div class="lavoro ${t.done?'done':''}" data-id="${t.id}">
    <div class="lavoro-head">
      ${fVoce ? '<span style="width:4px"></span>' : `<span class="drag-handle" title="Trascina per riordinare">${ICO_GRIP}</span>`}
      <button class="task-check ${t.done?'checked':''}" aria-label="${t.done?'Riapri':'Completa'}" onclick="toggleTaskEvento('${t.id}')">${ICO_CHECK_SM}</button>
      <div class="lavoro-main">
        <div class="lavoro-title" onclick="modalTask('${t.id}')">${esc(t.text)}</div>
        ${(p.voci.length>1 || t.dueDate || tot || t.priority) ? `<div class="lavoro-meta">
          ${voceSelectHtml(p, t.voceId||'', `setVoceTask('${t.id}', this.value)`)}
          ${t.priority ? `<span>${esc(t.priority)}</span>` : ''}
          ${t.dueDate ? `<span style="${over?'color:var(--coral-soft)':''}">${over?'scaduto ':'entro '}${fmtDate(t.dueDate)}</span>` : ''}
          ${tot ? `<span>${done}/${tot} sottotask</span>` : ''}
        </div>` : ''}
      </div>
      <button class="icon-btn" title="Scollega dal preventivo" aria-label="Scollega dal preventivo" onclick="scollegaTask('${t.id}')">${ICO_X}</button>
    </div>
    <div class="sub-list" data-task="${t.id}">${subs.map(s=>`
      <div class="sub-row ${s.done?'done':''}" data-id="${s.id}">
        ${fVoce ? '' : `<span class="drag-handle" title="Trascina per riordinare">${ICO_GRIP}</span>`}
        <input type="checkbox" class="subtask-check" ${s.done?'checked':''} onchange="toggleSubtaskPrev('${t.id}','${s.id}')" aria-label="Completata">
        <div class="sub-text">${esc(s.text)}</div>
        ${voceSelectHtml(p, s.voceId||'', `setVoceSub('${t.id}','${s.id}', this.value)`)}
        <button class="subtask-del" title="Elimina sottotask" aria-label="Elimina sottotask" onclick="eliminaSubPrev('${t.id}','${s.id}')">${ICO_X}</button>
      </div>`).join('')}</div>
    <div class="sub-add"><input id="sub-add-${t.id}" placeholder="+ Aggiungi sottotask" enterkeyhint="done" onkeydown="if(event.key==='Enter'){event.preventDefault(); aggiungiSubPrev('${t.id}')}"></div>
  </div>`;
}
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
  const p = db.preventivati.find(x=>x.id===pid); if(!p) return;
  const voceId = document.getElementById('drawer-task-voce')?.value || prevVoceFilter || null;
  db.tasks.push({ id:uid(), text, note:'', priority:'', dueDate: p.date || '', done:false, subtasks:[], prevId:pid, prevNome:p.name, voceId });
  saveDB(); renderAll();
  document.getElementById('drawer-task-input')?.focus();
}
function collegaTaskEsistente(pid){
  const sel = document.getElementById('drawer-link-select');
  const t = sel && db.tasks.find(x=>x.id===sel.value);
  const p = db.preventivati.find(x=>x.id===pid);
  if(!t || !p) return toast('Scegli una task da collegare.');
  t.prevId = pid; t.prevNome = p.name; t.voceId = null;
  saveDB(); renderAll(); toast('Task collegata.');
}
function scollegaTask(tid){
  const t = db.tasks.find(x=>x.id===tid); if(!t) return;
  t.prevId = null; t.prevNome = ''; t.voceId = null; (t.subtasks||[]).forEach(s=>s.voceId=null);
  saveDB(); renderAll(); toast('Scollegata: la trovi ancora nella pagina Task.');
}

function modalCambiaStato(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  const opzioni = PREV_STATI.filter(s=>s.key!=='completato');
  openModal(`
    <h3>Cambia stato</h3>
    <p class="modal-lead">"Pagato" si imposta da solo quando registri tutti i pagamenti.</p>
    <div class="list">
      ${opzioni.map(s=>`<label class="row-item clickable" style="gap:12px;">
        <input type="radio" name="f-stato" value="${s.key}" ${p.stato===s.key || (p.stato==='completato'&&s.key==='accettato')?'checked':''} style="width:18px;height:18px;accent-color:var(--mint);">
        <span class="row-main"><span class="row-title" style="display:block;">${s.label}</span></span>
        <span style="width:10px;height:10px;border-radius:50%;background:${s.color};"></span>
      </label>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="const v=document.querySelector('input[name=f-stato]:checked'); closeModal(); if(v) setPrevStato('${id}', v.value)">Salva</button>
    </div>
  `);
}

/* ---------- invia, copia, duplica ---------- */
function testoPreventivo(p){
  const st = prevStats(p);
  const righe = [];
  p.voci.forEach(v=>{
    righe.push(`• ${v.name}${Number(v.qty)!==1?` (${fmtNum(v.qty)} × ${euro(v.price)})`:''}: ${euro(v.amount)}`);
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
function mostraTestoDaCopiare(testo){
  openModal(`<h3>Copia il testo</h3><p class="modal-lead">Tieni premuto sul testo e scegli "Seleziona tutto", poi "Copia".</p><div class="field"><textarea style="min-height:240px;" readonly>${esc(testo)}</textarea></div><div class="modal-actions"><button class="btn" onclick="closeModal()">Chiudi</button></div>`);
}
function copiaPreventivo(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  document.getElementById('dr-menu')?.classList.remove('open');
  const testo = testoPreventivo(p);
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(testo).then(()=>toast('Testo copiato: incollalo su WhatsApp o in una mail.')).catch(()=>mostraTestoDaCopiare(testo));
  } else mostraTestoDaCopiare(testo);
}
function condividiPreventivo(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  document.getElementById('dr-menu')?.classList.remove('open');
  if(navigator.share){
    navigator.share({ title:`Preventivo ${p.numero||''}`.trim(), text:testoPreventivo(p) })
      .then(()=>{ if(p.stato==='bozza') askSegnaInviato(p.id); })
      .catch(err=>{ if(err && err.name!=='AbortError') copiaPreventivo(id); });
  } else copiaPreventivo(id);
}
function askSegnaInviato(id){
  openModal(`<h3>L'hai inviato al cliente?</h3><p class="modal-lead">Se sì lo segno come inviato, così sai che stai aspettando una risposta.</p>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Non ancora</button><button class="btn btn-primary" onclick="closeModal(); setPrevStato('${id}','inviato')">Sì, inviato</button></div>`);
}
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
  saveDB(); renderAll(); openPrevDrawer(nuovo.id, 'voci'); toast('Duplicato come bozza, con i suoi lavori.');
}

/* ---------- elimina ---------- */
function modalEliminaPreventivato(id){
  const p = db.preventivati.find(x=>x.id===id); if(!p) return;
  const n = prevTasks(id).length;
  openModal(`
    <h3>Eliminare "${esc(p.name)}"?</h3>
    <p class="modal-lead">Il preventivo viene rimosso. I soldi già incassati restano sui conti e nei movimenti.${n?` Le ${n} task collegate restano nella pagina Task.`:''} Se vuoi solo toglierlo di mezzo, usa "Cambia stato → Rifiutato".</p>
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
  document.getElementById('dr-menu')?.classList.remove('open');
  const isEdit = !!id;
  const p = isEdit ? db.preventivati.find(x=>x.id===id) : null;
  if(isEdit && !p) return;
  prevDraft = p ? p.voci.map(v=>({...v})) : [{ id:uid(), name:'', desc:'', qty:1, price:'' }];
  const clienti = elencoClientiNomi();
  const validDefault = (()=>{ const d=new Date(); d.setDate(d.getDate()+30); return dateKeyFromDate(d); })();
  const opz = p ? [p.numero, Number(p.sconto)>0?'sconto':'', Number(p.acconto)>0?'acconto':'', p.note?'note':''].filter(Boolean).join(' · ') : prossimoNumeroPrev();
  openModal(`
    <h3>${isEdit?'Modifica preventivo':'Nuovo preventivo'}</h3>
    ${p && p.importato ? `<div class="dr-alert amber" style="margin:8px 0 4px;">${ICO_ALERT}<span>Arriva dalla vecchia sezione Eventi: aggiungi il cliente e, se vuoi, dividi l'importo in più voci.</span></div>` : ''}
    <div class="field"><label for="f-cliente">Cliente</label><input id="f-cliente" list="dl-clienti" value="${esc(p?p.cliente||'':presetCliente||'')}" placeholder="Es. Marco Rossi" autocomplete="off" autocapitalize="words"><datalist id="dl-clienti">${clienti.map(c=>`<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="field"><label for="f-name">Titolo del lavoro</label><input id="f-name" value="${esc(p?p.name:'')}" placeholder="Es. Servizio fotografico matrimonio" autocapitalize="sentences"></div>
    <div class="field"><label for="f-date">Data del lavoro</label><input id="f-date" type="date" value="${p?p.date||'':''}"></div>
    ${isEdit ? '' : `<div class="field"><label>A che punto sei?</label>
      <div class="segmented">
        <label><input type="radio" name="f-stato" value="bozza" checked>Da inviare</label>
        <label><input type="radio" name="f-stato" value="inviato">Già inviato</label>
        <label><input type="radio" name="f-stato" value="accettato">Confermato</label>
      </div></div>`}
    <div class="field" style="margin-bottom:0;">
      <label>Voci</label>
      <div class="ve-head"><span>Descrizione</span><span>Q.tà</span><span>Prezzo €</span><span>Importo</span><span></span></div>
      <div class="ve-list" id="ve-list"></div>
      <button type="button" class="ve-add" onclick="aggiungiVoceDraft()">+ Aggiungi voce</button>
    </div>
    <div class="ve-total"><span>Totale</span><span id="ve-total">—</span></div>
    <details class="adv" id="adv-opts" ${p && (Number(p.sconto)>0 || Number(p.acconto)>0) ? 'open' : ''}>
      <summary>Altre opzioni <small>${esc(opz)}</small></summary>
      <div class="adv-body">
        <div class="field-row">
          <div class="field"><label for="f-numero">Numero</label><input id="f-numero" value="${esc(p?p.numero||'':prossimoNumeroPrev())}"></div>
          <div class="field"><label for="f-valido">Offerta valida fino al</label><input id="f-valido" type="date" value="${p?p.validoFino||'':validDefault}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="f-sconto">Sconto (€)</label><input id="f-sconto" type="text" inputmode="decimal" autocomplete="off" value="${p&&Number(p.sconto)>0?p.sconto:''}" placeholder="0,00" oninput="aggiornaTotaleVoci()"></div>
          <div class="field"><label for="f-acconto">Acconto richiesto (€)</label><input id="f-acconto" type="text" inputmode="decimal" autocomplete="off" value="${p&&Number(p.acconto)>0?p.acconto:''}" placeholder="Nessuno"></div>
        </div>
        <div class="quick-amounts" style="margin:-6px 0 14px;"><button type="button" onclick="setAccontoPct(30)">Acconto 30%</button><button type="button" onclick="setAccontoPct(50)">Acconto 50%</button></div>
        <div class="field"><label for="f-note">Note per il cliente</label><textarea id="f-note" rows="3" placeholder="Es. saldo il giorno del lavoro tramite bonifico">${esc(p?p.note||'':'')}</textarea></div>
      </div>
    </details>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="savePreventivato('${id||''}')">${isEdit?'Salva':'Crea preventivo'}</button>
    </div>
  `, 'modal-wide');
  renderVociDraft();
}
function draftLordo(){ return round2(prevDraft.reduce((s,v)=>s+(parseNum(v.qty)||0)*(parseNum(v.price)||0),0)); }
function setAccontoPct(pct){
  const sconto = parseNum(document.getElementById('f-sconto')?.value)||0;
  const v = round2(Math.max(0, draftLordo()-sconto)*pct/100);
  document.getElementById('f-acconto').value = v ? String(v).replace('.',',') : '';
}
function renderVociDraft(){
  const box = document.getElementById('ve-list'); if(!box) return;
  box.innerHTML = prevDraft.map((v,i)=>`
    <div class="ve-row" data-id="${v.id}">
      <div class="ve-text">
        <span class="ve-lbl">Voce ${prevDraft.length>1?i+1:''}</span>
        <input class="ve-name" value="${esc(v.name||'')}" placeholder="Es. Servizio 8 ore" autocapitalize="sentences" oninput="aggiornaVoceDraft('${v.id}','name',this.value)">
        <input class="ve-desc" value="${esc(v.desc||'')}" placeholder="Descrizione (facoltativa)" autocapitalize="sentences" oninput="aggiornaVoceDraft('${v.id}','desc',this.value)">
      </div>
      <div><span class="ve-lbl">Quantità</span><input type="text" inputmode="decimal" autocomplete="off" value="${esc(String(v.qty??1))}" oninput="aggiornaVoceDraft('${v.id}','qty',this.value)" aria-label="Quantità"></div>
      <div><span class="ve-lbl">Prezzo (€)</span><input type="text" inputmode="decimal" autocomplete="off" value="${v.price===''||v.price===undefined?'':esc(String(v.price))}" placeholder="0,00" oninput="aggiornaVoceDraft('${v.id}','price',this.value)" aria-label="Prezzo unitario"></div>
      <span class="ve-amount" id="va-${v.id}">${euro((parseNum(v.qty)||0)*(parseNum(v.price)||0))}</span>
      <button type="button" class="icon-btn btn-danger ve-del" title="Rimuovi voce" aria-label="Rimuovi voce" onclick="rimuoviVoceDraft('${v.id}')">${ICO_TRASH}</button>
    </div>`).join('');
  aggiornaTotaleVoci();
}
function aggiornaTotaleVoci(){
  const el = document.getElementById('ve-total'); if(!el) return;
  const lordo = draftLordo();
  const sconto = parseNum(document.getElementById('f-sconto')?.value)||0;
  el.innerHTML = `<b>${euro(Math.max(0, lordo-sconto))}</b>${sconto?` <span style="font-size:11.5px;">(${euro(lordo)} − ${euro(sconto)})</span>`:''}`;
}
function aggiungiVoceDraft(){
  prevDraft.push({ id:uid(), name:'', desc:'', qty:1, price:'' });
  renderVociDraft();
  const rows = document.querySelectorAll('#ve-list .ve-row');
  rows[rows.length-1]?.querySelector('.ve-name')?.focus();
}
function aggiornaVoceDraft(vid, campo, valore){
  const v = prevDraft.find(x=>x.id===vid); if(!v) return;
  v[campo] = valore;
  const a = document.getElementById('va-'+vid); if(a) a.textContent = euro((parseNum(v.qty)||0)*(parseNum(v.price)||0));
  aggiornaTotaleVoci();
}
function rimuoviVoceDraft(vid){
  prevDraft = prevDraft.filter(x=>x.id!==vid);
  if(!prevDraft.length) prevDraft.push({ id:uid(), name:'', desc:'', qty:1, price:'' });
  renderVociDraft();
}
function savePreventivato(id){
  const name = document.getElementById('f-name').value.trim();
  const cliente = document.getElementById('f-cliente').value.trim();
  if(!name){ document.getElementById('f-name').focus(); return toast('Dai un titolo al lavoro.'); }
  const voci = prevDraft
    .map(v=>({ id:v.id, name:String(v.name||'').trim(), desc:String(v.desc||'').trim(), qty: v.qty===''||v.qty===undefined ? 1 : parseNum(v.qty), price: parseNum(v.price)||0 }))
    .filter(v=> v.name || v.price>0)
    .map(v=>({ ...v, qty: v.qty>0 ? v.qty : 1, name:v.name||'Voce', amount: round2(v.qty>0?v.qty*v.price:v.price) }));
  if(!voci.length) return toast('Aggiungi almeno una voce con un prezzo.');
  const dati = {
    name, cliente,
    numero: document.getElementById('f-numero').value.trim() || prossimoNumeroPrev(),
    date: document.getElementById('f-date').value,
    validoFino: document.getElementById('f-valido').value,
    sconto: Math.max(0, parseNum(document.getElementById('f-sconto').value)||0),
    acconto: Math.max(0, parseNum(document.getElementById('f-acconto').value)||0),
    note: document.getElementById('f-note').value.trim(),
    importato: false,
  };
  let p;
  if(id){ p = db.preventivati.find(x=>x.id===id); if(!p) return closeModal(); Object.assign(p, dati); }
  else {
    const stato = document.querySelector('input[name="f-stato"]:checked')?.value || 'bozza';
    p = { id:uid(), ...dati, stato, pagamenti:[], creato:oggiStr(), color: ICON_COLORS[Math.floor(Math.random()*ICON_COLORS.length)] };
    if(stato==='inviato') p.inviatoIl = oggiStr();
    if(stato==='accettato'){ p.inviatoIl = oggiStr(); p.accettatoIl = oggiStr(); }
    db.preventivati.push(p);
  }
  p.voci = voci;
  const idsVoci = new Set(voci.map(v=>v.id));
  prevTasks(p.id).forEach(t=>{ t.prevNome = p.name; if(t.voceId && !idsVoci.has(t.voceId)) t.voceId=null; (t.subtasks||[]).forEach(s=>{ if(s.voceId && !idsVoci.has(s.voceId)) s.voceId=null; }); });
  recalcPrev(p);
  prevDraft = [];
  const tabTarget = PREV_TABS.find(t=>t.match(p));
  if(tabTarget) prevTab = tabTarget.key;
  saveDB(); closeModal(); renderAll(); toast(id?'Preventivo aggiornato.':'Preventivo creato.');
  openPrevDrawer(p.id, id ? undefined : 'voci');
}

/* ---------- incassi ---------- */
function modalPagamento(pid){
  const p = db.preventivati.find(x=>x.id===pid); if(!p) return;
  if(!db.accounts.length) return modalServeConto();
  const st = prevStats(p);
  if(st.residuo<=0) return toast('Questo preventivo è già pagato per intero.');
  const proposto = st.accontoDovuto>0 && !st.incassato ? Math.min(st.accontoDovuto, st.residuo) : st.residuo;
  const contoDefault = db.accounts.some(a=>a.id===db.ultimoContoIncassi) ? db.ultimoContoIncassi : db.accounts[0].id;
  const rapidi = [];
  if(st.accontoDovuto>0 && st.accontoDovuto<st.residuo) rapidi.push(['Acconto', st.accontoDovuto]);
  if(st.residuo>=2) rapidi.push(['Metà', round2(st.residuo/2)]);
  rapidi.push(['Tutto il resto', st.residuo]);
  openModal(`
    <h3>Registra pagamento</h3>
    <p class="modal-lead"><b style="color:var(--text)">${esc(p.name)}</b>${p.cliente?' · '+esc(p.cliente):''}<br>Resta da ricevere <b style="color:var(--text)">${euro(st.residuo)}</b> su ${euro(st.totale)}.${p.stato!=='accettato'?' Il preventivo passerà a <b>Confermato</b>.':''}</p>
    <div class="field">
      <label for="f-pag-importo">Importo ricevuto (€)</label>
      <input id="f-pag-importo" type="text" inputmode="decimal" autocomplete="off" value="${String(proposto).replace('.',',')}" oninput="checkImportoPagamento(${st.residuo})">
      <div class="quick-amounts">${rapidi.map(([l,v])=>`<button type="button" onclick="document.getElementById('f-pag-importo').value='${String(v).replace('.',',')}'; checkImportoPagamento(${st.residuo})">${l} ${euro(v)}</button>`).join('')}</div>
      <div class="pay-warn" id="pay-warn">È più di quanto resta: verrà registrato comunque.</div>
    </div>
    <div class="field-row">
      <div class="field"><label for="f-pag-data">Data</label><input id="f-pag-data" type="date" value="${oggiStr()}"></div>
      <div class="field"><label for="f-account">Su quale conto</label><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}" ${a.id===contoDefault?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div>
    </div>
    <label class="check-line"><input type="checkbox" id="f-pag-gia"><span>Il saldo del conto l'ho già aggiornato a mano: registra il pagamento senza aggiungere di nuovo i soldi.</span></label>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confermaPagamento('${pid}')">Registra</button>
    </div>
  `);
}
function checkImportoPagamento(residuo){
  const v = parseNum(document.getElementById('f-pag-importo')?.value)||0;
  const w = document.getElementById('pay-warn'); if(w) w.style.display = v > residuo + 0.004 ? 'block' : 'none';
}
function confermaPagamento(pid){
  const p = db.preventivati.find(x=>x.id===pid); if(!p) return;
  const importo = round2(parseNum(document.getElementById('f-pag-importo').value));
  const date = document.getElementById('f-pag-data').value || oggiStr();
  const acc = db.accounts.find(x=>x.id===document.getElementById('f-account').value);
  const gia = document.getElementById('f-pag-gia').checked;
  if(!(importo>0)) return toast('Inserisci un importo valido.');
  if(!acc) return toast('Seleziona un conto.');
  const st = prevStats(p);
  const tipo = importo >= st.residuo - 0.004 ? 'saldo' : (st.accontoDovuto>0 && !st.incassato ? 'acconto' : 'pagamento');
  const pag = { id:uid(), tipo, amount:importo, date, accountId:acc.id };
  if(gia) pag.giaSulConto = true;
  else {
    acc.balance = round2(Number(acc.balance) + importo);
    const mov = { id:uid(), type:'entrata', name:`${p.name} · ${tipoPagLabel(tipo).toLowerCase()}`, amount:importo, date, accountId:acc.id, category:'lavoro', fromPrev:p.id };
    db.movimenti.push(mov); pag.movId = mov.id;
  }
  p.pagamenti.push(pag);
  db.ultimoContoIncassi = acc.id;
  if(p.stato==='bozza' || p.stato==='inviato' || p.stato==='rifiutato'){ p.stato='accettato'; if(!p.accettatoIl) p.accettatoIl = oggiStr(); }
  recalcPrev(p);
  prevDrawerTab = 'pagamenti';
  saveDB(); closeModal(); renderAll();
  toast(p.stato==='completato' ? `Tutto ricevuto: "${p.name}" è pagato 🎉` : `${euro(importo)} registrati · restano ${euro(prevStats(p).residuo)}`);
}
function modalAnnullaPagamento(pid, payId){
  const p = db.preventivati.find(x=>x.id===pid); const x = p && p.pagamenti.find(y=>y.id===payId); if(!x) return;
  openModal(`
    <h3>Annullare questo pagamento?</h3>
    <p class="modal-lead">${tipoPagLabel(x.tipo)} di ${euro(x.amount)} del ${fmtDate(x.date)}.${x.movId?' Verrà tolto anche dal saldo del conto e dai movimenti.':''}</p>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">No</button><button class="btn btn-danger-solid" onclick="annullaPagamento('${pid}','${payId}')">Annulla pagamento</button></div>
  `);
}
function annullaPagamento(pid, payId){
  const p = db.preventivati.find(x=>x.id===pid); const x = p && p.pagamenti.find(y=>y.id===payId); if(!x) return;
  if(x.movId){
    const acc = db.accounts.find(a=>a.id===x.accountId);
    if(acc && db.movimenti.some(m=>m.id===x.movId)) acc.balance = round2(Number(acc.balance) - Number(x.amount));
    db.movimenti = db.movimenti.filter(m=>m.id!==x.movId);
  }
  p.pagamenti = p.pagamenti.filter(y=>y.id!==payId);
  recalcPrev(p);
  saveDB(); closeModal(); renderAll(); toast('Pagamento annullato.');
}
function modalServeConto(){
  openModal(`<h3>Prima crea un conto</h3><p class="modal-lead">Serve almeno un conto (es. "Conto corrente" o "Contanti") su cui far arrivare i soldi.</p>
    <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button><button class="btn btn-primary" onclick="closeModal(); modalAccount()">Crea conto</button></div>`);
}

/* ---------- previsioni dello stipendio (non sono preventivi) ---------- */
function segnaStipendioRicevuto(x){
  if(!x.fromStipendioId) return;
  const st = db.stipendi.find(s=>s.id===x.fromStipendioId);
  if(st && !st.ricevuti.includes(x.fromStipendioMese)) st.ricevuti.push(x.fromStipendioMese);
}
function incassaPrevisione(id){
  const x = db.previsioni.find(p=>p.id===id); if(!x) return;
  if(!db.accounts.length) return modalServeConto();
  openModal(`
    <h3>Stipendio ricevuto</h3>
    <p class="modal-lead">La stima era ${euro(x.amount)}. Inserisci l'importo esatto arrivato per "${esc(x.name)}".</p>
    <div class="field"><label for="f-prev-importo">Importo (€)</label><input id="f-prev-importo" type="text" inputmode="decimal" autocomplete="off" value="${String(x.amount).replace('.',',')}"></div>
    <div class="field"><label for="f-account">Conto</label><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confermaIncassoPrevisione('${id}')">Conferma</button>
    </div>
  `);
}
function confermaIncassoPrevisione(id){
  const x = db.previsioni.find(p=>p.id===id);
  const acc = db.accounts.find(a=>a.id===document.getElementById('f-account').value);
  const importo = round2(parseNum(document.getElementById('f-prev-importo').value));
  if(!x || !acc) return toast('Seleziona un conto.');
  if(!(importo>0)) return toast('Inserisci un importo valido.');
  acc.balance = round2(Number(acc.balance) + importo);
  db.movimenti.push({ id:uid(), type:'entrata', name:x.name, amount:importo, date:oggiStr(), accountId:acc.id, category:'lavoro' });
  segnaStipendioRicevuto(x);
  db.previsioni = db.previsioni.filter(p=>p.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(importo)} aggiunti a ${acc.name}.`);
}

/* ---------- revisione guidata dei vecchi "eventi" importati ---------- */
function modalRevisioneImportati(){
  const lista = db.preventivati.filter(p=>p.importato);
  if(!lista.length) return toast('Niente da rivedere.');
  const clienti = elencoClientiNomi();
  openModal(`
    <h3>Rivedi gli eventi importati</h3>
    <p class="modal-lead">Erano nella vecchia sezione Eventi e sono diventati preventivi <b>confermati</b>. Per ognuno indica il cliente, lo stato giusto e quanto avevi <b>già ricevuto</b>: viene registrato senza toccare il saldo dei conti, perché quei soldi li hai già.</p>
    <datalist id="dl-clienti">${clienti.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
    <div class="import-list">
      ${lista.map(p=>`
        <div class="import-row" data-id="${p.id}">
          <div class="import-head"><b>${esc(p.name)}</b><span>${p.date?fmtDate(p.date):'senza data'} · ${euro(prevStats(p).totale)}</span></div>
          <div class="import-fields">
            <input class="imp-cliente" list="dl-clienti" placeholder="Cliente" value="${esc(p.cliente||'')}" aria-label="Cliente">
            <select class="imp-stato" aria-label="Stato">
              <option value="accettato" selected>Confermato</option>
              <option value="inviato">Inviato</option>
              <option value="bozza">Bozza</option>
              <option value="rifiutato">Rifiutato</option>
            </select>
            <input class="imp-ricevuto" type="text" inputmode="decimal" autocomplete="off" placeholder="Già ricevuto €" aria-label="Già ricevuto">
          </div>
        </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Più tardi</button>
      <button class="btn btn-primary" onclick="salvaRevisioneImportati()">Conferma tutti</button>
    </div>
  `, 'modal-wide');
}
function salvaRevisioneImportati(){
  document.querySelectorAll('.import-row').forEach(row=>{
    const p = db.preventivati.find(x=>x.id===row.dataset.id); if(!p) return;
    p.cliente = row.querySelector('.imp-cliente').value.trim();
    p.stato = row.querySelector('.imp-stato').value;
    if(p.stato==='accettato' && !p.accettatoIl) p.accettatoIl = oggiStr();
    const ric = round2(parseNum(row.querySelector('.imp-ricevuto').value));
    if(ric>0) p.pagamenti.push({ id:uid(), tipo:'acconto', amount:ric, date:oggiStr(), accountId:null, giaSulConto:true, nota:'registrato in revisione' });
    p.importato = false;
    recalcPrev(p);
  });
  saveDB(); closeModal(); renderAll(); toast('Preventivi aggiornati.');
}
// una vecchia voce "da ricevere" (es. evento passato) diventa un preventivo vero
function trasformaMancanteInPreventivo(mid){
  const m = db.mancanti.find(x=>x.id===mid); if(!m) return;
  const ieri = (()=>{ const d=new Date(); d.setDate(d.getDate()-1); return dateKeyFromDate(d); })();
  const p = { id:uid(), name:m.name, cliente:'', numero:prossimoNumeroPrev(), date:ieri, stato:'accettato', accettatoIl:oggiStr(), creato:oggiStr(),
    voci:[{ id:uid(), name:m.name, desc:m.note||'', qty:1, price:Number(m.amount)||0, amount:Number(m.amount)||0 }], pagamenti:[], sconto:0, acconto:0, note:'', color: ICON_COLORS[0] };
  recalcPrev(p);
  db.preventivati.push(p);
  db.mancanti = db.mancanti.filter(x=>x.id!==mid);
  saveDB(); renderAll(); modalPreventivato(p.id);
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
  db.preventivati.forEach(p=>{
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
  let list = datiClienti().sort((a,b)=> (a.key==='_')-(b.key==='_') || b.lavorato-a.lavorato || a.nome.localeCompare(b.nome,'it'));
  if(f.q) list = list.filter(c=>matches(c.nome,f.q));
  const conDebiti = list.filter(c=>c.daIncassare>0 && c.key!=='_');
  document.getElementById('page-clienti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Clienti</div><div class="page-sub">${plur(datiClienti().filter(c=>c.key!=='_').length,'cliente','clienti')} · si aggiornano da soli dai preventivi</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo preventivo</button></div>
    </div>
    ${conDebiti.length ? `<div class="card" style="margin-bottom:16px; border-color:rgba(10,132,255,0.3);">
      <div class="card-title">Ti devono ancora dei soldi</div>
      <div class="row-sub" style="white-space:normal; font-size:12.5px; margin-top:6px; line-height:1.6; display:block;">${conDebiti.map(c=>`<b style="color:var(--text)">${esc(c.nome)}</b> ${euro(c.daIncassare)}`).join(' · ')}</div>
    </div>` : ''}
    ${searchBar('clienti','Cerca cliente…')}
    <div class="list">
      ${list.length ? list.map(c=>`
        <div class="row-item clickable" onclick="apriCliente(${jsArg(c.nome)})">
          <div class="row-icon" style="background:var(--mint-dim); color:var(--mint);">${esc(c.nome.charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(c.nome)}</div>
            <div class="row-sub">${plur(c.prev.length,'preventivo','preventivi')}${c.daIncassare>0?` · <span style="color:var(--blue-soft)">${euro(c.daIncassare)} da incassare</span>`:''}${c.trattativa?` · ${euro(c.trattativa)} in attesa`:''}</div>
          </div>
          <div class="row-amount" title="Totale lavori confermati">${euro(c.lavorato)}</div>
        </div>`).join('') : emptyState('Nessun cliente ancora: compaiono qui quando scrivi il nome del cliente in un preventivo.')}
    </div>
  `;
}
function apriCliente(nome){
  const key = chiaveCliente(nome) || '_';
  const c = datiClienti().find(x=>x.key===key); if(!c) return;
  if(prevDrawerId) closePrevDrawer();
  const ord = [...c.prev].sort((a,b)=>(b.date||b.creato||'').localeCompare(a.date||a.creato||''));
  openModal(`
    <h3>${esc(c.nome)}</h3>
    <div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:14px 0 16px;">
      <div class="card" style="padding:12px;"><div class="card-title">Lavorato</div><div class="stat-value" style="font-size:15px;">${euro(c.lavorato)}</div></div>
      <div class="card" style="padding:12px;"><div class="card-title">Incassato</div><div class="stat-value" style="font-size:15px; color:var(--mint);">${euro(c.incassato)}</div></div>
      <div class="card" style="padding:12px;"><div class="card-title">Da incassare</div><div class="stat-value" style="font-size:15px; color:var(--blue-soft);">${euro(c.daIncassare)}</div></div>
    </div>
    <div class="list">
      ${ord.map(p=>`<div class="row-item clickable" onclick="closeModal(); openPrevDrawer('${p.id}')">
        <div class="row-main"><div class="row-title">${esc(p.name)}</div><div class="row-sub">${esc(p.numero||'')} · ${p.date?fmtDate(p.date):'senza data'}</div></div>
        ${statoPill(p.stato)}
        <div class="row-amount">${euro(prevStats(p).totale)}</div>
      </div>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Chiudi</button>
      ${c.key!=='_'?`<button class="btn btn-primary" onclick="closeModal(); modalPreventivato(null, ${jsArg(c.nome)})">+ Preventivo</button>`:''}
    </div>
  `, 'modal-wide');
}

/* ==================== DA RICEVERE (ex "Mancanti") ==================== */
function renderMancanti(){
  const f = filters.mancanti;
  const daPrev = prevMancanti();
  const totPrev = round2(daPrev.reduce((s,p)=>s+Number(p.amount),0));
  const totMan = round2(db.mancanti.reduce((s,m)=>s+Number(m.amount),0));
  let list = [...db.mancanti];
  let listPrev = [...daPrev];
  if(f.q){
    list = list.filter(m=> matches(m.name,f.q) || matches(m.note,f.q));
    listPrev = listPrev.filter(p=> matches(p.name,f.q) || matches(p.cliente,f.q));
  }
  const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
  document.getElementById('page-mancanti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Da ricevere</div><div class="page-sub">Totale in ritardo <strong style="color:var(--coral-soft)">${euro(totPrev+totMan)}</strong></div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalMancante()">+ Aggiungi</button></div>
    </div>
    ${(daPrev.length + db.mancanti.length) > 4 ? searchBar('mancanti','Cerca voce, lavoro o cliente…') : ''}

    <div class="section-title" style="margin-top:6px;">Lavori già svolti da saldare <span class="count">${euro(totPrev)}</span></div>
    <p class="section-help">Quando la data di un preventivo confermato è passata e non hai ricevuto tutto, il resto compare qui da solo.</p>
    <div class="list">
      ${listPrev.length ? listPrev.map(p=>{
        const st = prevStats(p);
        return `<div class="row-item clickable" onclick="openPrevDrawer('${p.id}','pagamenti')">
          <div class="row-icon" style="background:var(--coral-dim); color:var(--coral-soft);">${esc((p.cliente||p.name).charAt(0).toUpperCase())}</div>
          <div class="row-main">
            <div class="row-title">${esc(p.name)}</div>
            <div class="row-sub">${p.cliente?esc(p.cliente)+' · ':''}${esc(quandoTesto(p.date).toLowerCase())}${st.incassato?` · ricevuti ${euro(st.incassato)} di ${euro(st.totale)}`:''}</div>
          </div>
          <div class="row-amount" style="color:var(--coral-soft)">${euro(p.amount)}</div>
          <div class="row-actions inline" onclick="event.stopPropagation()">
            <button class="icon-btn" style="color:var(--mint)" title="Registra pagamento" aria-label="Registra pagamento" onclick="modalPagamento('${p.id}')">${ICO_OK}</button>
          </div>
        </div>`;}).join('') : emptyState(daPrev.length ? 'Nessun lavoro corrisponde alla ricerca.' : 'Nessun lavoro da saldare: tutti i lavori passati sono pagati.')}
    </div>

    <div class="section-title">Altri soldi da ricevere <span class="count">${euro(totMan)}</span></div>
    <div class="list">
      ${list.length ? list.map(m=>{
        const isStipendio = !!m.fromStipendioId;
        return `
        <div class="row-item">
          <div class="row-icon" style="background:${isStipendio?'var(--amber-dim)':'var(--coral-dim)'}; color:${isStipendio?'var(--amber)':'var(--coral-soft)'};">
            ${isStipendio ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>` : esc(m.name.charAt(0).toUpperCase())}
          </div>
          <div class="row-main">
            <div class="row-title">${esc(m.name)}</div>
            ${isStipendio ? `<div class="row-sub">Stima, da confermare all'accredito</div>` : (m.note?`<div class="row-sub">${esc(m.note)}</div>`:'')}
          </div>
          <div class="row-amount" style="color:var(--coral-soft)">${euro(m.amount)}</div>
          <div class="row-actions">
            ${isStipendio ? `<button class="icon-btn" style="color:var(--mint)" title="Ricevuto" aria-label="Ricevuto" onclick="modalAccreditaStipendio('${m.id}')">${ICO_OK}</button>` : `<button class="icon-btn" style="color:var(--mint)" title="Ricevuto" aria-label="Ricevuto" onclick="modalAccreditaMancante('${m.id}')">${ICO_OK}</button>
            <button class="icon-btn" title="Trasforma in preventivo" aria-label="Trasforma in preventivo" onclick="trasformaMancanteInPreventivo('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></svg></button>`}
            <button class="icon-btn" title="Modifica" aria-label="Modifica" onclick="modalMancante('${m.id}')">${ICO_EDIT}</button>
            <button class="icon-btn btn-danger" title="Elimina" aria-label="Elimina" onclick="deleteItem('mancanti','${m.id}')">${ICO_TRASH}</button>
          </div>
        </div>
      `;}).join('') : emptyState(db.mancanti.length ? 'Nessuna voce corrisponde alla ricerca.' : 'Nessun altro pagamento da ricevere.')}
    </div>
  `;
}
function modalAccreditaMancante(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  if(!db.accounts.length) return modalServeConto();
  openModal(`
    <h3>Soldi ricevuti</h3>
    <p class="modal-lead">Su quale conto sono arrivati i ${euro(m.amount)} di "${esc(m.name)}"?</p>
    <div class="field"><select id="f-account" aria-label="Conto">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confirmAccreditaMancante('${id}')">Conferma</button>
    </div>
  `);
}
function confirmAccreditaMancante(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  const acc = db.accounts.find(x=>x.id===document.getElementById('f-account').value);
  if(!acc) return toast('Seleziona un conto.');
  acc.balance = round2(Number(acc.balance) + Number(m.amount));
  db.movimenti.push({ id:uid(), type:'entrata', name:m.name, amount:Number(m.amount), date:oggiStr(), accountId:acc.id, category:'altro' });
  db.mancanti = db.mancanti.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(m.amount)} aggiunti a ${acc.name}.`);
}
function modalAccreditaStipendio(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  if(!db.accounts.length) return modalServeConto();
  openModal(`
    <h3>Stipendio ricevuto</h3>
    <p class="modal-lead">La stima era ${euro(m.amount)}. Inserisci l'importo esatto arrivato per "${esc(m.name)}".</p>
    <div class="field"><label for="f-stip-esatto">Importo esatto (€)</label><input id="f-stip-esatto" type="text" inputmode="decimal" autocomplete="off" value="${String(m.amount).replace('.',',')}"></div>
    <div class="field"><label for="f-account">Conto</label><select id="f-account">${db.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="confirmAccreditaStipendio('${id}')">Conferma</button>
    </div>
  `);
}
function confirmAccreditaStipendio(id){
  const m = db.mancanti.find(x=>x.id===id);
  if(!m) return;
  const acc = db.accounts.find(x=>x.id===document.getElementById('f-account').value);
  const importoEsatto = round2(parseNum(document.getElementById('f-stip-esatto').value));
  if(!acc) return toast('Seleziona un conto.');
  if(!(importoEsatto>0)) return toast('Inserisci un importo valido.');
  acc.balance = round2(Number(acc.balance) + importoEsatto);
  db.movimenti.push({ id:uid(), type:'entrata', name:m.name, amount:importoEsatto, date:oggiStr(), accountId:acc.id, category:'lavoro' });
  segnaStipendioRicevuto(m);
  db.mancanti = db.mancanti.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(importoEsatto)} accreditati su ${acc.name}.`);
}
function modalMancante(id){
  const isEdit=!!id; const m = isEdit? db.mancanti.find(x=>x.id===id): null;
  openModal(`
    <h3>${isEdit?'Modifica voce':'Soldi da ricevere'}</h3>
    <div class="field"><label for="f-name">Descrizione</label><input id="f-name" value="${esc(m?m.name:'')}" placeholder="Es. Rimborso da un amico" autocapitalize="sentences"></div>
    <div class="field"><label for="f-amount">Importo (€)</label><input id="f-amount" type="text" inputmode="decimal" autocomplete="off" value="${m?String(m.amount).replace('.',','):''}" placeholder="0,00"></div>
    <div class="field"><label for="f-note">Nota</label><input id="f-note" value="${esc(m?m.note||'':'')}" placeholder="Facoltativa"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveMancante('${id||''}')">${isEdit?'Salva':'Aggiungi'}</button>
    </div>
  `);
}
function saveMancante(id){
  const name = document.getElementById('f-name').value.trim();
  const amount = round2(parseNum(document.getElementById('f-amount').value));
  const note = document.getElementById('f-note').value.trim();
  if(!name) return toast('Inserisci una descrizione.');
  if(!(amount>0)) return toast('Inserisci un importo valido.');
  if(id){ const m=db.mancanti.find(x=>x.id===id); if(!m) return closeModal(); m.name=name; m.amount=amount; m.note=note; }
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
      <div class="field"><label>Importo (€)</label><input id="f-amount" type="text" inputmode="decimal" autocomplete="off" value="${f?f.amount:''}" placeholder="0,00"></div>
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
  const amount = parseNum(document.getElementById('f-amount').value)||0;
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
      ${db.preventivati.filter(p=>p.stato!=='rifiutato').map(p=>`<option value="${p.id}" ${f.prev===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
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
  const pr = { Alta:['var(--coral-dim)','var(--coral-soft)'], Media:['var(--amber-dim)','var(--amber)'], Bassa:['var(--blue-dim)','var(--blue-soft)'] }[t.priority];
  const voce = t.voceId && evTask ? evTask.voci.find(v=>v.id===t.voceId) : null;
  return `
  <div class="task-card ${t.done?'done':''} ${expanded?'expanded':''} ${overdue?'overdue':''}" data-task-id="${t.id}">
    <div class="task-head" onclick="toggleTaskExpand('${t.id}')">
      ${dragDisabled ? '' : `<span class="drag-handle task-drag-handle" title="Trascina per riordinare" onclick="event.stopPropagation()">${ICO_GRIP}</span>`}
      <button class="task-check ${t.done?'checked':''}" aria-label="${t.done?'Riapri':'Completa'}" onclick="event.stopPropagation(); toggleTask('${t.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></button>
      <div class="task-main">
        <div class="task-title ${t.done?'done':''}">${esc(t.text)}</div>
        ${t.note ? `<div class="task-note">${esc(t.note)}</div>` : ''}
        ${(evTask || t.prevNome || t.priority || t.dueDate || total) ? `<div class="task-meta-row">
          ${evTask ? `<button class="task-pill event-link" onclick="event.stopPropagation(); openPrevDrawer('${evTask.id}','lavori')" title="Apri preventivo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>${esc(evTask.name)}${voce?' · '+esc(voce.name):''}</button>` : (t.prevNome ? `<span class="task-pill" style="background:var(--surface-2); color:var(--text-faint);" title="Preventivo eliminato">${esc(t.prevNome)}</span>` : '')}
          ${pr ? `<span class="task-pill" style="background:${pr[0]}; color:${pr[1]};">${esc(t.priority)}</span>` : ''}
          ${t.dueDate ? `<span class="task-pill" style="background:${overdue?'var(--coral-dim)':'var(--surface-2)'}; color:${overdue?'var(--coral-soft)':'var(--text-dim)'};">${overdue?'Scaduto ':''}${fmtDate(t.dueDate)}</span>` : ''}
          ${total ? `<span class="task-pill" style="background:var(--surface-2); color:var(--text-dim);">${done}/${total}</span>` : ''}
        </div>` : ''}
        ${total ? `<div class="task-progress-mini"><div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${done===total?'var(--mint)':'var(--blue)'};"></div></div><span>${pct}%</span></div>` : ''}
      </div>
      <button class="icon-btn task-expand-btn" aria-label="${expanded?'Chiudi':'Apri'} dettagli" onclick="event.stopPropagation(); toggleTaskExpand('${t.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    ${expanded ? `
    <div class="task-body">
      <div class="subtask-list" data-task="${t.id}">
        ${subs.length ? subs.map(st=>`
          <div class="subtask-item" data-id="${st.id}">
            <span class="drag-handle" title="Trascina per riordinare">${ICO_GRIP}</span>
            <input type="checkbox" class="subtask-check" ${st.done?'checked':''} onchange="toggleSubtask('${t.id}','${st.id}')" aria-label="Completata">
            <div class="subtask-text ${st.done?'done':''}">${esc(st.text)}</div>
            ${evTask ? voceSelectHtml(evTask, st.voceId||'', `setVoceSub('${t.id}','${st.id}', this.value)`) : ''}
            <button class="subtask-del" aria-label="Elimina sotto-task" onclick="deleteSubtask('${t.id}','${st.id}')">${ICO_X}</button>
          </div>
        `).join('') : `<div class="row-sub" style="padding:4px 2px;">Dividi questo lavoro in passi più piccoli.</div>`}
      </div>
      <div class="add-subtask-row">
        <input type="text" id="subtask-input-${t.id}" placeholder="Aggiungi un sotto-task…" enterkeyhint="done" onkeydown="if(event.key==='Enter'){event.preventDefault(); addSubtask('${t.id}')}">
        <button onclick="addSubtask('${t.id}')">Aggiungi</button>
      </div>
      <div class="dr-actions-row" style="justify-content:flex-end;">
        <button class="btn btn-sm" style="flex:0 0 auto" onclick="modalTask('${t.id}')">${ICO_EDIT}Modifica</button>
        <button class="btn btn-sm btn-danger" style="flex:0 0 auto" onclick="deleteItem('tasks','${t.id}')">${ICO_TRASH}Elimina</button>
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
  document.addEventListener('pointercancel', onTaskDragEnd);
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
  document.removeEventListener('pointercancel', onTaskDragEnd);
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
        ${db.preventivati.map(p=>`<option value="${p.id}" ${prevSel===p.id?'selected':''}>${esc(p.name)}${p.cliente?' · '+esc(p.cliente):''}</option>`).join('')}
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
        <div class="page-title">Lista acquisti</div>
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
      <div class="field"><label>Prezzo unitario (€)</label><input id="f-price" type="text" inputmode="decimal" autocomplete="off" value="${a?a.price||'':''}" placeholder="0,00"></div>
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
  const price = parseNum(document.getElementById('f-price').value)||0;
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
  const ore = parseNum(document.getElementById('f-ore-sett').value);
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
      <div class="segmented">
        <label><input type="radio" name="f-sim-tipo" value="uscita" checked>Spesa</label>
        <label><input type="radio" name="f-sim-tipo" value="entrata">Entrata</label>
      </div>
    </div>
    <div class="field"><label>Descrizione</label><input id="f-sim-nome" placeholder="Es. Nuovo obiettivo, aumento stipendio..."></div>
    <div class="field"><label>Importo (€)</label><input id="f-sim-importo" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="aggiungiMovimentoSimulato()">Aggiungi</button>
    </div>
  `);
}
function aggiungiMovimentoSimulato(){
  const tipo = document.querySelector('input[name="f-sim-tipo"]:checked').value;
  const nome = document.getElementById('f-sim-nome').value.trim();
  const importo = parseNum(document.getElementById('f-sim-importo').value)||0;
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
    <div class="field"><label>Importo (€)</label><input id="f-sim-saldo" type="text" inputmode="decimal" autocomplete="off" value="${simState.saldo}"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="salvaSaldoPartenza()">Salva</button>
    </div>
  `);
}
function salvaSaldoPartenza(){
  simState.saldo = parseNum(document.getElementById('f-sim-saldo').value)||0;
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

/* ==================== ELIMINAZIONE (con annulla) ==================== */
const NOMI_COLLEZIONE = { accounts:'Conto', mancanti:'Voce', fisse:'Spesa fissa', tasks:'Task', acquisti:'Articolo', preventivati:'Preventivo' };
function deleteItem(collection, id){
  const arr = db[collection]; if(!Array.isArray(arr)) return;
  const idx = arr.findIndex(x=>x.id===id); if(idx<0) return;
  const item = arr[idx];
  if(collection==='accounts'){
    const n = db.movimenti.filter(m=>m.accountId===id || m.fromAccountId===id || m.toAccountId===id).length;
    return openModal(`
      <h3>Eliminare il conto "${esc(item.name)}"?</h3>
      <p class="modal-lead">Il saldo di ${euro(item.balance)} non verrà più contato.${n?` I suoi ${n} movimenti restano nell'elenco, indicati come "conto eliminato".`:''}</p>
      <div class="modal-actions"><button class="btn" onclick="closeModal()">Annulla</button><button class="btn btn-danger-solid" onclick="closeModal(); eliminaDavvero('accounts','${id}')">Elimina</button></div>`);
  }
  eliminaDavvero(collection, id);
}
function eliminaDavvero(collection, id){
  const arr = db[collection]; const idx = arr.findIndex(x=>x.id===id); if(idx<0) return;
  const item = arr[idx];
  const taskLegate = collection==='preventivati' ? prevTasks(id).map(t=>({ t, prevId:t.prevId, voceId:t.voceId })) : [];
  if(collection==='preventivati') scollegaTaskEvento(id);
  db[collection] = arr.filter(x=>x.id!==id);
  saveDB(); renderAll();
  toast(`${NOMI_COLLEZIONE[collection]||'Elemento'} eliminato.`, { label:'Annulla', fn:()=>{
    db[collection].splice(Math.min(idx, db[collection].length), 0, item);
    taskLegate.forEach(x=>{ x.t.prevId = x.prevId; x.t.voceId = x.voceId; });
    saveDB(); renderAll(); toast('Ripristinato.');
  }});
}
function deleteMovimento(id){
  const m = db.movimenti.find(x=>x.id===id);
  if(!m) return;
  if(m.rettifica) return toast('Le rettifiche di saldo non si eliminano: modifica di nuovo il saldo dal conto se serve.');
  const idx = db.movimenti.indexOf(m);
  // se il movimento è l'incasso di un preventivo, tolgo anche il pagamento collegato
  let prevLink = null;
  if(m.fromPrev){
    const p = db.preventivati.find(x=>x.id===m.fromPrev);
    const pag = p && p.pagamenti.find(x=>x.movId===m.id);
    if(p && pag){ prevLink = { p, pag }; p.pagamenti = p.pagamenti.filter(x=>x!==pag); recalcPrev(p); }
  }
  applyMovimentoEffect(m, -1);
  db.movimenti = db.movimenti.filter(x=>x.id!==id);
  saveDB(); renderAll();
  toast(prevLink ? 'Movimento eliminato e tolto dal preventivo.' : 'Movimento eliminato, saldo ripristinato.', { label:'Annulla', fn:()=>{
    db.movimenti.splice(Math.min(idx, db.movimenti.length), 0, m);
    applyMovimentoEffect(m, +1);
    if(prevLink){ prevLink.p.pagamenti.push(prevLink.pag); recalcPrev(prevLink.p); }
    saveDB(); renderAll(); toast('Ripristinato.');
  }});
}
