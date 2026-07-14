/* ===================== NUMERA — app.js =====================
   Persistenza locale (localStorage) per ora.
   Struttura dati pronta per essere sostituita 1:1 da Firestore:
   - users, session -> Firebase Auth
   - db.*           -> collections Firestore per utente
================================================================ */

const CURRENT_USER_KEY = 'numera_current_user'; // solo un puntatore locale a "chi è loggato su questo dispositivo"

const ICON_COLORS = ['#3DDC97','#6C8EFF','#F5B94D','#FF6B6B','#B27CFF','#4FD1E8'];

/* ---------- Firebase / Firestore ---------- */
// window._fb e window._fbReady sono impostati dallo script di init in index.html
const { db: firestoreDB, doc, getDoc, setDoc } = window._fb;

function userRef(collection, username){
  return doc(firestoreDB, collection, username.toLowerCase());
}
async function fbGetUser(username){
  const snap = await getDoc(userRef('numera_users', username));
  return snap.exists() ? snap.data() : null;
}
async function fbCreateUser(username, password, name){
  await setDoc(userRef('numera_users', username), { username, password, name });
}
async function fbLoadDB(username){
  const snap = await getDoc(userRef('numera_data', username));
  return snap.exists() ? snap.data() : seedDB();
}
async function fbLoadSnapshots(username){
  const snap = await getDoc(userRef('numera_snapshots', username));
  return snap.exists() ? (snap.data().list || []) : [];
}
async function fbPersist(username, dbData, snaps){
  await Promise.all([
    setDoc(userRef('numera_data', username), dbData),
    setDoc(userRef('numera_snapshots', username), { list: snaps })
  ]);
}

/* ---------- seed iniziale, ripreso dal tuo foglio Excel ---------- */
function seedDB(){
  return {
    accounts: [
      { id: uid(), name:'Conto Corrente', balance: 4630.45, icon:'CC', color:'#6C8EFF' },
      { id: uid(), name:'Denaro Contante', balance: 1150,    icon:'€',  color:'#3DDC97' },
      { id: uid(), name:'PostePay',        balance: 0.20,    icon:'PP', color:'#F5B94D' },
    ],
    preventivati: [
      mk('Mattia Ostuni', 300, '2026-07-22'),
      mk('60 Valeria', 100, '2026-07-18'),
      mk('18 Leonardo', 150, '2026-07-21'),
      mk('Gianluca Palasciano', 300, '2026-07-25', 'Saldo entro 01/08'),
      mk('25 Mariangela', 150, '2026-08-02'),
      mk('5 Anni Pina', 120, '2026-07-27'),
      mk('Swing&Soda', 150, '2026-09-11'),
      mk('Civitas Tonantis 2026', 1600, '2026-09-19'),
      mk('Zoo Safari (Luglio)', 1700, '2026-07-31'),
      mk('Zoo Safari (Agosto)', 1500, '2026-08-31'),
      mk('Zoo Safari (Settembre)', 1000, '2026-09-30'),
    ],
    mancanti: [
      { id: uid(), name:'Zoo Safari (Giugno)', amount: 1100, note:'' },
    ],
    fisse: [],
    obiettivi: [],
    acquisti: [],
    contatti: [
      { id: uid(), name:'Mattia Ostuni', phone:'', notes:'' },
      { id: uid(), name:'Gianluca Palasciano', phone:'', notes:'' },
    ],
  };
  function mk(name, amount, date, note){
    return { id: uid(), name, amount, date, note: note||'', color: ICON_COLORS[Math.floor(Math.random()*ICON_COLORS.length)] };
  }
}

