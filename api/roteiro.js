// /api/roteiro.js
export const config = { runtime: 'nodejs' }; // Serverless Node.js (Vercel)

import sgMail from '@sendgrid/mail';

/* ----------------------- debug/log helpers ----------------------- */

function env(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  return raw.trim().replace(/^['"]|['"]$/g, '');
}
const DEBUG = env('DEBUG_ROTEIRO') === '1' || (env('DEBUG') || '').toLowerCase().includes('roteiro');

const log = (...args) => { if (DEBUG) console.log('[roteiro]', ...args); };
const logError = (...args) => console.error('[roteiro]', ...args);
const safeTruncate = (s, n = 600) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
const maskEmail = (e='') => e.replace(/(^.).*(@.*$)/, (_, a, b) => `${a}***${b}`);

function newReqId() {
  const rnd = Math.random().toString(16).slice(2, 10);
  return `rt-${Date.now().toString(36)}-${rnd}`;
}

/* ----------------------- utils ----------------------- */

const escapeHtml = (s = '') =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally { clearTimeout(t); }
}

async function safeJson(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

function fmtDate(d = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}
function fmtMoneyBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 }).format(v);
}
function fmtNumberBR(v, decimals = 2) {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
}

// símbolos de moeda (básico)
const CURRENCY_SYMBOLS = {
  BRL:'R$', USD:'$', EUR:'€', GBP:'£', JPY:'¥', CNY:'¥', HKD:'$', TWD:'$', SGD:'$', CAD:'$', AUD:'$', NZD:'$',
  MXN:'$', ARS:'$', CLP:'$', COP:'$', PEN:'S/', UYU:'$U', BOB:'Bs', PYG:'₲', ZAR:'R',
  CHF:'CHF', DKK:'kr', NOK:'kr', SEK:'kr', PLN:'zł', CZK:'Kč', HUF:'Ft', RON:'lei',
  TRY:'₺', ILS:'₪', AED:'د.إ', SAR:'﷼', QAR:'﷼', KWD:'KD', BHD:'BD', INR:'₹', THB:'฿', KRW:'₩', IDR:'Rp', MYR:'RM', PHP:'₱'
};
const currencyLabel = (code = 'BRL', name = '') => {
  const sym = CURRENCY_SYMBOLS[code] || '';
  return `${code}${name ? ` — ${name}` : ''}${sym ? ` — símbolo: ${sym}` : ''}`;
};

// "R$ 5.500", "5,5 mil", "5500" -> Number
function parseBudgetBR(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/\s/g, '');
  s = s.replace(/^r\$\s*/i, '');
  const mil = /mil$/.test(s);
  if (mil) s = s.replace(/mil$/, '');
  s = s.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return null;
  return mil ? v * 1000 : v;
}

// tolerância 2% para detectar x10
function almostEqual(a, b, tol = 0.02) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 && b === 0) return true;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= tol;
}

function regionLabelPT(t) {
  const m = { city: 'Cidade', state: 'Estado', country: 'País', region: 'Região' };
  return m[(t || '').toLowerCase()] || t || 'Região';
}

// extrai texto do retorno da Responses API
function extractResponsesText(obj) {
  try {
    if (Array.isArray(obj?.output)) {
      const pieces = [];
      for (const item of obj.output) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === 'output_text' && typeof c.text === 'string') {
              pieces.push(c.text);
            }
          }
        } else if (item?.type === 'output_text' && typeof item.text === 'string') {
          pieces.push(item.text);
        }
      }
      return pieces.join('\n');
    }
  } catch { /* ignore */ }
  return obj?.choices?.[0]?.message?.content || '';
}

/* ----------------------- IATA helpers (super robusto) ----------------------- */

// Normalizador: remove acentos e pontuações leves
function normalizeKey(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // acentos
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')               // pontuação → espaço
    .replace(/\s+/g, ' ')
    .trim();
}

// aeroportos → código de CIDADE (agrupador) quando existir
const AIRPORT_TO_CITY = {
  // ===== BRASIL =====
  GRU:'SAO', CGH:'SAO', VCP:'SAO',
  GIG:'RIO', SDU:'RIO',
  CNF:'BHZ', PLU:'BHZ',
  BSB:'BSB',
  SSA:'SSA',
  REC:'REC',
  FOR:'FOR',
  NAT:'NAT', JPA:'JPA', MCZ:'MCZ', AJU:'AJU',
  BEL:'BEL', MAO:'MAO', MCP:'MCP', BVB:'BVB',
  PMW:'PMW', CGB:'CGB', CGR:'CGR', GYN:'GYN',
  POA:'POA', CWB:'CWB', FLN:'FLN', NVT:'NVT', IGU:'IGU',
  IOS:'IOS', BPS:'BPS', PHB:'PHB', STM:'STM', FEN:'FEN', SLZ:'SLZ', THE:'THE', VIX:'VIX', CXJ:'CXJ',

  // ===== EUA =====
  JFK:'NYC', LGA:'NYC', EWR:'NYC',
  MCO:'ORL', SFB:'ORL', ORL:'ORL',
  FLL:'MIA', MIA:'MIA', PBI:'MIA',
  IAD:'WAS', DCA:'WAS', BWI:'WAS',
  ORD:'CHI', MDW:'CHI',
  LAX:'LAX', BUR:'LAX', LGB:'LAX', SNA:'LAX', ONT:'LAX',
  SFO:'SFO', OAK:'SFO', SJC:'SFO',
  SEA:'SEA', PDX:'PDX', SAN:'SAN', LAS:'LAS',
  ATL:'ATL', DFW:'DFW', DAL:'DFW', IAH:'HOU', HOU:'HOU',
  BOS:'BOS', HNL:'HNL',

  // ===== CANADÁ =====
  YYZ:'YTO', YTZ:'YTO', YHM:'YTO',
  YUL:'YMQ', YHU:'YMQ',
  YVR:'YVR', YQB:'YQB', YYC:'YYC', YEG:'YEG',

  // ===== MÉXICO / CARIBE =====
  MEX:'MEX', NLU:'MEX', TLC:'MEX',
  CUN:'CUN', SJD:'SJD', PVR:'PVR', GDL:'GDL',
  PUJ:'PUJ', SDQ:'SDQ', POP:'POP', STI:'STI',
  HAV:'HAV',

  // ===== EUROPA =====
  // UK (LON)
  LHR:'LON', LGW:'LON', LCY:'LON', LTN:'LON', STN:'LON', SEN:'LON',
  // França (PAR)
  CDG:'PAR', ORY:'PAR', BVA:'PAR',
  // Itália
  FCO:'ROM', CIA:'ROM',
  MXP:'MIL', LIN:'MIL', BGY:'MIL',
  // Espanha
  MAD:'MAD', BCN:'BCN', VLC:'VLC', SVQ:'SVQ', AGP:'AGP',
  PMI:'PMI', IBZ:'IBZ', TFS:'TCI', TFN:'TCI', LPA:'LPA',
  // Portugal
  LIS:'LIS', OPO:'OPO', FAO:'FAO', FNC:'FNC', PDL:'PDL', TER:'TER',
  // BeNeLux
  AMS:'AMS', BRU:'BRU', CRL:'BRU',
  // Alemanha
  FRA:'FRA', MUC:'MUC', BER:'BER', TXL:'BER', SXF:'BER',
  HAM:'HAM', DUS:'DUS', CGN:'CGN',
  // Nórdicos
  CPH:'CPH',
  ARN:'STO', BMA:'STO', NYO:'STO', VST:'STO',
  OSL:'OSL', HEL:'HEL',
  // Centro/Leste
  PRG:'PRG', BUD:'BUD', WAW:'WAW', KRK:'KRK', VIE:'VIE',
  // Suíça
  ZRH:'ZRH', GVA:'GVA', BSL:'BSL',
  // Grécia
  ATH:'ATH', JTR:'JTR', JMK:'JMK',
  // Irlanda
  DUB:'DUB', SNN:'SNN', ORK:'ORK',

  // ===== ÁFRICA / ME =====
  CMN:'CMN', RAK:'RAK', AGA:'AGA',
  CAI:'CAI', HRG:'HRG', SSH:'SSH',
  JNB:'JNB', CPT:'CPT', NBO:'NBO',
  IST:'IST', SAW:'IST',
  DXB:'DXB', DWC:'DXB', AUH:'AUH', DOH:'DOH', TLV:'TLV',

  // ===== ÁSIA-PACÍFICO =====
  // Japão
  HND:'TYO', NRT:'TYO',
  KIX:'OSA', ITM:'OSA', UKB:'OSA',
  // Coreia
  ICN:'SEL', GMP:'SEL',
  // China
  PEK:'BJS', PKX:'BJS',
  PVG:'SHA', SHA:'SHA',
  // HK / Macau / Shenzhen
  HKG:'HKG', MFM:'MFM', SZX:'SZX',
  // Sudeste Asiático
  BKK:'BKK', DMK:'BKK',
  HKT:'HKT', CNX:'CNX',
  HAN:'HAN', SGN:'SGN',
  KUL:'KUL', SIN:'SIN',
  // Indonésia
  CGK:'JKT', HLP:'JKT', DPS:'DPS',
  // Filipinas
  MNL:'MNL', CEB:'CEB',
  // Índia
  DEL:'DEL', BOM:'BOM', BLR:'BLR', MAA:'MAA', HYD:'HYD', GOI:'GOI',
  // ANZ
  SYD:'SYD', MEL:'MEL', BNE:'BNE', PER:'PER', ADL:'ADL',
  AKL:'AKL', WLG:'WLG', CHC:'CHC', ZQN:'ZQN'
};

