// /api/roteiro.js
export const config = { runtime: 'nodejs' }; // Serverless Node.js (Vercel)

import sgMail from '@sendgrid/mail';

/* ----------------------- utils ----------------------- */

// Escapar HTML (para e-mail)
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

// parse robusto de JSON
async function safeJson(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

// formatar data (pt-BR)
function fmtDate(d = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}

// arredondar bonito para moeda
function fmtMoneyBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 }).format(v);
}
function fmtMoneyGeneric(v, code) {
  return new Intl.NumberFormat('pt-BR', { style:'currency', currency:code }).format(v);
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
    const orcamento = (body.orcamento !== undefined && body.orcamento !== null && body.orcamento !== '') ? Number(body.orcamento) : null;
    const perfil = (body.perfil || 'normal').toString();
    const emailDestino = (body.emailDestino || '').toString().trim() || null;

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
  "normalized_name": string,               // Nome normalizado (ex.: "Califórnia", "Lisboa", "Japão")
  "region_type": "country"|"state"|"city"|"region",
  "country_name": string,                  // País ao qual pertence
  "country_code": string,                  // ISO-3166-1 alfa-2, se souber (ex.: "US","BR","PT")
  "currency_code": string,                 // ISO 4217 principal usada lá (ex.: "USD","EUR","BRL")
  "currency_name": string                  // Nome da moeda
}`
      },
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
      // Se moeda local for BRL, taxa é 1:1
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

    // Texto de faixa/brief de orçamento
    const faixa = (orcamento && orcamento > 0)
      ? `Orçamento total informado: ${fmtMoneyBRL(orcamento)}.`
      : 'Sem orçamento declarado; use faixas típicas do destino.';

    /* ---------- 3) Prompt principal (atrações, hotéis, transportes, custos) ---------- */
    // Diretrizes de conversão
    const convHeader = (fx.quote !== 'BRL' && fx.brl_to_quote)
      ? `Taxa usada (exchangerate.host, ${fx.date}): 1 BRL = ${fx.brl_to_quote.toFixed(4)} ${fx.quote}  (1 ${fx.quote} ≈ ${fmtMoneyBRL(fx.quote_to_brl)})`
      : `Moeda local: BRL. Mostre os valores apenas em R$.`;

    const destinoLabel =
      (meta.normalized_name && meta.country_name && meta.country_name !== meta.normalized_name)
        ? `${meta.normalized_name}, ${meta.country_name}`
        : (meta.normalized_name || destinoEntrada);

    // Instruções ricas para o modelo
    const mainPrompt =
`Gere um roteiro detalhado **em PT-BR** para **${destinoLabel}**, considerando **${dias} dia(s)** e perfil **${perfil}**.
${faixa}

Requisitos obrigatórios:
- **Estrita estrutura em Markdown** com as seções abaixo.
- **Sempre** mostre valores **em R$** e **na moeda local (${meta.currency_code})** usando **apenas** a taxa abaixo (não inventar outra):
  ${convHeader}
  - Se a moeda local for BRL, use somente R$.
  - Formate como: \`R$ 120 (~USD 21.60)\` ou \`R$ 120\` se BRL.
  - Para converter: \`BRL -> ${meta.currency_code}\` = valor_BR * ${fx.brl_to_quote || 0}, \`${meta.currency_code} -> BRL\` = valor_LOC * ${fx.quote_to_brl || 0}.
- Não invente preços exatos de voos; use **faixas típicas** e deixe claro que são estimativas.

Seções (nesta ordem):
1. **Visão Geral**  
   - Melhor cidade-base (e 1–2 alternativas).  
   - Melhor época e clima; segurança e deslocamento entre bairros/cidades.  

2. **Atrações Imperdíveis**  
   - Liste **de 8 a 15** atrações com breve descrição e **faixa de preço** (se paga) **nos dois formatos de moeda**.

3. **Hospedagem Recomendada (6–10)**  
   - Liste hotéis/pousadas com **bairro/zona**, **categoria (econômico/médio/superior)** e **diária média** em ambos os formatos de moeda.  
   - Se não tiver certeza de nomes específicos, priorize **bairros e cadeias comuns** com **faixas** realistas. Não invente telefones ou links.

4. **Transporte Local**  
   - Opções (metrô/ônibus/app/táxi/passe/trem interurbano), **faixas de preço** por trecho/diária em BRL e ${meta.currency_code}.  
   - Inclua trechos típicos (aeroporto→centro, centro→bairros turísticos) quando fizer sentido.

5. **Roteiro Dia a Dia (D1..D${dias})**  
   - 2–4 atividades/sugestões por dia (manhã/tarde/noite), com pequenas observações de custo (se pago) **nos dois formatos**.

6. **Orçamento Resumido**  
   - Tabela com **faixas por dia** para: **hospedagem**, **alimentação**, **transporte**, **atrações**.  
   - Inclua **subtotal/dia** e **total do período** em BRL e ${meta.currency_code}, usando a taxa informada.

7. **Dicas Rápidas**  
   - Etiqueta local, chips/eSIM, gorjetas, tomada/voltagem, apps úteis, bairros para evitar à noite (se aplicável).

Observações:
- Seja **prático**, **objetivo** e evite floreios.
- Quando a informação for muito variável, **use faixas** (mín–méd–máx) e deixe explícito que são estimativas.
- Não crie links nem números de contato.`;

    // Montar mensagens para OpenAI
    const messages = [
      { role: 'system', content: 'Você é um travel planner sênior. Sempre responda em PT-BR com Markdown limpo e objetivo.' },
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

    const texto = aiData?.choices?.[0]?.message?.content || '(sem conteúdo)';
    const payloadOut = {
      ok: true,
      texto,
      meta: {
        destino: destinoLabel,
        region_type: meta.region_type,
        country: meta.country_name || null,
        currency_code: meta.currency_code,
        currency_name: meta.currency_name || null,
        fx: {
          brl_to_local: fx.brl_to_quote,
          local_to_brl: fx.quote_to_brl,
          date: fx.date
        }
      }
    };

    /* ---------- 5) Envio por e-mail (opcional) ---------- */
    if (emailDestino && SENDGRID_API_KEY && MAIL_FROM) {
      const assunto = `Roteiro • ${destinoLabel} • ${BRAND_NAME}`;
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
      <h2 style="margin:0 0 6px 0;font-size:18px;color:#111">Roteiro: ${escapeHtml(destinoLabel)}</h2>
      <div style="color:#475467;font-size:13px;margin-bottom:8px">
        Dias: <strong>${dias}</strong> • Perfil: <strong>${escapeHtml(perfil)}</strong>
      </div>
      <div style="color:#475467;font-size:12px;margin-bottom:12px">
        ${escapeHtml(convHeader)}
      </div>
      <div style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:14px;line-height:1.55;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:12px">
${escapeHtml(texto)}
      </div>
      <p style="color:#667085;font-size:12px;margin-top:14px">Gerado automaticamente por ${BRAND_NAME}. Valores são estimativas e podem variar conforme data e disponibilidade.</p>
    </td></tr>
  </table>
</div>
      `.trim();

      try {
        await sgMail.send({ to: emailDestino, from: MAIL_FROM, subject: assunto, text: texto, html });
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