function uid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function euro(n){ return (n<0?'-':'') + '€ ' + Math.abs(n).toLocaleString('it-IT',{minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtDate(d){ if(!d) return '—'; const dt = new Date(d+'T00:00:00'); return dt.toLocaleDateString('it-IT',{day:'2-digit', month:'short'}); }
function daysUntil(d){ const dt=new Date(d+'T00:00:00'); const now=new Date(); now.setHours(0,0,0,0); return Math.round((dt-now)/86400000); }

/* ---------------- state ---------------- */
let db = null;
let session = null;
let snapshots = [];

function getCurrentUsername(){ return localStorage.getItem(CURRENT_USER_KEY); }
function setCurrentUsername(u){ if(u) localStorage.setItem(CURRENT_USER_KEY, u); else localStorage.removeItem(CURRENT_USER_KEY); }

function saveDB(){
  if(!session) return;
  const today = new Date().toISOString().slice(0,10);
  const total = db.accounts.reduce((s,a)=>s+Number(a.balance||0),0);
  const idx = snapshots.findIndex(s=>s.date===today);
  if(idx>=0) snapshots[idx].total = total; else snapshots.push({date:today, total});
  snapshots = snapshots.slice(-120);
  fbPersist(session.username, db, snapshots).catch(err=>{
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
  document.getElementById('login-heading').textContent = isReg ? 'Crea account' : 'Bentornato';
  document.getElementById('login-sub').textContent = isReg
    ? 'Un username e una password per proteggere i tuoi dati finanziari.'
    : 'Accedi al tuo cockpit finanziario per gestire eventi, conti e obiettivi.';
  document.getElementById('login-submit').textContent = isReg ? 'Crea account' : 'Accedi';
  document.getElementById('login-toggle').innerHTML = isReg
    ? 'Hai già un account? <a href="#" id="toggle-link2">Accedi</a>'
    : 'Non hai un account? <a href="#" id="toggle-link2">Registrati</a>';
  document.getElementById('toggle-link2').addEventListener('click', (ev)=>{ ev.preventDefault(); document.getElementById('toggle-link').click(); });
  document.getElementById('login-error').style.display='none';
});

document.getElementById('login-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errBox = document.getElementById('login-error');
  errBox.style.display='none';

  const submitBtn = document.getElementById('login-submit');
  const prevLabel = submitBtn.textContent;
  submitBtn.disabled = true; submitBtn.textContent = 'Attendere…';

  try{
    await window._fbReady;

    if(authMode==='register'){
      const name = document.getElementById('reg-name').value.trim() || username;
      if(!username || !password){ return showErr('Inserisci username e password.'); }
      if(password.length < 4){ return showErr('La password deve avere almeno 4 caratteri.'); }
      const existing = await fbGetUser(username);
      if(existing){ return showErr('Username già esistente.'); }
      await fbCreateUser(username, password, name);
      setCurrentUsername(username);
      await startSession(name, username);
    } else {
      const user = await fbGetUser(username);
      if(!user || user.password !== password){ return showErr('Username o password non corretti.'); }
      setCurrentUsername(username);
      await startSession(user.name, user.username);
    }
  } catch(err){
    console.error(err);
    showErr('Errore di connessione a Firebase. Riprova.');
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = prevLabel;
  }

  function showErr(msg){ errBox.textContent = msg; errBox.style.display='block'; }
});

document.getElementById('logout-btn').addEventListener('click', ()=>{
  setCurrentUsername(null);
  session = null;
  document.getElementById('app').classList.remove('active');
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('login-form').reset();
});

async function startSession(name, username){
  session = { name, username };
  db = await fbLoadDB(username);
  snapshots = await fbLoadSnapshots(username);
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').classList.add('active');
  document.getElementById('user-name-display').textContent = name;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
  saveDB();
  renderAll();
}

/* auto-login if a session pointer exists su questo dispositivo */
(async function initAuth(){
  await window._fbReady;
  const username = getCurrentUsername();
  if(username){
    const user = await fbGetUser(username);
    if(user){ await startSession(user.name, user.username); }
    else setCurrentUsername(null);
  }
})();

/* ==================== NAV ==================== */
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click', ()=>{
    document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-'+item.dataset.page).classList.add('active');
  });
});

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
function renderAll(){
  renderDashboard();
  renderConti();
  renderPreventivati();
  renderMancanti();
  renderFisse();
  renderObiettivi();
  renderAcquisti();
  renderContatti();
  updateBadge();
}
function updateBadge(){
  const b = document.getElementById('badge-mancanti');
  b.textContent = db.mancanti.length || '';
  b.style.display = db.mancanti.length ? 'inline-block' : 'none';
}