// aliases e destinos → código da cidade (ou aeroporto mais próximo)
const IATA_HINTS = {
  // ===================== BRASIL — CAPITAIS / GRANDES CENTROS =====================
  'sao paulo':'SAO','sampa':'SAO','sp':'SAO',
  'rio de janeiro':'RIO','rio':'RIO',
  'brasilia':'BSB',
  'belo horizonte':'BHZ',
  'salvador':'SSA','recife':'REC','fortaleza':'FOR','maceio':'MCZ','natal':'NAT','joao pessoa':'JPA','aracaju':'AJU',
  'vitoria':'VIX','belem':'BEL','manaus':'MAO','boa vista':'BVB','macapa':'MCP',
  'palmas':'PMW','cuiaba':'CGB','campo grande':'CGR','goiania':'GYN',
  'porto alegre':'POA','curitiba':'CWB','florianopolis':'FLN','campinas':'VCP','viracopos':'VCP','caxias do sul':'CXJ',
  'foz do iguacu':'IGU','foz do iguaçu':'IGU',

  // ===================== BRASIL — DESTINOS (sem aeroporto na cidade) =====================
  'maragogi':'MCZ','maragoji':'MCZ','maragogi al':'MCZ','maragogi brasil':'MCZ',
  'porto de galinhas':'REC',
  'morro de sao paulo':'SSA','morro de são paulo':'SSA','boipeba':'SSA',
  'chapada diamantina':'SSA','lencois bahia':'SSA','lençóis bahia':'SSA',
  'barreirinhas':'SLZ','lencois maranhenses':'SLZ','lençóis maranhenses':'SLZ',
  'jalapao':'PMW',
  'gramado':'POA','canela':'POA','serra gaucha':'POA','bento goncalves':'POA','bento gonçalves':'POA',
  'arraial do cabo':'RIO','buzios':'RIO','armacao dos buzios':'RIO','armação dos búzios':'RIO','angra dos reis':'RIO','ilha grande':'RIO','paraty':'RIO',
  'balneario camboriu':'NVT','balneário camboriú':'NVT','bombinhas':'NVT','penha':'NVT','beto carreiro':'NVT','beto carrero':'NVT','beto carreiro world':'NVT',
  'garopaba':'FLN','praia do rosa':'FLN','imbituba':'FLN',
  'ilha do mel':'CWB','ilhabela':'SAO','ubatuba':'SAO','maresias':'SAO',
  'itacare':'IOS','itacaré':'IOS','marau':'IOS','peninsula de marau':'IOS','península de maraú':'IOS','barra grande bahia':'IOS',
  'trancoso':'BPS','caraiva':'BPS','caraíva':'BPS','arraial d ajuda':'BPS','arraial d\'ajuda':'BPS','arraial dajuda':'BPS',
  'praia do forte':'SSA','pipa':'NAT','jericoacoara':'FOR','jijoca':'FOR',
  'alter do chao':'STM','alter do chão':'STM',
  'chapada dos veadeiros':'BSB','alto paraiso de goias':'BSB','alto paraíso de goiás':'BSB',
  'chapada dos guimaraes':'CGB','chapada dos guimarães':'CGB',
  'pantanal':'CGR','bonito ms':'CGR','fernando de noronha':'FEN',
  'barra grande piaui':'PHB','barra grande pi':'PHB',

  // ===================== AMÉRICAS =====================
  // EUA hubs & cidades
  'nova york':'NYC','new york':'NYC',
  'orlando':'ORL','miami':'MIA','fort lauderdale':'MIA',
  'boston':'BOS','chicago':'CHI','washington':'WAS','washington dc':'WAS','dc':'WAS',
  'los angeles':'LAX','san francisco':'SFO','las vegas':'LAS',
  'seattle':'SEA','san diego':'SAN','atlanta':'ATL','houston':'HOU','dallas':'DFW','honolulu':'HNL',
  // México & vizinhos
  'cidade do mexico':'MEX','cdmx':'MEX','mexico city':'MEX',
  'cancun':'CUN','riviera maya':'CUN','playa del carmen':'CUN','tulum':'CUN',
  'los cabos':'SJD','puerto vallarta':'PVR','guadalajara':'GDL',
  // Canadá
  'toronto':'YTO','montreal':'YMQ','vancouver':'YVR','quebec':'YQB',
  // Andinos
  'lima':'LIM','cusco':'CUZ','arequipa':'AQP','machu picchu':'CUZ',
  'bogota':'BOG','medellin':'MDE','cartagena':'CTG','san andres':'ADZ','san andrés':'ADZ',
  'quito':'UIO','guayaquil':'GYE',
  'la paz bolivia':'LPB','santa cruz bolivia':'VVI','uyuni':'UYU',
  'buenos aires':'BUE','bariloche':'BRC','mendoza':'MDZ','ushuaia':'USH','el calafate':'FTE',
  'santiago':'SCL','montevideo':'MVD','punta del este':'PDP',
  'havana':'HAV','punta cana':'PUJ','republica dominicana':'PUJ',

  // ===================== EUROPA =====================
  'lisboa':'LIS','porto':'OPO','faro':'FAO','funchal':'FNC','madeira':'FNC',
  'madrid':'MAD','barcelona':'BCN','valencia':'VLC','sevilla':'SVQ','sevilha':'SVQ','malaga':'AGP','mallorca':'PMI','palma de mallorca':'PMI','ibiza':'IBZ','tenerife':'TCI','gran canaria':'LPA',
  'londres':'LON','manchester':'MAN','edimburgo':'EDI','dublin':'DUB',
  'paris':'PAR','lyon':'LYS','nice':'NCE','cote d azur':'NCE','côte d azur':'NCE',
  'amsterdam':'AMS','bruxelas':'BRU',
  'berlim':'BER','frankfurt':'FRA','munique':'MUC','munich':'MUC','hamburgo':'HAM','dusseldorf':'DUS','düsseldorf':'DUS','colonia':'CGN','colônia':'CGN',
  'zurique':'ZRH','genebra':'GVA','basel':'BSL',
  'viena':'VIE','praga':'PRG','budapeste':'BUD','varsovia':'WAW','varsóvia':'WAW','krakow':'KRK','cracovia':'KRK',
  'copenhague':'CPH','estocolmo':'STO','oslo':'OSL','helsinki':'HEL',
  'roma':'ROM','veneza':'VCE','milao':'MIL','milão':'MIL','florenca':'FLR','florença':'FLR','napoles':'NAP','nápoles':'NAP',
  'atenas':'ATH','santorini':'JTR','mykonos':'JMK',

  // ===================== ÁFRICA & ORIENTE MÉDIO =====================
  'casablanca':'CMN','marrakesh':'RAK','marraquesh':'RAK','agadir':'AGA',
  'cairo':'CAI','hurghada':'HRG','sharm el sheikh':'SSH',
  'johanesburgo':'JNB','cidade do cabo':'CPT','cape town':'CPT','nairobi':'NBO',
  'istambul':'IST','istanbul':'IST','dubai':'DXB','abu dhabi':'AUH','doha':'DOH','tel aviv':'TLV',

  // ===================== ÁSIA-PACÍFICO =====================
  'toquio':'TYO','tokyo':'TYO',
  'osaka':'OSA','kyoto':'OSA','nara':'OSA',
  'seul':'SEL',
  'pequim':'BJS','beijing':'BJS',
  'xangai':'SHA','shanghai':'SHA',
  'hong kong':'HKG','macau':'MFM','shenzhen':'SZX',
  'bangkok':'BKK','phuket':'HKT','chiang mai':'CNX',
  'hanoi':'HAN','ho chi minh':'SGN',
  'kuala lumpur':'KUL','singapura':'SIN',
  'bali':'DPS','denpasar':'DPS','jacarta':'JKT',
  'manila':'MNL','cebu':'CEB',
  'delhi':'DEL','mumbai':'BOM','bangalore':'BLR','chennai':'MAA','hyderabad':'HYD','goa':'GOI',
  'sydney':'SYD','melbourne':'MEL','brisbane':'BNE','perth':'PER','adelaide':'ADL',
  'auckland':'AKL','queenstown':'ZQN','wellington':'WLG','christchurch':'CHC',

  // ===================== PAÍSES → HUB PRINCIPAL =====================
  'portugal':'LIS','espanha':'MAD','franca':'PAR','france':'PAR',
  'italia':'ROM','italy':'ROM','alemanha':'BER','germany':'BER',
  'reino unido':'LON','uk':'LON','united kingdom':'LON','irlanda':'DUB',
  'holanda':'AMS','paises baixos':'AMS','netherlands':'AMS',
  'suica':'ZRH','switzerland':'ZRH','austria':'VIE','hungria':'BUD','polonia':'WAW',
  'dinamarca':'CPH','suecia':'STO','noruega':'OSL','grecia':'ATH','turquia':'IST',
  'marrocos':'CMN','egito':'CAI','emirados arabes':'DXB','emirados':'DXB','uae':'DXB','qatar':'DOH','israel':'TLV',
  'japao':'TYO','coreia do sul':'SEL','china':'BJS','singapura pais':'SIN','tailandia':'BKK','indonesia':'CGK',
  'filipinas':'MNL','australia':'SYD','nova zelandia':'AKL',
  'canada':'YTO','mexico pais':'MEX','estados unidos':'NYC','eua':'NYC','usa':'NYC',
  'argentina':'BUE','chile':'SCL','uruguai':'MVD','peru':'LIM','colombia':'BOG','bolivia':'LPB','equador':'UIO',
};

