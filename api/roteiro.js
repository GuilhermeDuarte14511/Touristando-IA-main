// /api/roteiro.js
export const config = { runtime: 'nodejs' }; // Serverless Node.js (Vercel)

import sgMail from '@sendgrid/mail';

/* ----------------------- utils ----------------------- */

// Escapar HTML (usado só no resumo de e-mail)
const escapeHtml = (s = '') =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Ler env e “limpar” aspas e espaços
function env(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

// fetch com timeout
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// parse robusto de JSON/texto
async function safeJson(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

// formatar data (pt-BR)
function fmtDate(d = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}

// moeda BRL (sem casas para faixas “vitrine”)
function fmtMoneyBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 }).format(v);
}
// número BR com casas fixas (para equivalência de câmbio)
function fmtNumberBR(v, decimals = 2) {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(v);
}

/* ----------------------- handler ----------------------- */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 🔑 OpenAI
  const OPENAI_API_KEY = env('OPENAI_API_KEY');
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
    // Body (compatível com diferentes runtimes)
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!Object.keys(body).length && req.headers['content-type']?.includes('application/json')) {
      try {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      } catch { body = {}; }
    }

    // Entrada: aceita destino (país/estado/região/cidade). Mantém compat com "pais".
    const destinoEntrada =
      body.destino?.toString().trim() ||
      body.pais?.toString().trim() ||
      body.estado?.toString().trim() ||
      body.cidade?.toString().trim();

    const dias = Number(body.dias ?? 5);
    const pessoas = Math.max(1, Number(body.pessoas ?? 1));
    const perfil = (body.perfil || 'normal').toString();
    const estilo = (body.estilo || 'casual').toString(); // casual | aventura | romântica
    const emailDestino = (body.emailDestino || '').toString().trim() || null;

    // orçamentos
    const orcamento =
      (body.orcamento !== undefined && body.orcamento !== null && body.orcamento !== '')
        ? Number(body.orcamento) : null;

    const orcamentoPorPessoa =
      (body.orcamento_por_pessoa !== undefined && body.orcamento_por_pessoa !== null && body.orcamento_por_pessoa !== '')
        ? Number(body.orcamento_por_pessoa) : null;

    // Deriva total ou por pessoa se faltarem
    const orcTotal = (orcamento && orcamento > 0)
      ? orcamento
      : (orcamentoPorPessoa && pessoas > 0 ? orcamentoPorPessoa * pessoas : null);

    const orcPerPerson = (orcamentoPorPessoa && orcamentoPorPessoa > 0)
      ? orcamentoPorPessoa
      : (orcTotal && pessoas > 0 ? orcTotal / pessoas : null);

    if (!destinoEntrada) {
      return res.status(400).json({ error: 'Informe o destino (país/estado/cidade) no campo "destino" (ou "pais").' });
    }
    if (!Number.isFinite(dias) || dias <= 0) {
      return res.status(400).json({ error: 'O campo "dias" deve ser um número > 0.' });
    }

    /* ---------- 1) Normalizar destino + moeda via OpenAI (JSON) ---------- */
    const classifyMsg = [
      { role: 'system',
        content:
`Você extrai metadados geográficos e de moeda. Responda SOMENTE com JSON válido (sem comentários).
Dado um destino (país, estado, região ou cidade), retorne:
{
  "normalized_name": string,
  "region_type": "country"|"state"|"city"|"region",
  "country_name": string,
  "country_code": string,
  "currency_code": string,
  "currency_name": string
}` },
      { role: 'user', content: `Destino: ${destinoEntrada}` }
    ];

    const classifyResp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: classifyMsg
      })
    }, 25000);

    if (!classifyResp.ok) {
      const errTxt = await classifyResp.text();
      return res.status(classifyResp.status).json({ error: 'Falha ao classificar destino', raw: errTxt });
    }
    const clsData = await safeJson(classifyResp);
    const meta = (() => {
      try {
        const m = clsData?.choices?.[0]?.message?.content
          ? JSON.parse(clsData.choices[0].message.content)
          : clsData; // já é json se response_format funcionou
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
          normalized_name: destinoEntrada,
          region_type: 'region',
          country_name: '',
          country_code: '',
          currency_code: 'USD',
          currency_name: 'Dólar'
        };
      }
    })();

    /* ---------- 2) Câmbio BRL <-> moeda do destino ---------- */
    let fx = {
      base: 'BRL',
      quote: meta.currency_code || 'USD',
      brl_to_quote: 0,     // 1 BRL -> ? QUOTE
      quote_to_brl: 0,     // 1 QUOTE -> ? BRL
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
    } catch {
      // Em caso de falha, mantém 0 (modelo irá usar somente BRL)
    }

    // Brief de orçamento
    const faixa = (() => {
      const partes = [];
      partes.push(`Grupo: ${pessoas} pessoa(s).`);
      if (orcTotal && orcTotal > 0) partes.push(`Orçamento total: ${fmtMoneyBRL(orcTotal)}.`);
      if (orcPerPerson && orcPerPerson > 0) partes.push(`≈ ${fmtMoneyBRL(orcPerPerson)} por pessoa.`);
      if (!partes.length) partes.push('Sem orçamento declarado; use faixas típicas do destino.');
      return partes.join(' ');
    })();

    /* ---------- 3) Prompt principal (HTML completo, sem Markdown) ---------- */
    const convHeader = (fx.quote !== 'BRL' && fx.brl_to_quote)
      ? `Taxa usada (exchangerate.host, ${fx.date}): 1 BRL = ${fx.brl_to_quote.toFixed(4)} ${fx.quote}  (1 ${fx.quote} ≈ R$ ${fmtNumberBR(fx.quote_to_brl)})`
      : `Moeda local: BRL. Mostre os valores apenas em R$.`;

    const destinoLabel =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}, ${meta.country_name}`
        : (meta.normalized_name || destinoEntrada);

    const estiloBrief = ({
      casual: 'Misture clássicos turísticos com tempo livre e opções flexíveis.',
      aventura: 'Priorize trilhas, natureza, esportes e experiências ao ar livre; inclua avisos de segurança.',
      'romântica': 'Foque passeios cênicos, restaurantes charmosos e experiências a dois.'
    })[estilo] || 'Misture clássicos turísticos com tempo livre e opções flexíveis.';

    // estilos inline para tabelas bonitas no tema escuro da UI
    const tableStyle = `style="width:100%;border-collapse:collapse;margin:8px 0;font-size:.98rem"`;
    const thStyle = `style="text-align:left;padding:8px 10px;border:1px solid #2a3358;background:#0e1429;color:#fff"`;
    const tdStyle = `style="padding:8px 10px;border:1px solid #2a3358;color:#fff"`;

    const mainPrompt =
`Você é um planner de viagens sênior.
Responda **apenas com HTML válido**, em **PT-BR**, sem qualquer Markdown, sem blocos de código e sem texto fora do HTML.
Retorne um único **fragmento HTML** começando por:
<div class="trip-plan" data-render="roteiro"> ... </div>
Não inclua <html>, <head> ou <body>. Não use <script> nem <style>; use apenas estilos **inline** quando necessário.