/* ==================== DASHBOARD ==================== */
let chartTrend, chartBreakdown;
function renderDashboard(){
  const totalConti = db.accounts.reduce((s,a)=>s+Number(a.balance),0);
  const totalPrev = db.preventivati.reduce((s,a)=>s+Number(a.amount),0);
  const totalMancanti = db.mancanti.reduce((s,a)=>s+Number(a.amount),0);
  const totalFisseMensili = db.fisse.reduce((s,a)=> s + (a.frequency==='annuale' ? a.amount/12 : a.amount), 0);
  const subtotale = totalPrev + totalMancanti;
  const totaleGenerale = totalConti + subtotale;

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

  document.getElementById('page-dashboard').innerHTML = `
    <div class="topbar">
      <div>
        <div class="page-title">Dashboard</div>
        <div class="page-sub">Panoramica generale del tuo denaro, ${session.name}.</div>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="card">
        <div class="card-title">Denaro attuale</div>
        <div class="stat-value" style="color:var(--mint)">${euro(totalConti)}</div>
        ${trendPct!==null ? `<div class="stat-trend ${trendAbs>=0?'up':'down'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="${trendAbs>=0?'M5 12l5-5 4 4 5-6':'M5 6l5 5 4-4 5 6'}"/></svg>
          ${trendAbs>=0?'+':''}${trendPct.toFixed(1)}% (30gg)
        </div>` : `<div class="stat-trend" style="color:var(--text-faint)">Dati insufficienti (30gg)</div>`}
      </div>
      <div class="card">
        <div class="card-title">Preventivato</div>
        <div class="stat-value" style="color:var(--blue)">${euro(totalPrev)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${db.preventivati.length} eventi in arrivo</div>
      </div>
      <div class="card">
        <div class="card-title">Mancante</div>
        <div class="stat-value" style="color:var(--coral)">${euro(totalMancanti)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">${db.mancanti.length} da incassare</div>
      </div>
      <div class="card">
        <div class="card-title">Totale generale</div>
        <div class="stat-value">${euro(totaleGenerale)}</div>
        <div class="stat-trend" style="color:var(--text-faint)">Attuale + preventivato + mancante</div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-top:16px;">
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
  `;

  drawTrendChart(snaps);
  drawBreakdownChart();
}