// captura código IATA dentro do texto (ex.: "São Paulo, GRU")
function looksLikeIata(s = '') {
  const m = String(s).toUpperCase().match(/\b([A-Z]{3})\b/);
  return m ? m[1] : null;
}

// prefere código de cidade/área metropolitana quando existir
function preferCityCode(code='') {
  const up = String(code || '').toUpperCase();
  return AIRPORT_TO_CITY[up] || up;
}

// resolve termo -> código IATA (preferindo código de cidade)
async function resolveIataTerm(term) {
  if (!term) return null;

  // 1) Se já veio um código embutido (ex.: "São Paulo, GRU"), colapsa para cidade se houver
  const direct = looksLikeIata(term);
  if (direct) return preferCityCode(direct);

  // 2) Aliases locais (com normalização e variações simples)
  const raw = String(term);
  const byComma = raw.split(',')[0];
  const candidates = [
    raw, byComma,
    normalizeKey(raw), normalizeKey(byComma),
    normalizeKey(byComma).replace(/\b(brasil|brazil|portugal|espanha|italia|italy|franca|france)\b/g,'').trim()
  ].filter(Boolean);

  for (const c of candidates) {
    const k = normalizeKey(c);
    if (k && IATA_HINTS[k]) return IATA_HINTS[k];
  }

  // 3) Autocomplete (Travelpayouts) — colapsa para cidade quando houver
  try {
    const url = `https://autocomplete.travelpayouts.com/places2?term=${encodeURIComponent(byComma)}&locale=pt&types[]=city&types[]=airport`;
    log('IATA autocomplete →', { term: byComma, url: url.replace(/term=[^&]+/, 'term=***') });
    const r = await fetchWithTimeout(url, {}, 12000);
    const data = await safeJson(r);
    log('IATA autocomplete status', r.status, 'hits:', Array.isArray(data) ? data.length : 0);

    if (Array.isArray(data) && data.length) {
      const city = data.find(x => x.type === 'city' && x.code);
      if (city?.code) return String(city.code).toUpperCase();

      const ap = data.find(x => x.type === 'airport' && (x.city_code || x.code));
      if (ap?.city_code) return String(ap.city_code).toUpperCase();

      if (ap?.code) {
        const code = String(ap.code).toUpperCase();
        return preferCityCode(code);
      }
    }
  } catch (e) { log('IATA autocomplete erro', String(e)); }

  // 4) Falhou
  log('IATA fallback/unknown para', term);
  return null;
}