Contexto do pedido:
- Destino: ${destinoLabel}
- Dias: ${dias}
- Pessoas: ${pessoas}
- Perfil: ${perfil}
- Estilo: ${estilo}
- Brief: ${faixa}
- Conversão: ${convHeader}
- Regras de moeda:
  • Sempre mostre valores em BRL e na moeda local (${meta.currency_code}).  
  • Formato: "R$ 120 (~${meta.currency_code} 21,60)".  
  • Conversões: BRL→${meta.currency_code} = valor_BR * ${fx.brl_to_quote || 0} ;  ${meta.currency_code}→BRL = valor_LOC * ${fx.quote_to_brl || 0}.
  • Se a moeda local for BRL, use apenas R$.

Estrutura obrigatória (HTML):
<section>
  <h2>0. Resumo do Planejamento</h2>
  <!-- Gerar TABELA HTML 2 colunas (Campo | Valor) -->
  <table ${tableStyle}>
    <thead><tr><th ${thStyle}>Campo</th><th ${thStyle}>Valor</th></tr></thead>
    <tbody>
      <!-- preencher: Destino, Dias, Pessoas, Perfil, Estilo, Orçamento total (se houver), Orçamento por pessoa (se houver), Moeda local, Taxa utilizada (texto exatamente: "${convHeader}") -->
    </tbody>
  </table>
</section>

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
    <!-- 6–10 itens; preferir nomes confiáveis de hotéis/pousadas ou bairros/zonas + cadeia comum; incluir bairro/zona, categoria (econômico/médio/superior) e diária média (BRL + ${meta.currency_code}); não incluir links/telefones -->
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
  <!-- Para D1..D${dias}, gerar subtítulos <h3>Dia X</h3> e listas com 2–4 atividades (manhã/tarde/noite); custos quando pagos (BRL + ${meta.currency_code}). -->
</section>