function drawTrendChart(snaps){
  const ctx = document.getElementById('chart-trend');
  if(!ctx) return;
  if(chartTrend) chartTrend.destroy();
  const data = snaps.length ? snaps : [{date:new Date().toISOString().slice(0,10), total: db.accounts.reduce((s,a)=>s+Number(a.balance),0)}];
  chartTrend = new Chart(ctx, {
    type:'line',
    data:{
      labels: data.map(s=>fmtDate(s.date)),
      datasets:[{
        data: data.map(s=>s.total),
        borderColor:'#3DDC97', backgroundColor:'rgba(61,220,151,0.12)',
        fill:true, tension:0.35, pointRadius:0, borderWidth:2.5,
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c=> euro(c.raw) } } },
      scales:{
        x:{ grid:{display:false}, ticks:{ color:'#565E73', font:{size:10} } },
        y:{ grid:{color:'#1A1F2C'}, ticks:{ color:'#565E73', font:{size:10}, callback:v=>'€'+v } }
      }
    }
  });
}
function drawBreakdownChart(){
  const ctx = document.getElementById('chart-breakdown');
  if(!ctx) return;
  if(chartBreakdown) chartBreakdown.destroy();
  chartBreakdown = new Chart(ctx, {
    type:'doughnut',
    data:{
      labels: db.accounts.map(a=>a.name),
      datasets:[{ data: db.accounts.map(a=>Number(a.balance)), backgroundColor: db.accounts.map(a=>a.color), borderWidth:0 }]
    },
    options:{
      responsive:true, maintainAspectRatio:false, cutout:'68%',
      plugins:{ legend:{ position:'bottom', labels:{ color:'#8891A5', font:{size:11}, padding:12, boxWidth:8 } },
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
  const total = db.accounts.reduce((s,a)=>s+Number(a.balance),0);
  document.getElementById('page-conti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Conti</div><div class="page-sub">${db.accounts.length} sorgenti · totale ${euro(total)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalAccount()">+ Nuovo conto</button></div>
    </div>
    <div class="grid grid-3">
      ${db.accounts.map(a=>`
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
      <div class="card" style="display:flex; align-items:center; justify-content:center; border-style:dashed; cursor:pointer; color:var(--text-faint);" onclick="modalAccount()">
        + Aggiungi sorgente
      </div>
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
    a.name=name; a.balance=balance; a.color=color; a.icon = name.slice(0,2).toUpperCase();
  } else {
    db.accounts.push({ id:uid(), name, balance, color, icon:name.slice(0,2).toUpperCase() });
  }
  saveDB(); closeModal(); renderAll(); toast('Conto salvato.');
}

/* ==================== PREVENTIVATI ==================== */
function renderPreventivati(){
  const total = db.preventivati.reduce((s,p)=>s+Number(p.amount),0);
  const sorted = [...db.preventivati].sort((a,b)=> new Date(a.date||'2100-01-01') - new Date(b.date||'2100-01-01'));
  document.getElementById('page-preventivati').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Appuntamenti &amp; Preventivati</div><div class="page-sub">${db.preventivati.length} eventi · totale ${euro(total)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalPreventivato()">+ Nuovo evento</button></div>
    </div>
    <div class="list">
      ${sorted.length ? sorted.map(p=>{
        const d = p.date ? daysUntil(p.date) : null;
        return `<div class="row-item">
          <div class="row-icon" style="background:${p.color}22; color:${p.color};">${p.name.charAt(0).toUpperCase()}</div>
          <div class="row-main">
            <div class="row-title">${esc(p.name)}</div>
            <div class="row-sub">${fmtDate(p.date)}${d!==null ? ' · '+(d===0?'oggi':d<0?'passato':'tra '+d+' giorni') : ''}${p.note?' · '+esc(p.note):''}</div>
          </div>
          <div class="row-amount" style="color:var(--blue)">${euro(p.amount)}</div>
          <div class="row-actions">
            <button class="icon-btn" onclick="modalPreventivato('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn" style="color:var(--mint)" title="Segna come incassato" onclick="convertToAccount('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('preventivati','${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>`;
      }).join('') : emptyState('Nessun evento preventivato. Aggiungine uno.')}
    </div>
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
  db.preventivati = db.preventivati.filter(x=>x.id!==id);
  saveDB(); closeModal(); renderAll(); toast(`${euro(p.amount)} aggiunti a ${acc.name}.`);
}

/* ==================== MANCANTI ==================== */
function renderMancanti(){
  const total = db.mancanti.reduce((s,m)=>s+Number(m.amount),0);
  document.getElementById('page-mancanti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Soldi Mancanti</div><div class="page-sub">${db.mancanti.length} voci · totale ${euro(total)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalMancante()">+ Aggiungi</button></div>
    </div>
    <div class="list">
      ${db.mancanti.length ? db.mancanti.map(m=>`
        <div class="row-item">
          <div class="row-icon" style="background:var(--coral-dim); color:var(--coral);">${m.name.charAt(0).toUpperCase()}</div>
          <div class="row-main"><div class="row-title">${esc(m.name)}</div>${m.note?`<div class="row-sub">${esc(m.note)}</div>`:''}</div>
          <div class="row-amount" style="color:var(--coral)">${euro(m.amount)}</div>
          <div class="row-actions">
            <button class="icon-btn" onclick="modalMancante('${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('mancanti','${m.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>
      `).join('') : emptyState('Nessun pagamento mancante. Ottimo segno.')}
    </div>
  `;
}
function modalMancante(id){
  const isEdit=!!id; const m = isEdit? db.mancanti.find(x=>x.id===id): null;
  openModal(`
    <h3>${isEdit?'Modifica voce':'Nuovo pagamento mancante'}</h3>
    <div class="field"><label>Descrizione</label><input id="f-name" value="${m?esc(m.name):''}" placeholder="Es. Zoo Safari Giugno"></div>
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
function renderFisse(){
  const mensile = db.fisse.reduce((s,f)=> s + (f.frequency==='annuale'? f.amount/12 : f.amount), 0);
  document.getElementById('page-fisse').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Spese fisse ricorrenti</div><div class="page-sub">${db.fisse.length} voci · impatto mensile ${euro(mensile)}</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalFissa()">+ Aggiungi</button></div>
    </div>
    <div class="list">
      ${db.fisse.length ? db.fisse.map(f=>`
        <div class="row-item">
          <div class="row-icon" style="background:var(--amber-dim); color:var(--amber);">${f.name.charAt(0).toUpperCase()}</div>
          <div class="row-main"><div class="row-title">${esc(f.name)}</div><div class="row-sub">${f.frequency==='annuale'?'Annuale':'Mensile'}</div></div>
          <div class="row-amount" style="color:var(--amber)">${euro(f.amount)}</div>
          <div class="row-actions">
            <button class="icon-btn" onclick="modalFissa('${f.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('fisse','${f.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>
      `).join('') : emptyState('Nessuna spesa fissa registrata.')}
    </div>
  `;
}
function modalFissa(id){
  const isEdit=!!id; const f = isEdit? db.fisse.find(x=>x.id===id): null;
  openModal(`
    <h3>${isEdit?'Modifica spesa':'Nuova spesa fissa'}</h3>
    <div class="field"><label>Nome</label><input id="f-name" value="${f?esc(f.name):''}" placeholder="Es. Assicurazione drone"></div>
    <div class="field-row">
      <div class="field"><label>Importo (€)</label><input id="f-amount" type="number" step="0.01" value="${f?f.amount:''}" placeholder="0.00"></div>
      <div class="field"><label>Frequenza</label><select id="f-freq">
        <option value="mensile" ${f&&f.frequency==='mensile'?'selected':''}>Mensile</option>
        <option value="annuale" ${f&&f.frequency==='annuale'?'selected':''}>Annuale</option>
      </select></div>
    </div>
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
  if(!name) return toast('Inserisci un nome.');
  if(id){ const f=db.fisse.find(x=>x.id===id); f.name=name; f.amount=amount; f.frequency=frequency; }
  else db.fisse.push({ id:uid(), name, amount, frequency });
  saveDB(); closeModal(); renderAll(); toast('Salvato.');
}

/* ==================== OBIETTIVI ==================== */
function renderObiettivi(){
  document.getElementById('page-obiettivi').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Obiettivi finanziari</div><div class="page-sub">${db.obiettivi.length} obiettivi attivi</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalObiettivo()">+ Nuovo obiettivo</button></div>
    </div>
    <div class="grid grid-3">
      ${db.obiettivi.length ? db.obiettivi.map(o=>{
        const pct = Math.min(100, (o.current/o.target*100)||0);
        return `<div class="card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div class="card-title">${esc(o.name)}</div>
            <div class="row-actions">
              <button class="icon-btn" onclick="modalObiettivo('${o.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
              <button class="icon-btn btn-danger" onclick="deleteItem('obiettivi','${o.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
            </div>
          </div>
          <div class="stat-value" style="margin-top:8px; font-size:20px;">${euro(o.current)} <span style="color:var(--text-faint); font-size:13px; font-weight:500;">/ ${euro(o.target)}</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${o.color};"></div></div>
          <div class="row-sub" style="margin-top:8px;">${pct.toFixed(0)}% raggiunto${o.deadline?' · entro '+fmtDate(o.deadline):''}</div>
        </div>`;
      }).join('') : `<div class="card" style="grid-column:1/-1;">${emptyState('Nessun obiettivo. Crea il primo, es. "Fondo emergenze" o "Nuovo drone".')}</div>`}
    </div>
  `;
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
  if(id){ const o=db.obiettivi.find(x=>x.id===id); o.name=name; o.current=current; o.target=target; o.deadline=deadline; o.color=color; }
  else db.obiettivi.push({ id:uid(), name, current, target, deadline, color });
  saveDB(); closeModal(); renderAll(); toast('Obiettivo salvato.');
}

/* ==================== LISTA ACQUISTI ==================== */
function renderAcquisti(){
  const pending = db.acquisti.filter(a=>!a.bought);
  const totalPending = pending.reduce((s,a)=>s+Number(a.price||0),0);
  document.getElementById('page-acquisti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Lista Acquisti</div><div class="page-sub">${pending.length} da comprare · ${euro(totalPending)} previsti</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalAcquisto()">+ Aggiungi</button></div>
    </div>
    <div class="list">
      ${db.acquisti.length ? db.acquisti.slice().sort((a,b)=>a.bought-b.bought).map(a=>`
        <div class="row-item" style="${a.bought?'opacity:.5;':''}">
          <div class="chip-check"><input type="checkbox" ${a.bought?'checked':''} onchange="toggleAcquisto('${a.id}')"></div>
          <div class="row-main">
            <div class="row-title" style="${a.bought?'text-decoration:line-through;':''}">${esc(a.name)}</div>
            ${a.priority?`<div class="row-sub">Priorità: ${esc(a.priority)}</div>`:''}
          </div>
          <div class="row-amount">${a.price?euro(a.price):'—'}</div>
          <div class="row-actions">
            <button class="icon-btn btn-danger" onclick="deleteItem('acquisti','${a.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>
      `).join('') : emptyState('Lista vuota. Aggiungi il primo articolo.')}
    </div>
  `;
}
function modalAcquisto(){
  openModal(`
    <h3>Nuovo articolo</h3>
    <div class="field"><label>Nome</label><input id="f-name" placeholder="Es. Batteria drone di scorta"></div>
    <div class="field-row">
      <div class="field"><label>Prezzo stimato (€)</label><input id="f-price" type="number" step="0.01" placeholder="0.00"></div>
      <div class="field"><label>Priorità</label><select id="f-priority">
        <option value="">—</option><option value="Bassa">Bassa</option><option value="Media">Media</option><option value="Alta">Alta</option>
      </select></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveAcquisto()">Aggiungi</button>
    </div>
  `);
}
function saveAcquisto(){
  const name = document.getElementById('f-name').value.trim();
  const price = parseFloat(document.getElementById('f-price').value)||0;
  const priority = document.getElementById('f-priority').value;
  if(!name) return toast('Inserisci un nome.');
  db.acquisti.push({ id:uid(), name, price, priority, bought:false });
  saveDB(); closeModal(); renderAll(); toast('Aggiunto alla lista.');
}
function toggleAcquisto(id){ const a=db.acquisti.find(x=>x.id===id); a.bought=!a.bought; saveDB(); renderAcquisti(); }

/* ==================== CONTATTI ==================== */
function renderContatti(){
  document.getElementById('page-contatti').innerHTML = `
    <div class="topbar">
      <div><div class="page-title">Contatti</div><div class="page-sub">${db.contatti.length} persone collegate ai tuoi eventi</div></div>
      <div class="topbar-actions"><button class="btn btn-primary" onclick="modalContatto()">+ Nuovo contatto</button></div>
    </div>
    <div class="list">
      ${db.contatti.length ? db.contatti.map(c=>{
        const linked = db.preventivati.filter(p=>p.name.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]));
        return `<div class="row-item">
          <div class="row-icon" style="background:var(--blue-dim); color:var(--blue);">${c.name.charAt(0).toUpperCase()}</div>
          <div class="row-main">
            <div class="row-title">${esc(c.name)}</div>
            <div class="row-sub">${c.phone?esc(c.phone)+' · ':''}${linked.length} eventi collegati</div>
          </div>
          <div class="row-actions">
            <button class="icon-btn" onclick="modalContatto('${c.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
            <button class="icon-btn btn-danger" onclick="deleteItem('contatti','${c.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
          </div>
        </div>`;
      }).join('') : emptyState('Nessun contatto salvato.')}
    </div>
  `;
}
function modalContatto(id){
  const isEdit=!!id; const c = isEdit? db.contatti.find(x=>x.id===id): null;
  openModal(`
    <h3>${isEdit?'Modifica contatto':'Nuovo contatto'}</h3>
    <div class="field"><label>Nome</label><input id="f-name" value="${c?esc(c.name):''}" placeholder="Es. Francesca"></div>
    <div class="field"><label>Telefono</label><input id="f-phone" value="${c?esc(c.phone||''):''}" placeholder="Opzionale"></div>
    <div class="field"><label>Note</label><input id="f-notes" value="${c?esc(c.notes||''):''}" placeholder="Opzionale"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Annulla</button>
      <button class="btn btn-primary" onclick="saveContatto('${id||''}')">${isEdit?'Salva':'Crea'}</button>
    </div>
  `);
}
function saveContatto(id){
  const name = document.getElementById('f-name').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const notes = document.getElementById('f-notes').value.trim();
  if(!name) return toast('Inserisci un nome.');
  if(id){ const c=db.contatti.find(x=>x.id===id); c.name=name; c.phone=phone; c.notes=notes; }
  else db.contatti.push({ id:uid(), name, phone, notes });
  saveDB(); closeModal(); renderAll(); toast('Contatto salvato.');
}

/* ==================== SHARED DELETE ==================== */
function deleteItem(collection, id){
  db[collection] = db[collection].filter(x=>x.id!==id);
  saveDB(); renderAll(); toast('Eliminato.');
}