function minToHM(m){
  if (!Number.isFinite(m)) return null;
  const h = Math.floor(m/60), mm = Math.round(m%60);
  return `${h}h${mm? ` ${mm}m` : ''}`;
}
function joinDuration(d1, d2){
  const a = Number.isFinite(d1) ? `ida ${minToHM(d1)}` : '';
  const b = Number.isFinite(d2) ? `volta ${minToHM(d2)}` : '';
  return [a,b].filter(Boolean).join(' / ') || null;
}

/* ----------------------- FX helpers (com fallbacks) ----------------------- */
async function getFxBRLto(code, reqId) {
  const target = (code || '').toUpperCase();
  if (!target || target === 'BRL') {
    return { rate: 1, inverse: 1, date: fmtDate(new Date()), provider: 'none' };
  }

  // A) exchangerate.host
  try {
    console.time(`[${reqId}] fx_exchangerate_host`);
    const r = await fetchWithTimeout(
      `https://api.exchangerate.host/latest?base=BRL&symbols=${encodeURIComponent(target)}`,
      {}, 15000
    );
    const j = await safeJson(r);
    console.timeEnd(`[${reqId}] fx_exchangerate_host`);
    const rate = j?.rates?.[target];
    if (Number.isFinite(rate) && rate > 0) {
      return { rate, inverse: 1 / rate, date: j?.date ? fmtDate(new Date(j.date+'T00:00:00Z')) : fmtDate(new Date()), provider: 'exchangerate.host' };
    }
  } catch (e) { log(`[${reqId}] fx host err`, String(e)); }

  // B) frankfurter.app
  try {
    console.time(`[${reqId}] fx_frankfurter`);
    const r2 = await fetchWithTimeout(
      `https://api.frankfurter.app/latest?from=BRL&to=${encodeURIComponent(target)}`,
      {}, 15000
    );
    const j2 = await safeJson(r2);
    console.timeEnd(`[${reqId}] fx_frankfurter`);
    const rate2 = j2?.rates?.[target];
    if (Number.isFinite(rate2) && rate2 > 0) {
      return { rate: rate2, inverse: 1 / rate2, date: j2?.date ? fmtDate(new Date(j2.date+'T00:00:00Z')) : fmtDate(new Date()), provider: 'frankfurter.app' };
    }
  } catch (e) { log(`[${reqId}] fx frankfurter err`, String(e)); }

  // C) open.er-api.com
  try {
    console.time(`[${reqId}] fx_open_er_api`);
    const r3 = await fetchWithTimeout(`https://open.er-api.com/v6/latest/BRL`, {}, 15000);
    const j3 = await safeJson(r3);
    console.timeEnd(`[${reqId}] fx_open_er_api`);
    const rate3 = j3?.rates?.[target];
    if (Number.isFinite(rate3) && rate3 > 0) {
      return { rate: rate3, inverse: 1 / rate3, date: j3?.time_last_update_utc ? fmtDate(new Date(j3.time_last_update_utc)) : fmtDate(new Date()), provider: 'open.er-api.com' };
    }
  } catch (e) { log(`[${reqId}] fx open-er err`, String(e)); }

  return { rate: 0, inverse: 0, date: fmtDate(new Date()), provider: 'unavailable' };
}

/* ----------------------- helpers de moeda extra ----------------------- */

function fmtMoneyGeneric(v, code = 'USD') {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code }).format(v);
  } catch {
    const sym = CURRENCY_SYMBOLS[code] || code;
    return `${sym} ${fmtNumberBR(v)}`;
  }
}
function pairBRLWithLocal(brlValue, quoteCode, brlToQuote) {
  if (!Number.isFinite(brlValue)) return null;
  if (!quoteCode || quoteCode.toUpperCase() === 'BRL' || !Number.isFinite(brlToQuote) || brlToQuote <= 0) {
    return fmtMoneyBRL(brlValue);
  }
  const local = brlValue * brlToQuote;
  return `${fmtMoneyBRL(brlValue)} (~${fmtMoneyGeneric(local, quoteCode)})`;
}

/* ----------------------- Flights (Travelpayouts/Aviasales) ----------------------- */

function daysBetween(a, b) {
  try {
    const d1 = new Date(a + 'T00:00:00Z');
    const d2 = new Date(b + 'T00:00:00Z');
    return Math.round((d2 - d1) / 86400000);
  } catch { return 0; }
}