<section>
  <h2>6. Orçamento Resumido</h2>
  <h3>Tabela 1 — Custos por dia (faixas)</h3>
  <!-- TABELA HTML com colunas: Item | Dia 1..Dia ${dias} | Subtotal/Dia ; cada célula traz R$ e (~${meta.currency_code}). -->
  <table ${tableStyle}>
    <thead>
      <tr>
        <th ${thStyle}>Item</th>
        <!-- gerar cabeçalhos Dia 1..Dia ${dias} -->
        <th ${thStyle}>Subtotal/Dia</th>
      </tr>
    </thead>
    <tbody><!-- preencher linhas: Hospedagem / Alimentação / Transporte / Atrações --></tbody>
  </table>

  <h3>Tabela 2 — Quadro-resumo do grupo</h3>
  <!-- TABELA HTML 2 colunas (Métrica | Valor) contendo: Total do período (grupo), Total por pessoa, Por dia (grupo), Por pessoa/dia) em R$ e (${meta.currency_code}) -->
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

Regras finais:
- HTML limpo, sem floreios excessivos.
- Sem links/telefones.
- Não invente preços exatos de passagens; use faixas realistas e indique que são estimativas.`;

    const messages = [
      { role: 'system', content: 'Você é um travel planner sênior. Responda APENAS com HTML válido (fragmento), em PT-BR, sem Markdown.' },
      { role: 'user', content: mainPrompt }
    ];

    /* ---------- 4) Chamada OpenAI (conteúdo) ---------- */
    const aiResp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages
      })
    }, 60000);

    const aiData = await safeJson(aiResp);
    if (!aiResp.ok) {
      return res.status(aiResp.status).json({
        error: aiData?.error?.message || aiData?._raw || 'Falha na OpenAI'
      });
    }

    // Agora 'texto' já é HTML
    const htmlFragment = aiData?.choices?.[0]?.message?.content || '';
    const payloadOut = {
      ok: true,
      // manter a mesma chave usada na UI (agora contendo HTML):
      texto: htmlFragment,
      meta: {
        destino: destinoLabel,
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
      // dica opcional para o frontend (se quiser usar):
      render_as: 'html'
    };

    /* ---------- 5) Envio por e-mail (opcional) ---------- */
    // Monta uma tabela-resumo elegante para o e-mail (fixo)
    const emailResumoTabela = (() => {
      const row = (k, v) => `
        <tr>
          <td style="padding:8px 10px;border:1px solid #eceff4;background:#f8fafc;color:#111;font-weight:600;width:40%">${escapeHtml(k)}</td>
          <td style="padding:8px 10px;border:1px solid #eceff4;color:#111">${escapeHtml(v)}</td>
        </tr>`;
      const rows = [];
      rows.push(row('Destino', destinoLabel));
      rows.push(row('Dias', String(dias)));
      rows.push(row('Pessoas', String(pessoas)));
      rows.push(row('Perfil', perfil));
      rows.push(row('Estilo', estilo));
      rows.push(row('Moeda local', meta.currency_code || 'BRL'));
      if (fx.brl_to_quote) {
        rows.push(row('Taxa usada', `1 BRL = ${fx.brl_to_quote.toFixed(4)} ${meta.currency_code}  (1 ${meta.currency_code} ≈ R$ ${fmtNumberBR(fx.quote_to_brl)}) — ${fx.date}`));
      } else {
        rows.push(row('Taxa usada', 'Moeda local: BRL (sem conversão)'));
      }
      if (orcTotal && orcTotal > 0) rows.push(row('Orçamento total', fmtMoneyBRL(orcTotal)));
      if (orcPerPerson && orcPerPerson > 0) rows.push(row('Orçamento por pessoa', fmtMoneyBRL(orcPerPerson)));
      return `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #eaeaea;border-radius:8px;overflow:hidden">
          ${rows.join('')}
        </table>`;
    })();

    if (emailDestino && SENDGRID_API_KEY && MAIL_FROM) {
      const assunto = `Roteiro • ${destinoLabel} • ${BRAND_NAME}`;
      // usa o próprio HTML gerado (sem escapar), dentro de um container de e-mail
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
      <h2 style="margin:0 0 6px 0;font-size:18px;color:#111">Roteiro: ${escapeHtml(destinoLabel)}</h2>
      <div>
        ${htmlFragment || '<p>(sem conteúdo)</p>'}
      </div>
      <p style="color:#667085;font-size:12px;margin-top:14px">Gerado automaticamente por ${BRAND_NAME}. Valores são estimativas e podem variar conforme data e disponibilidade.</p>
    </td></tr>
  </table>
</div>
      `.trim();

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
