// /api/roteiro.js
export const config = { runtime: 'nodejs' }; // Serverless Node.js (Vercel)

import sgMail from '@sendgrid/mail';

/* ----------------------- utils ----------------------- */

const escapeHtml = (s = '') =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function env(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

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

// mapa simples de símbolos (cobre os mais comuns)
const CURRENCY_SYMBOLS = {
  BRL:'R$', USD:'$', EUR:'€', GBP:'£', JPY:'¥', CNY:'¥', HKD:'$', TWD:'$', SGD:'$', CAD:'$', AUD:'$', NZD:'$',
  MXN:'$', ARS:'$', CLP:'$', COP:'$', PEN:'S/', UYU:'$U', BOB:'Bs', PYG:'₲', UYU2:'$', ZAR:'R',
  CHF:'CHF', DKK:'kr', NOK:'kr', SEK:'kr', PLN:'zł', CZK:'Kč', HUF:'Ft', RON:'lei',
  TRY:'₺', ILS:'₪', AED:'د.إ', SAR:'﷼', QAR:'﷼', KWD:'KD', BHD:'BD', INR:'₹', THB:'฿', KRW:'₩', IDR:'Rp', MYR:'RM', PHP:'₱'
};
const currencyLabel = (code = 'BRL', name = '') => {
  const sym = CURRENCY_SYMBOLS[code] || '';
  return `${code}${name ? ` — ${name}` : ''}${sym ? ` — símbolo: ${sym}` : ''}`;
};

/* ----------------------- handler ----------------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 🔑 OpenAI
  const OPENAI_API_KEY = env('OPENAI_API_KEY');
  const OPENAI_API_BASE = env('OPENAI_API_BASE', 'https://api.openai.com/v1');
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no projeto (Vercel).' });
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

    const destinoEntrada =
      body.destino?.toString().trim() ||
      body.pais?.toString().trim() ||
      body.estado?.toString().trim() ||
      body.cidade?.toString().trim();

    const dias = Number(body.dias ?? 5);
    const pessoas = Math.max(1, Number(body.pessoas ?? 1));
    const perfil = (body.perfil || 'normal').toString();
    const estilo = (body.estilo || 'casual').toString();
    const emailDestino = (body.emailDestino || '').toString().trim() || null;

    const orcamento = (body.orcamento !== undefined && body.orcamento !== null && body.orcamento !== '')
      ? Number(body.orcamento) : null;
    const orcamentoPorPessoa = (body.orcamento_por_pessoa !== undefined && body.orcamento_por_pessoa !== null && body.orcamento_por_pessoa !== '')
      ? Number(body.orcamento_por_pessoa) : null;

    const orcTotal = (orcamento && orcamento > 0)
      ? orcamento
      : (orcamentoPorPessoa && pessoas > 0 ? orcamentoPorPessoa * pessoas : null);

    const orcPerPerson = (orcamentoPorPessoa && orcamentoPorPessoa > 0)
      ? orcamentoPorPessoa
      : (orcTotal && pessoas > 0 ? orcTotal / pessoas : null);

    if (!destinoEntrada) return res.status(400).json({ error: 'Informe o destino (país/estado/cidade) no campo "destino" (ou "pais").' });
    if (!Number.isFinite(dias) || dias <= 0) return res.status(400).json({ error: 'O campo "dias" deve ser um número > 0.' });

    /* ---------- 1) Normalizar destino + moeda ---------- */
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

    const classifyResp = await fetchWithTimeout(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.0, response_format: { type: 'json_object' }, messages: classifyMsg })
    }, 25000);

    if (!classifyResp.ok) {
      const errTxt = await classifyResp.text();
      return res.status(classifyResp.status).json({ error: 'Falha ao classificar destino', raw: errTxt });
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

    /* ---------- 2) Câmbio ---------- */
    let fx = {
      base: 'BRL',
      quote: meta.currency_code || 'USD',
      brl_to_quote: 0,
      quote_to_brl: 0,
      date: fmtDate(new Date())
    };

    try {
      if ((meta.currency_code || 'BRL').toUpperCase() === 'BRL') {
        fx.brl_to_quote = 1;
        fx.quote_to_brl = 1;
      } else {
        const r = await fetchWithTimeout(
          `https://api.exchangerate.host/latest?base=BRL&symbols=${encodeURIComponent(meta.currency_code)}`,
          {}, 15000
        );
        const j = await safeJson(r);
        const rate = j?.rates?.[meta.currency_code] || 0;
        fx.brl_to_quote = rate;
        fx.quote_to_brl = rate ? (1 / rate) : 0;
        if (j?.date) fx.date = fmtDate(new Date(j.date + 'T00:00:00Z'));
      }
    } catch { /* mantém zeros e usamos só BRL */ }

    const faixa = (() => {
      const partes = [];
      partes.push(`Grupo: ${pessoas} pessoa(s).`);
      if (orcTotal && orcTotal > 0) partes.push(`Orçamento total: ${fmtMoneyBRL(orcTotal)}.`);
      if (orcPerPerson && orcPerPerson > 0) partes.push(`≈ ${fmtMoneyBRL(orcPerPerson)} por pessoa.`);
      if (!partes.length) partes.push('Sem orçamento declarado; use faixas típicas do destino.');
      return partes.join(' ');
    })();

    /* ---------- 3) Prompt principal (seções 1–7) ---------- */
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

    // IMPORTANTE: pedimos somente as seções 1–7; o Resumo (0) será montado pelo backend
    const mainPrompt =
`Você é um planner de viagens sênior.
Responda APENAS com HTML válido (fragmento), em PT-BR, sem Markdown, sem <script> e sem <style>.
Se possível, envolva tudo em <div class="trip-plan" data-render="roteiro">…</div>.

Gere SOMENTE as seções abaixo (NÃO gere "0. Resumo do Planejamento", pois ele será inserido pelo sistema):

<section>
  <h2>1. Visão Geral</h2>
  <p>Explique cidade-base e 1–2 alternativas, época/clima, segurança e deslocamento.</p>
</section>

<section>
  <h2>2. Atrações Imperdíveis</h2>
  <ul>
    <!-- 8–15 itens: nome, bairro/zona, breve descrição, tempo médio, faixa de preço (BRL + ${meta.currency_code}) -->
  </ul>
</section>

<section>
  <h2>3. Hospedagem Recomendada</h2>
  <ul>
    <!-- 6–10 itens: bairro/zona, categoria (econômico/médio/superior) e diária média (BRL + ${meta.currency_code}); sem links/telefones -->
  </ul>
</section>

<section>
  <h2>4. Transporte Local</h2>
  <ul>
    <!-- metrô/ônibus/app/táxi/passe/trem; faixas de preço por trecho/diária; trajetos típicos aeroporto↔centro etc. -->
  </ul>
</section>

<section>
  <h2>5. Roteiro Dia a Dia</h2>
  <!-- Para D1..D${dias}, gerar <h3>Dia X</h3> com 2–4 atividades (manhã/tarde/noite); custos quando pagos (BRL + ${meta.currency_code}). -->
</section>

<section>
  <h2>6. Orçamento Resumido</h2>
  <h3>Tabela 1 — Custos por dia (faixas)</h3>
  <table ${tableStyle}>
    <thead>
      <tr>
        <th ${thStyle}>Item</th>
        <!-- gerar cabeçalhos Dia 1..Dia ${dias} -->
        <th ${thStyle}>Subtotal/Dia</th>
      </tr>
    </thead>
    <tbody><!-- Hospedagem / Alimentação / Transporte / Atrações --></tbody>
  </table>

  <h3>Tabela 2 — Quadro-resumo do grupo</h3>
  <table ${tableStyle}>
    <thead><tr><th ${thStyle}>Métrica</th><th ${thStyle}>Valor</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>7. Dicas Rápidas</h2>
  <ul>
    <!-- etiqueta local, chip/eSIM, gorjetas, tomada/voltagem, apps úteis, bairros a evitar à noite (se aplicável) -->
  </ul>
</section>

Regras de moeda:
- Sempre mostre valores em BRL e ${meta.currency_code}.
- Formato: "R$ 120 (~${meta.currency_code} 21,60)".
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

    const messages = [
      { role: 'system', content: 'Você é um travel planner sênior. Responda APENAS com HTML válido (fragmento), em PT-BR, sem Markdown.' },
      { role: 'user', content: mainPrompt }
    ];

    /* ---------- 4) Chamada OpenAI ---------- */
    const aiResp = await fetchWithTimeout(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.7, messages })
    }, 60000);

    const aiData = await safeJson(aiResp);
    if (!aiResp.ok) {
      return res.status(aiResp.status).json({ error: aiData?.error?.message || aiData?._raw || 'Falha na OpenAI' });
    }

    // Conteúdo retornado pela IA
    const aiHtml = (aiData?.choices?.[0]?.message?.content || '').trim();

    // Se a IA incluiu <div class="trip-plan">, extraímos o miolo para evitar aninhamento duplo
    const innerMatch = aiHtml.match(/<div[^>]*class=["'][^"']*trip-plan[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const aiInner = innerMatch ? innerMatch[1] : aiHtml;

    // Montamos a Seção 0 de forma determinística (com campos completos)
    const tableStyleInline = 'style="width:100%;border-collapse:collapse;margin:8px 0;font-size:.98rem"';
    const thStyleInline = 'style="text-align:left;padding:8px 10px;border:1px solid #2a3358;background:#0e1429;color:#fff"';
    const tdStyleInline = 'style="padding:8px 10px;border:1px solid #2a3358;color:#fff"';

    const resumoRows = [];
    resumoRows.push(`<tr><th ${thStyleInline}>Campo</th><th ${thStyleInline}>Valor</th></tr>`);
    const pushRow = (k,v) => resumoRows.push(`<tr><td ${tdStyleInline}>${escapeHtml(k)}</td><td ${tdStyleInline}>${escapeHtml(v)}</td></tr>`);

    const destinoLabelOut =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}`
        : (meta.normalized_name || destinoEntrada);

    pushRow('Destino', destinoLabelOut);
    if (meta.country_name) pushRow('País', meta.country_name);
    pushRow('Tipo de região', meta.region_type);
    pushRow('Dias', String(dias));
    pushRow('Pessoas', String(pessoas));
    pushRow('Perfil', perfil.charAt(0).toUpperCase()+perfil.slice(1));
    pushRow('Estilo', estilo.charAt(0).toUpperCase()+estilo.slice(1));
    if (orcTotal && orcTotal>0) pushRow('Orçamento total', fmtMoneyBRL(orcTotal));
    if (orcPerPerson && orcPerPerson>0) pushRow('Orçamento por pessoa', fmtMoneyBRL(orcPerPerson));
    pushRow('Moeda local', currencyLabel(meta.currency_code, meta.currency_name));
    pushRow('Taxa utilizada', convHeader);

    const section0 = `
<section>
  <h2>0. Resumo do Planejamento</h2>
  <table ${tableStyleInline}>
    <thead>${resumoRows.shift()}</thead>
    <tbody>${resumoRows.join('')}</tbody>
  </table>
</section>`.trim();

    // Fragmento final único
    const finalHtmlFragment = `
<div class="trip-plan" data-render="roteiro">
  ${section0}
  ${aiInner}
</div>`.trim();

    const destinoLabelFull =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}, ${meta.country_name}`
        : (meta.normalized_name || destinoEntrada);

    const payloadOut = {
      ok: true,
      texto: finalHtmlFragment,          // agora sempre HTML completo e bonito
      meta: {
        destino: destinoLabelFull,
        region_type: meta.region_type,
        country: meta.country_name || null,
        currency_code: meta.currency_code,
        currency_name: meta.currency_name || null,
        pessoas,
        dias,
        orcamento: orcTotal,
        orcamento_por_pessoa: orcPerPerson,
        estilo,
        perfil,
        fx: {
          brl_to_local: fx.brl_to_quote,
          local_to_brl: fx.quote_to_brl,
          date: fx.date
        }
      },
      render_as: 'html'
    };

    /* ---------- 5) E-mail (opcional) ---------- */
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
      rows.push(row('Taxa usada', convHeader));
      if (orcTotal && orcTotal > 0) rows.push(row('Orçamento total', fmtMoneyBRL(orcTotal)));
      if (orcPerPerson && orcPerPerson > 0) rows.push(row('Orçamento por pessoa', fmtMoneyBRL(orcPerPerson)));
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
        await sgMail.send({ to: emailDestino, from: MAIL_FROM, subject: assunto, text: 'Veja seu roteiro em HTML.', html });
        payloadOut.email = { enviado: true, para: emailDestino };
      } catch (e) {
        payloadOut.email = { enviado: false, erro: e?.response?.body || String(e) };
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payloadOut);
  } catch (err) {
    console.error('Erro /api/roteiro:', err);
    return res.status(500).json({ error: 'Falha interna.' });
  }
}