async function searchFlightsAviasales({ origin, destination, depart, ret, limit = 6, reqId, _forceFallback = false }) {
  const token = env('TRAVELPAYOUTS_TOKEN');
  if (!token) {
    log('TRAVELPAYOUTS_TOKEN ausente — pulando busca de passagens');
    return { error: 'TRAVELPAYOUTS_TOKEN não configurado. Cadastre-se no Travelpayouts (gratuito) e defina a variável no projeto.' };
  }

  const callApi = async ({ o, d, dep, retAt }) => {
    const qs = new URLSearchParams({
      origin: o,
      destination: d,
      departure_at: dep,
      ...(retAt ? { return_at: retAt } : {}),
      currency: 'BRL',
      sorting: 'price',
      limit: String(limit),
      unique: 'false'
    });
    const url = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${qs.toString()}`;
    log(`[${reqId}] Flights request`, { origin: o, destination: d, depart: dep, return_at: retAt || null, url });

    console.time(`[${reqId}] flights_api ${o}->${d} ${dep}${retAt ? ' + ' + retAt : ''}`);
    const r = await fetchWithTimeout(url, { headers: { 'X-Access-Token': token } }, 20000);
    const j = await safeJson(r);
    console.timeEnd(`[${reqId}] flights_api ${o}->${d} ${dep}${retAt ? ' + ' + retAt : ''}`);

    return { ok: r.ok, status: r.status, data: j, url };
  };

  const mapItems = (items, { o, d, dep, retAt }) => {
    const arr = Array.isArray(items) ? items : [];
    return arr.slice(0, limit).map(x => ({
      from: x.origin || o,
      to: x.destination || d,
      depart: x.depart_date || x.departure_at || dep,
      return: retAt ? (x.return_date || retAt) : null,
      airline: x.airline || null,
      stops: (typeof x.transfers === 'number') ? x.transfers : (x.stops ?? null),
      duration: joinDuration(x.duration_to, x.duration_back),
      price_number: Number.isFinite(+x.price) ? +x.price : null,
      price: x.price ? `R$ ${Math.round(x.price).toLocaleString('pt-BR')}` : null,
      currency: 'BRL',
      deep_link: x.link || null
    }));
  };

  // Se intervalo > 30 dias ou force fallback → consulta one-way (ida + volta separadas)
  const tooLong = (ret && depart) ? daysBetween(depart, ret) > 30 : false;
  if (_forceFallback || !ret || !depart || tooLong) {
    log(`[${reqId}] usando fallback one-way (ret=${ret}, depart=${depart}, tooLong=${tooLong}, force=${_forceFallback})`);

    const out = await callApi({ o: origin, d: destination, dep: depart, retAt: null });
    if (!out.ok) {
      logError(`[${reqId}] one-way OUT error`, out.status, safeTruncate(out.data?._raw || JSON.stringify(out.data)));
    } else {
      log(`[${reqId}] one-way OUT ok`, { count: Array.isArray(out.data?.data) ? out.data.data.length : 0 });
    }

    let back = null;
    if (ret) {
      back = await callApi({ o: destination, d: origin, dep: ret, retAt: null });
      if (!back.ok) {
        logError(`[${reqId}] one-way BACK error`, back.status, safeTruncate(back.data?._raw || JSON.stringify(back.data)));
      } else {
        log(`[${reqId}] one-way BACK ok`, { count: Array.isArray(back.data?.data) ? back.data.data.length : 0 });
      }
    }

    const items_outbound = out.ok ? mapItems(out.data?.data, { o: origin, d: destination, dep: depart, retAt: null }) : [];
    const items_return  = (back && back.ok) ? mapItems(back.data?.data, { o: destination, d: origin, dep: ret, retAt: null }) : [];

    // Combina top 3 x 3 como sugestão de ida+volta
    const combined = [];
    for (const a of items_outbound.slice(0, 3)) {
      for (const b of items_return.slice(0, 3)) {
        const tot = (a.price_number || 0) + (b.price_number || 0);
        combined.push({
          from: a.from, to: a.to,
          depart: a.depart, return: b.depart,
          airline: a.airline || b.airline || null,
          stops: (a.stops ?? 0) + (b.stops ?? 0),
          duration: [a.duration, b.duration].filter(Boolean).join(' / '),
          price_number: tot,
          price: `R$ ${Math.round(tot).toLocaleString('pt-BR')}`,
          currency: 'BRL',
          deep_link: null,
          _combo: { outbound: a, back: b }
        });
      }
    }
    combined.sort((x, y) => (x.price_number ?? 1e12) - (y.price_number ?? 1e12));

    return {
      provider: 'Travelpayouts',
      note: 'Viagem >30 dias ou sem volta: resultados de ida e volta listados separadamente. (Limite da API)',
      items_combined: combined.slice(0, limit),
      items_outbound,
      items_return
    };
  }

  // Round-trip normal (≤ 30 dias)
  const rt = await callApi({ o: origin, d: destination, dep: depart, retAt: ret });

  if (!rt.ok) {
    const msg = (rt.data?._raw || rt.data?.error || '').toString().toLowerCase();
    if (msg.includes('exceeds supported maximum of 30')) {
      log(`[${reqId}] round-trip 400 >30d detectado — fallback`);
      return await searchFlightsAviasales({ origin, destination, depart, ret, limit, reqId, _forceFallback: true });
    }
    logError(`[${reqId}] Flights error status`, rt.status, safeTruncate(rt.data?._raw || JSON.stringify(rt.data)));
    return { error: rt.data?.message || rt.data?._raw || 'Erro na API Travelpayouts', _raw: rt.data, status: rt.status };
  }

  const items = mapItems(rt.data?.data, { o: origin, d: destination, dep: depart, retAt: ret });
  log(`[${reqId}] Flights OK`, { count: items.length, sample: items[0] || null });

  return { items, provider: 'Travelpayouts', _raw: rt.data };
}

/* ----------------------- handler ----------------------- */

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader('x-request-id', reqId);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed', reqId });
  }

  // 🔑 OpenAI
  const OPENAI_API_KEY = env('OPENAI_API_KEY');
  const OPENAI_API_BASE = env('OPENAI_API_BASE', 'https://api.openai.com/v1');
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no projeto (Vercel).', reqId });
  }

  // ✉️ E-mail (opcional)
  const SENDGRID_API_KEY = env('SENDGRID_API_KEY');
  const MAIL_FROM = env('MAIL_FROM');
  const BRAND_NAME = env('BRAND_NAME', 'Touristando IA');
  const LOGO_URL = env('LOGO_URL');
  if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

  try {
    // Body
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    if (!Object.keys(body).length && req.headers['content-type']?.includes('application/json')) {
      try {
        const chunks = []; for await (const ch of req) chunks.push(ch);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      } catch { body = {}; }
    }

    // log de entrada (parcial)
    const dbgIn = (() => {
      const clone = { ...body };
      if (clone.emailDestino) clone.emailDestino = maskEmail(String(clone.emailDestino));
      return clone;
    })();
    log(`[${reqId}] Incoming payload`, dbgIn);

    const destinoEntrada =
      body.destino?.toString().trim() ||
      body.pais?.toString().trim() ||
      body.estado?.toString().trim() ||
      body.cidade?.toString().trim();

    // datas + origem (para passagens)
    const dataIda = (body.data_ida || '').toString().slice(0,10);
    const dataVolta = (body.data_volta || '').toString().slice(0,10);
    const origemEntrada = (body.origem || '').toString().trim() || null;

    const dias = Number(body.dias ?? 5);
    const pessoas = Math.max(1, Number(body.pessoas ?? 1));
    const perfil = (body.perfil || 'normal').toString();
    const estilo = (body.estilo || 'casual').toString();
    const emailDestino = (body.emailDestino || '').toString().trim() || null;

    // orçamentos (robusto)
    let orcamento = parseBudgetBR(body.orcamento);
    let orcamentoPorPessoa = parseBudgetBR(body.orcamento_por_pessoa);

    let orcTotal = null;
    let orcPerPerson = null;

    if (orcamento && orcamentoPorPessoa) {
      const fromPP = orcamentoPorPessoa * Math.max(1, pessoas);
      if (almostEqual(orcamento, fromPP * 10)) {
        orcamento = fromPP; // corrigia 110.000 -> 11.000
      } else if (almostEqual(fromPP, orcamento * 10)) {
        orcamentoPorPessoa = orcamento / Math.max(1, pessoas);
      }
      orcTotal = orcamento;
      orcPerPerson = orcTotal && pessoas ? (orcTotal / pessoas) : orcamentoPorPessoa;
    } else if (orcamento) {
      orcTotal = orcamento;
      orcPerPerson = pessoas ? (orcTotal / pessoas) : null;
    } else if (orcamentoPorPessoa) {
      orcPerPerson = orcamentoPorPessoa;
      orcTotal = pessoas ? (orcPerPerson * pessoas) : null;
    }

    if (!destinoEntrada) return res.status(400).json({ error: 'Informe o destino (país/estado/cidade) no campo "destino" (ou "pais").', reqId });
    if (!Number.isFinite(dias) || dias <= 0) return res.status(400).json({ error: 'O campo "dias" deve ser um número > 0.', reqId });

    /* ---------- 1) Normalizar destino + moeda (Chat Completions JSON) ---------- */
    const classifyMsg = [
      { role: 'system', content:
`Você extrai metadados geográficos e de moeda. Responda SOMENTE com JSON válido.
Campos:
- normalized_name (string)
- region_type ("country"|"state"|"city"|"region")
- country_name (string)
- country_code (string)
- currency_code (string)
- currency_name (string)` },
      { role: 'user', content: `Destino: ${destinoEntrada}` }
    ];

    console.time(`[${reqId}] openai_classify`);
    const classifyResp = await fetchWithTimeout(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.0, response_format: { type: 'json_object' }, messages: classifyMsg })
    }, 25000);
    console.timeEnd(`[${reqId}] openai_classify`);

    if (!classifyResp.ok) {
      const errTxt = await classifyResp.text();
      logError(`[${reqId}] classify error`, classifyResp.status, safeTruncate(errTxt));
      return res.status(classifyResp.status).json({ error: 'Falha ao classificar destino', raw: safeTruncate(errTxt), reqId });
    }
    const clsData = await safeJson(classifyResp);
    const meta = (() => {
      try {
        const m = clsData?.choices?.[0]?.message?.content
          ? JSON.parse(clsData.choices[0].message.content) : clsData;
        return {
          normalized_name: m.normalized_name || destinoEntrada,
          region_type: m.region_type || 'region',
          country_name: m.country_name || '',
          country_code: m.country_code || '',
          currency_code: (m.currency_code || 'USD').toUpperCase(),
          currency_name: m.currency_name || ''
        };
      } catch {
        return {
          normalized_name: destinoEntrada, region_type: 'region', country_name: '', country_code: '',
          currency_code: 'USD', currency_name: 'Dólar'
        };
      }
    })();
    log(`[${reqId}] meta`, meta);

    /* ---------- 2) Câmbio (com fallbacks) ---------- */
    const fxFetch = await getFxBRLto(meta.currency_code, reqId);
    let fx = {
      base: 'BRL',
      quote: meta.currency_code || 'USD',
      brl_to_quote: fxFetch.rate || 0,
      quote_to_brl: fxFetch.inverse || 0,
      date: fxFetch.date,
      provider: fxFetch.provider
    };
    log(`[${reqId}] fx`, fx);

    const faixa = (() => {
      const partes = [];
      partes.push(`Grupo: ${pessoas} pessoa(s).`);
      if (orcTotal && orcTotal > 0) partes.push(`Orçamento total: ${fmtMoneyBRL(orcTotal)}.`);
      if (orcPerPerson && orcPerPerson > 0) partes.push(`≈ ${fmtMoneyBRL(orcPerPerson)} por pessoa.`);
      if (!partes.length) partes.push('Sem orçamento declarado; use faixas típicas do destino.');
      return partes.join(' ');
    })();

    /* ---------- 3) Prompt principal (1–7) ---------- */
    const destinoLabel =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}, ${meta.country_name}`
        : (meta.normalized_name || destinoEntrada);

    const convHeader =
      (fx.quote !== 'BRL' && fx.brl_to_quote)
        ? `1 BRL = ${fx.brl_to_quote.toFixed(4)} ${fx.quote}  (1 ${fx.quote} ≈ R$ ${fmtNumberBR(fx.quote_to_brl)}) — ${fx.date}`
        : `1 BRL = 1 BRL (sem conversão)`;

    const tableStyle = `style="width:100%;border-collapse:collapse;margin:8px 0;font-size:.98rem"`;
    const thStyle = `style="text-align:left;padding:8px 10px;border:1px solid #2a3358;background:#0e1429;color:#fff"`;

    const mainPrompt =
`Você é um planner de viagens sênior.
Responda APENAS com HTML válido (fragmento), em PT-BR, sem Markdown, sem <script> e sem <style>.
Use BUSCA NA WEB quando necessário para trazer lugares reais e atualizados.
Inclua uma seção final <section><h2>Fontes consultadas</h2><ul>...</ul></section> com links (máx. 12, domínios confiáveis).

<section>
  <h2>1. Visão Geral</h2>
  <p>Explique cidade-base e 1–2 alternativas, época/clima, segurança e deslocamento.</p>
</section>

<section>
  <h2>2. Atrações Imperdíveis</h2>
  <ul>
    <!-- 10–18 itens **somente atrações** (NÃO listar restaurantes/bares): nome, bairro/zona, breve descrição, tempo médio, melhor horário;
         faixa de preço (BRL + ${meta.currency_code}). <small>Fonte: <a href="...">domínio</a></small>. -->
  </ul>
</section>

<section>
  <h2>3. Onde comer & beber</h2>
  <ul>
    <!-- 8–14 lugares com estilo/cozinha, bairro/zona, ticket médio por pessoa (BRL + ${meta.currency_code}) e <small>Fonte...</small>. -->
  </ul>
</section>

<section>
  <h2>4. Hospedagem Recomendada</h2>
  <ul>
    <!-- 6–10 hotéis/pousadas OU bairros com exemplos; categoria (econômico/médio/superior), diária média (BRL + ${meta.currency_code}); <small>Fonte...</small>. -->
  </ul>
</section>

<section>
  <h2>5. Transporte Local</h2>
  <ul>
    <!-- metrô/ônibus/app/táxi/passe/trem; preços por trecho/diária; trajetos aeroporto↔centro; <small>Fonte...</small>. -->
  </ul>
</section>

<section>
  <h2>6. Roteiro Dia a Dia</h2>
  <!-- Para D1..D${dias}, gere a estrutura:
       <h3>Dia X</h3>

       <h4>Atrações do dia (refeições NÃO contam)</h4>
       <ul class="day-plan">
         // Liste **no mínimo 5** e preferencialmente **6–7** itens com data-type="attraction".
         // Cada item deve trazer:
         // • faixa de horário (ex.: 08:30–10:00, 10:15–12:00, 14:00–16:00... cobrindo ~12h úteis no total);
         // • nome do lugar/experiência + bairro/zona;
         // • dica prática/por que vale a pena;
         // • preço por pessoa quando pago, no formato "R$ 120 (~${meta.currency_code} 21,60)" (se grátis, escrever "Grátis");
         // • <small>Fonte: <a href="...">domínio</a></small>.
       </ul>

       <h4>Pausas para refeições (não contam como atração)</h4>
       <ul class="meals">
         // Liste 2–3 refeições com data-type="meal": Almoço, Jantar (e opcional Café/Lanche).
         // Cada item deve trazer horário, nome do restaurante/bar, bairro, estilo/cozinha e **ticket médio por pessoa** (BRL + ${meta.currency_code}).
       </ul>

       <h5>Resumo de custos do dia</h5>
       <table ${tableStyle}>
         <thead>
           <tr><th ${thStyle}>Categoria</th><th ${thStyle}>Por pessoa (R$ / ${meta.currency_code})</th><th ${thStyle}>Grupo ${pessoas} (R$ / ${meta.currency_code})</th></tr>
         </thead>
         <tbody></tbody>
       </table>
  -->
</section>

<section>
  <h2>7. Orçamento Resumido</h2>
  <h3>Tabela 1 — Custos por dia (faixas)</h3>
  <table ${tableStyle}>
    <thead>
      <tr>
        <th ${thStyle}>Item</th>
        <th ${thStyle}>Subtotal/Dia</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <h3>Tabela 2 — Quadro-resumo do grupo</h3>
  <table ${tableStyle}>
    <thead><tr><th ${thStyle}>Métrica</th><th ${thStyle}>Valor</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Fontes consultadas</h2>
  <ul><!-- até 12 links --></ul>
</section>

Regras IMPORTANTES:
- **Refeições não contam** para o mínimo de atividades. O mínimo (≥5) é apenas de <li data-type="attraction"> por dia.
- Sempre mostre valores em BRL e ${meta.currency_code}. Formato: "R$ 120 (~${meta.currency_code} 21,60)".
- Conversões: BRL→${meta.currency_code} = valor_BR * ${fx.brl_to_quote || 0}; ${meta.currency_code}→BRL = valor_LOC * ${fx.quote_to_brl || 0}.
- Se a moeda local for BRL, use apenas R$.

Contexto:
- Destino: ${destinoLabel}
- Dias: ${dias}
- Pessoas: ${pessoas}
- Perfil: ${perfil}
- Estilo: ${estilo}
- Brief: ${faixa}
- Conversão de referência: ${convHeader}
- País: ${meta.country_name || '(não identificado)'}
`;

    /* ---------- 4) Geração com Responses API + web_search (fallbacks) ---------- */
    async function generateHtmlWithSearch(inputText) {
      // tentativa A — Responses API com web_search
      try {
        console.time(`[${reqId}] openai_responses_search`);
        const resp = await fetchWithTimeout(`${OPENAI_API_BASE}/responses`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            input: inputText,
            tools: [{ type: 'web_search' }],
            tool_choice: 'auto'
          })
        }, 90000);
        console.timeEnd(`[${reqId}] openai_responses_search`);

        if (resp.ok) {
          const dataOk = await safeJson(resp);
          const html = extractResponsesText(dataOk).trim();
          log(`[${reqId}] responses+search ok html_len=${html.length}`);
          return { html, usedSearch: true, raw: dataOk };
        } else {
          const errTxt = await resp.text();
          logError(`[${reqId}] responses+search error`, resp.status, safeTruncate(errTxt));
        }
      } catch (e) {
        logError(`[${reqId}] responses+search exception`, String(e));
      }

      // tentativa B — Responses sem web_search
      try {
        console.time(`[${reqId}] openai_responses_plain`);
        const respNoSearch = await fetchWithTimeout(`${OPENAI_API_BASE}/responses`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', input: inputText })
        }, 90000);
        console.timeEnd(`[${reqId}] openai_responses_plain`);

        if (respNoSearch.ok) {
          const dataNo = await safeJson(respNoSearch);
          const html = extractResponsesText(dataNo).trim();
          log(`[${reqId}] responses(no-search) ok html_len=${html.length}`);
          return { html, usedSearch: false, raw: dataNo };
        } else {
          const errTxt = await respNoSearch.text();
          logError(`[${reqId}] responses(no-search) error`, respNoSearch.status, safeTruncate(errTxt));
        }
      } catch (e) {
        logError(`[${reqId}] responses(no-search) exception`, String(e));
      }

      // tentativa C — Chat Completions
      console.time(`[${reqId}] openai_chat_fallback`);
      const cc = await fetchWithTimeout(`${OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.7, messages: [
          { role:'system', content:'Você é um travel planner sênior. Responda APENAS com HTML válido (fragmento), em PT-BR, sem Markdown.' },
          { role:'user', content: inputText }
        ]})
      }, 90000);
      console.timeEnd(`[${reqId}] openai_chat_fallback`);

      const ccData = await safeJson(cc);
      if (!cc.ok) {
        logError(`[${reqId}] chat fallback error`, cc.status, safeTruncate(ccData?._raw || JSON.stringify(ccData)));
        throw new Error(ccData?.error?.message || ccData?._raw || 'Falha na OpenAI');
      }
      const html = (ccData?.choices?.[0]?.message?.content || '').trim();
      log(`[${reqId}] chat fallback ok html_len=${html.length}`);
      return { html, usedSearch: false, raw: ccData };
    }

    const gen = await generateHtmlWithSearch(mainPrompt);

    // Se a IA devolveu <div class="trip-plan">, evita aninhar
    const innerMatch = gen.html.match(/<div[^>]*class=["'][^"']*trip-plan[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const aiInner = innerMatch ? innerMatch[1] : gen.html;

    /* ---------- 5) Seção 0: Resumo (determinística) ---------- */
    const tableStyleInline = 'style="width:100%;border-collapse:collapse;margin:8px 0;font-size:.98rem"';
    const thStyleInline = 'style="text-align:left;padding:8px 10px;border:1px solid #2a3358;background:#0e1429;color:#fff"';
    const tdStyleInline = 'style="padding:8px 10px;border:1px solid #2a3358;color:#fff"';

    const resumoRows = [];
    resumoRows.push(`<tr><th ${thStyleInline}>Campo</th><th ${thStyleInline}>Valor</th></tr>`);
    const pushRow = (k,v) => resumoRows.push(`<tr><td ${tdStyleInline}>${escapeHtml(k)}</td><td ${tdStyleInline}>${escapeHtml(v)}</td></tr>`);

    const destinoLabelOut =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}` : (meta.normalized_name || destinoEntrada);

    pushRow('Destino', destinoLabelOut);
    if (meta.country_name) pushRow('País', meta.country_name);
    pushRow('Tipo de região', regionLabelPT(meta.region_type));
    pushRow('Dias', String(dias));
    pushRow('Pessoas', String(pessoas));
    pushRow('Perfil', perfil.charAt(0).toUpperCase()+perfil.slice(1));
    pushRow('Estilo', estilo.charAt(0).toUpperCase()+estilo.slice(1));
    if (orcTotal && orcTotal>0) pushRow('Orçamento total', pairBRLWithLocal(orcTotal, meta.currency_code, fx.brl_to_quote));
    if (orcPerPerson && orcPerPerson>0) pushRow('Orçamento por pessoa', pairBRLWithLocal(orcPerPerson, meta.currency_code, fx.brl_to_quote));
    pushRow('Moeda local', currencyLabel(meta.currency_code, meta.currency_name));
    pushRow('Taxa utilizada', `(${reqId}) ${convHeader} [${fx.provider}]`);
    if (gen.usedSearch) pushRow('Pesquisa na web', 'Ativada (Responses API)');

    const section0 = `
<section>
  <h2>0. Resumo do Planejamento</h2>
  <table ${tableStyleInline}>
    <thead>${resumoRows.shift()}</thead>
    <tbody>${resumoRows.join('')}</tbody>
  </table>
</section>`.trim();

    // Fragmento final
    const finalHtmlFragment = `
<div class="trip-plan" data-render="roteiro">
  ${section0}
  ${aiInner}
</div>`.trim();

    const destinoLabelFull =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}, ${meta.country_name}`
        : (meta.normalized_name || destinoEntrada);

    /* ---------- 5.1) Passagens aéreas (com fallback + IATA robusto) ---------- */
    let flights = null;
    try {
      if (dataIda && dataVolta && origemEntrada) {
        // origem — tenta IATA direto, depois converte para "city code" se aplicável
        const originRaw = await resolveIataTerm(origemEntrada);
        const originIata = originRaw ? preferCityCode(originRaw) : null;

        // destino — tenta várias combinações (ex.: "Maragogi" → MCZ via hints)
        const tryTerms = [
          destinoEntrada,
          meta.normalized_name,
          meta.country_name ? `${meta.normalized_name}, ${meta.country_name}` : null,
        ].filter(Boolean);

        let destIata = null;
        for (const t of tryTerms) {
          const r = await resolveIataTerm(t);
          if (r) { destIata = preferCityCode(r); break; }
        }

        log(`[${reqId}] IATA resolved`, { origemEntrada, originIata, destinoEntrada, destIata });

        if (originIata && destIata) {
          const f = await searchFlightsAviasales({
            origin: originIata,
            destination: destIata,
            depart: dataIda,
            ret: dataVolta,
            limit: 6,
            reqId
          });
          flights = f;
        } else {
          flights = { error: 'Não foi possível resolver IATA de origem ou destino.' };
        }
      } else {
        log(`[${reqId}] flights skipped — faltam origem/data_ida/data_volta`);
        flights = null; // origem/datas ausentes: não buscar
      }
    } catch (e) {
      logError(`[${reqId}] flights exception`, String(e));
      flights = { error: 'Falha ao buscar passagens', detail: String(e) };
    }

    const payloadOut = {
      ok: true,
      texto: finalHtmlFragment,
      meta: {
        destino: destinoLabelFull,
        region_type: meta.region_type,
        country: meta.country_name || null,
        currency_code: meta.currency_code,
        currency_name: meta.currency_name || null,
        pessoas,
        dias,
        estilo,
        perfil,
        orcamento: orcTotal,
        orcamento_por_pessoa: orcPerPerson,
        data_ida: dataIda || null,
        data_volta: dataVolta || null,
        origem: origemEntrada || null,
        fx: {
          brl_to_local: fx.brl_to_quote,
          local_to_brl: fx.quote_to_brl,
          date: fx.date,
          provider: fx.provider
        }
      },
      // Flights (para o front)
      flights: flights || undefined,
      passagens: flights || undefined, // alias
      render_as: 'html',
      reqId
    };

    /* ---------- 6) E-mail (opcional) ---------- */
    const emailResumoTabela = (() => {
      const row = (k, v) => `
        <tr>
          <td style="padding:8px 10px;border:1px solid #eceff4;background:#f8fafc;color:#111;font-weight:600;width:40%">${escapeHtml(k)}</td>
          <td style="padding:8px 10px;border:1px solid #eceff4;color:#111">${escapeHtml(v)}</td>
        </tr>`;
      const rows = [];
      rows.push(row('Destino', destinoLabelFull));
      rows.push(row('Dias', String(dias)));
      rows.push(row('Pessoas', String(pessoas)));
      rows.push(row('Perfil', perfil));
      rows.push(row('Estilo', estilo));
      rows.push(row('Moeda local', currencyLabel(meta.currency_code, meta.currency_name)));
      rows.push(row('Taxa usada', convHeader + ` [${fx.provider}]`));
      if (dataIda) rows.push(row('Ida', dataIda));
      if (dataVolta) rows.push(row('Volta', dataVolta));
      if (origemEntrada) rows.push(row('Origem', origemEntrada));
      if (orcTotal && orcTotal > 0) rows.push(row('Orçamento total', pairBRLWithLocal(orcTotal, meta.currency_code, fx.brl_to_quote)));
      if (orcPerPerson && orcPerPerson > 0) rows.push(row('Orçamento por pessoa', pairBRLWithLocal(orcPerPerson, meta.currency_code, fx.brl_to_quote)));
      if (gen.usedSearch) rows.push(row('Pesquisa na web', 'Ativada (Responses API)'));
      return `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eaeaea;border-radius:8px;overflow:hidden">
          ${rows.join('')}
        </table>`;
    })();

    if (emailDestino && SENDGRID_API_KEY && MAIL_FROM) {
      const assunto = `Roteiro • ${destinoLabelFull} • ${BRAND_NAME}`;
      const html = `
