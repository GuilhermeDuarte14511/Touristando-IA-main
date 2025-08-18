// /api/roteiro.js
export const config = { runtime: 'nodejs' }; // Serverless Node.js (Vercel)

import sgMail from '@sendgrid/mail';

// Util: escapar HTML para e-mail
const escapeHtml = (s = '') =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Helper: lê env e “limpa” aspas e espaços
function env(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 🔑 OpenAI
  const OPENAI_API_KEY = env('OPENAI_API_KEY');
  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'OPENAI_API_KEY não configurada no projeto (Vercel).'
    });
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

    const {
      pais,
      dias = 5,
      orcamento,
      perfil = 'normal',
      emailDestino
    } = body;

    if (!pais || !String(pais).trim()) {
      return res.status(400).json({ error: 'Informe o país (campo "pais").' });
    }

    const faixa = (orcamento && Number(orcamento) > 0)
      ? `Orçamento total: R$ ${Number(orcamento).toFixed(2)}.`
      : 'Sem orçamento declarado; use faixas típicas.';

    const prompt = `
Você é um planner de viagens. Crie um roteiro para o país: ${pais}.
Regras:
- Duração: ${dias} dia(s); perfil: ${perfil}.
- ${faixa}
- Em PT-BR (Markdown) com:
  1) Visão geral (cidade-base + 1–2 alternativas)
  2) Roteiro dia a dia (D1..D${dias}) com 2–4 atividades/dia
  3) Estimativa de custos (faixas em BRL): hospedagem/dia, alimentação/dia,
     transporte local/dia, atrações/dia; inclua subtotal/dia e total do período
  4) Dicas rápidas (transporte, segurança, clima/época)
- Não invente preços exatos de voos/hotéis; use FAIXAS típicas do destino.
`.trim();

    // 🧠 OpenAI (parse robusto)
    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages: [
          { role: 'system', content: 'Você dá respostas práticas e objetivas em PT-BR.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    const aiRaw = await aiResp.text();
    let aiData;
    try { aiData = JSON.parse(aiRaw || '{}'); } catch { aiData = {}; }

    if (!aiResp.ok) {
      return res.status(aiResp.status).json({
        error: aiData?.error?.message || aiRaw || 'Falha na OpenAI'
      });
    }

    const texto = aiData?.choices?.[0]?.message?.content || '(sem conteúdo)';
    const result = { ok: true, texto };

    // ✉️ E-mail opcional com SendGrid
    if (emailDestino && SENDGRID_API_KEY && MAIL_FROM) {
      const assunto = `Roteiro • ${pais} • ${BRAND_NAME}`;
      const html = `
<div style="font-family:Arial,Helvetica,sans-serif;padding:24px;background:#f6f9fc">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #eaeaea;border-radius:12px;overflow:hidden">
    <tr>
      <td style="background:#0d6efd;color:#fff;padding:16px 20px">
        ${LOGO_URL ? `<img src="${LOGO_URL}" alt="${BRAND_NAME}" height="28" style="vertical-align:middle;border-radius:6px;background:#fff;padding:3px;margin-right:8px">` : ''}
        <strong style="font-size:16px;vertical-align:middle">${BRAND_NAME}</strong>
      </td>
    </tr>
    <tr><td style="padding:18px 20px">
      <h2 style="margin:0 0 8px 0;font-size:18px;color:#111">Roteiro: ${escapeHtml(pais)}</h2>
      <div style="color:#475467;font-size:14px;margin-bottom:14px">
        Dias: <strong>${dias}</strong> • Perfil: <strong>${escapeHtml(perfil)}</strong> • ${escapeHtml(faixa)}
      </div>
      <div style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:14px;line-height:1.5;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:12px">
${escapeHtml(texto)}
      </div>
      <p style="color:#667085;font-size:12px;margin-top:14px">Gerado automaticamente por ${BRAND_NAME}.</p>
    </td></tr>
  </table>
</div>
      `.trim();

      try {
        await sgMail.send({ to: emailDestino, from: MAIL_FROM, subject: assunto, text: texto, html });
        result.email = { enviado: true, para: emailDestino };
      } catch (e) {
        result.email = { enviado: false, erro: e?.response?.body || String(e) };
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Erro /api/roteiro:', err);
    return res.status(500).json({ error: 'Falha interna.' });
  }
}
