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

// parse robusto de JSON/texto
async function safeJson(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

// formatar data (pt-BR)
function fmtDate(d = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}

// moeda BRL
function fmtMoneyBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 }).format(v);
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
  "normalized_name": string,               // Nome normalizado (ex.: "Califórnia", "Lisboa", "Japão")
  "region_type": "country"|"state"|"city"|"region",
  "country_name": string,                  // País ao qual pertence
  "country_code": string,                  // ISO-3166-1 alfa-2, se souber (ex.: "US","BR","PT")
  "currency_code": string,                 // ISO 4217 principal usada lá (ex.: "USD","EUR","BRL")
  "currency_name": string                  // Nome da moeda
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

    /* ---------- 3) Prompt principal (atrações, hotéis, transportes, custos) ---------- */
    const convHeader = (fx.quote !== 'BRL' && fx.brl_to_quote)
      ? `Taxa usada (exchangerate.host, ${fx.date}): 1 BRL = ${fx.brl_to_quote.toFixed(4)} ${fx.quote}  (1 ${fx.quote} ≈ ${fmtMoneyBRL(fx.quote_to_brl)})`
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

    const mainPrompt =
`Gere um roteiro detalhado **em PT-BR** para **${destinoLabel}**, considerando **${dias} dia(s)**, **${pessoas} pessoa(s)**, perfil **${perfil}** e estilo **${estilo}**.
${faixa}

Requisitos obrigatórios:
- **Estrutura em Markdown** nas seções abaixo, com títulos numerados.
- **Sempre** mostre valores **em R$** e **na moeda local (${meta.currency_code})** usando **somente** a taxa abaixo (não invente outra):
  ${convHeader}
  - Se a moeda local for BRL, use somente R$.
  - Formate como: \`R$ 120 (~${meta.currency_code} 21.60)\` ou apenas \`R$ 120\` se BRL.
  - Converta usando: \`BRL -> ${meta.currency_code}\` = valor_BR * ${fx.brl_to_quote || 0}, \`${meta.currency_code} -> BRL\` = valor_LOC * ${fx.quote_to_brl || 0}.
- Não invente preços exatos de voos ou hotéis específicos; use **faixas típicas** e deixe claro que são estimativas.

Personalização:
- ${estiloBrief}

Seções (nesta ordem):
1. **Visão Geral**  
   - Melhor cidade-base (e 1–2 alternativas).  
   - Melhor época e clima; segurança e deslocamento entre bairros/cidades.  

2. **Atrações Imperdíveis**  
   - Liste **8–15** atrações com breve descrição e **faixa de preço** (se paga) **nos dois formatos de moeda**.

3. **Hospedagem Recomendada (6–10)**  
   - Liste hotéis/pousadas ou **bairros recomendados** com **categoria** (econômico/médio/superior) e **diária média** (BRL + ${meta.currency_code}).  
   - Se não tiver certeza de nomes, use **bairros/zonas e cadeias comuns**. **Não crie links** nem telefones.

4. **Transporte Local**  
   - Opções (metrô/ônibus/app/táxi/passe/trem interurbano), **faixas de preço** por trecho/diária (BRL + ${meta.currency_code}).  
   - Inclua trechos típicos (aeroporto→centro, centro→bairros turísticos) quando fizer sentido.

5. **Roteiro Dia a Dia (D1..D${dias})**  
   - Para cada dia, sugira 2–4 atividades (manhã/tarde/noite).  
   - Informe custos quando pagos, **sempre** (BRL + ${meta.currency_code}).

6. **Orçamento Resumido**  
   - **Tabela 1 — Custos por dia (faixas)**: colunas para **Hospedagem**, **Alimentação**, **Transporte**, **Atrações**, **Subtotal/Dia** — todos em **BRL** e, na mesma célula, o valor convertido em ${meta.currency_code} entre parênteses.  
   - **Tabela 2 — Quadro-resumo do grupo** (usando ${pessoas} pessoa(s) e ${dias} dia(s)):  
     | Métrica | Valor |  
     |---|---|  
     | **Total do período (grupo)** | em R$ e ${meta.currency_code} |  
     | **Total por pessoa** | em R$ e ${meta.currency_code} |  
     | **Por dia (grupo)** | em R$ e ${meta.currency_code} |  
     | **Por pessoa/dia** | em R$ e ${meta.currency_code} |  
   - Se um orçamento foi informado (${orcTotal ? fmtMoneyBRL(orcTotal) : 'não informado'} total / ${orcPerPerson ? fmtMoneyBRL(orcPerPerson) : 'não informado'} p/pessoa), **use-o para ancorar as faixas**.

7. **Dicas Rápidas**  
   - Etiqueta local, chips/eSIM, gorjetas, tomada/voltagem, apps úteis, bairros a evitar (se aplicável).

Observações:
- Seja **prático** e **objetivo**.  
- Quando a informação for muito variável, **use faixas (mín–méd–máx)** e sinalize como estimativa.  
- **Não crie links** nem telefones.`;

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
      <div style="color:#475467;font-size:13px;margin-bottom:6px">
        Dias: <strong>${dias}</strong> • Pessoas: <strong>${pessoas}</strong> • Perfil: <strong>${escapeHtml(perfil)}</strong> • Estilo: <strong>${escapeHtml(estilo)}</strong>
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