<div style="font-family:Arial,Helvetica,sans-serif;padding:24px;background:#f6f9fc">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #eaeaea;border-radius:12px;overflow:hidden">
    <tr>
      <td style="background:#0d6efd;color:#fff;padding:16px 20px">
        ${LOGO_URL ? `<img src="${LOGO_URL}" alt="${BRAND_NAME}" height="28" style="vertical-align:middle;border-radius:6px;background:#fff;padding:3px;margin-right:8px">` : ''}
        <strong style="font-size:16px;vertical-align:middle">${BRAND_NAME}</strong>
      </td>
    </tr>
    <tr><td style="padding:18px 20px">
      <h2 style="margin:0 0 10px 0;font-size:18px;color:#111">Resumo do planejamento</h2>
      ${emailResumoTabela}
      <div style="height:14px"></div>
      <h2 style="margin:0 0 6px 0;font-size:18px;color:#111">Roteiro: ${escapeHtml(destinoLabelFull)}</h2>
      <div>
        ${finalHtmlFragment}
      </div>
      <p style="color:#667085;font-size:12px;margin-top:14px">Gerado automaticamente por ${BRAND_NAME}. Valores são estimativas e podem variar conforme data e disponibilidade.</p>
    </td></tr>
  </table>
</div>`.trim();

      try {
        console.time(`[${reqId}] sendgrid`);
        await sgMail.send({ to: emailDestino, from: MAIL_FROM, subject: assunto, text: 'Veja seu roteiro em HTML.', html });
        console.timeEnd(`[${reqId}] sendgrid`);
        log(`[${reqId}] email enviado para`, maskEmail(emailDestino));
        payloadOut.email = { enviado: true, para: emailDestino };
      } catch (e) {
        logError(`[${reqId}] email erro`, e?.response?.body || String(e));
        payloadOut.email = { enviado: false, erro: e?.response?.body || String(e) };
      }
    } else {
      log(`[${reqId}] email skip`, { hasKey: !!SENDGRID_API_KEY, hasFrom: !!MAIL_FROM, hasDest: !!emailDestino });
    }

    res.setHeader('Cache-Control', 'no-store');
    log(`[${reqId}] responding 200 ok`);
    return res.status(200).json(payloadOut);
  } catch (err) {
    logError('Erro /api/roteiro:', err);
    return res.status(500).json({ error: 'Falha interna.', reqId });
  }
}
