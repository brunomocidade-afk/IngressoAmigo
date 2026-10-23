const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./db');
const { enviarTokenEmail } = require('./mailer');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_ingresso_amigo';

// Servir arquivos estáticos da pasta 'public'
app.use(express.static(path.join(__dirname, '../public')));

// Middleware de Proteção para Rotas Admin (JWT)
function autenticarAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acesso não autorizado. Faça login.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    req.user = user;
    next();
  });
}

// -----------------------------------------------------------------------------
// 1. ROTAS DE AUTENTICAÇÃO (LOGIN POR TOKEN DE 6 DÍGITOS)
// -----------------------------------------------------------------------------

// A. SOLICITAR TOKEN
app.post('/api/auth/solicitar-token', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });

  try {
    const emailLimpo = email.toLowerCase().trim();

    // Verifica se o e-mail está cadastrado como organizador ativo
    const orgRes = await db.query(
      'SELECT * FROM organizadores WHERE email = $1 AND ativo = true',
      [emailLimpo]
    );

    if (orgRes.rows.length === 0) {
      return res.status(403).json({ error: 'E-mail não autorizado como organizador.' });
    }

    // Gerar token de 6 dígitos e expiração para 15 minutos
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const expiraEm = new Date(Date.now() + 15 * 60 * 1000);

    // Salvar token no banco de dados
    await db.query(
      'INSERT INTO tokens_acesso (email, token, expira_em) VALUES ($1, $2, $3)',
      [emailLimpo, token, expiraEm]
    );

    console.log(`🔑 TOKEN DE ACESSO GERADO PARA [${emailLimpo}]: ${token}`);

    // Tenta enviar via e-mail com fallback para o log/console
    try {
      await enviarTokenEmail(emailLimpo, token);
      res.json({ message: 'Código de acesso enviado para o seu e-mail!' });
    } catch (emailErr) {
      console.error('Aviso: Falha no envio do e-mail via SMTP:', emailErr.message);
      res.json({
        message: 'Código de acesso gerado! Digite o código de 6 dígitos para entrar.'
      });
    }

  } catch (err) {
    console.error('Erro ao processar solicitação de acesso:', err);
    res.status(500).json({ error: 'Erro ao processar solicitação de acesso.' });
  }
});

// VALIDAR TOKEN E GERAR SESSÃO (JWT)
app.post('/api/auth/validar-token', async (req, res) => {
  const { email, token } = req.body;

  if (!email || !token) {
    return res.status(400).json({ error: 'E-mail e token são obrigatórios.' });
  }

  try {
    const emailLimpo = email.toLowerCase().trim();

    const tokenRes = await db.query(
      'SELECT * FROM tokens_acesso WHERE email = $1 AND token = $2 AND usado = false AND expira_em > NOW() ORDER BY expira_em DESC LIMIT 1',
      [emailLimpo, token.trim()]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(401).json({ error: 'Código inválido ou expirado.' });
    }

    // Marcar token como utilizado
    await db.query('UPDATE tokens_acesso SET usado = true WHERE id = $1', [tokenRes.rows[0].id]);

    // Buscar organizador
    const orgRes = await db.query('SELECT id, nome, email FROM organizadores WHERE email = $1', [emailLimpo]);
    const organizador = orgRes.rows[0];

    // Buscar IDs dos eventos associados
    const eventosRes = await db.query(
      'SELECT evento_id FROM organizadores_eventos WHERE organizador_id = $1',
      [organizador.id]
    );
    const eventosPermitidos = eventosRes.rows.map(r => r.evento_id);

    // Gerar JWT com os IDs dos eventos
    const sessionToken = jwt.sign(
      { id: organizador.id, email: organizador.email, eventos: eventosPermitidos },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token: sessionToken, nome: organizador.nome });
  } catch (err) {
    console.error('Erro ao validar token:', err);
    res.status(500).json({ error: 'Erro ao validar código.' });
  }
});

// LISTAR PEDIDOS PARA O PAINEL ADMIN
app.get('/api/admin/pedidos', autenticarAdmin, async (req, res) => {
  try {
    const eventosPermitidos = req.user.eventos || [];

    // Se o organizador não tiver nenhum evento vinculado, retorna array vazio sem erro
    if (eventosPermitidos.length === 0) {
      return res.json([]);
    }

    const queryText = `
      SELECT p.id, p.created_at, p.nome_comprador, p.cpf_comprador, p.whatsapp, p.valor_total, p.status,
             e.titulo as evento_titulo, i.codigo_hash 
      FROM pedidos p
      JOIN eventos e ON e.id = p.evento_id
      LEFT JOIN ingressos i ON i.pedido_id = p.id
      WHERE p.evento_id = ANY($1::uuid[])
      ORDER BY p.created_at DESC;
    `;
    const { rows } = await db.query(queryText, [eventosPermitidos]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
}); 

// -----------------------------------------------------------------------------
// 2. ROTAS PÚBLICAS DO SISTEMA
// -----------------------------------------------------------------------------

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'API Online', timestamp: new Date() });
});

// Listar Eventos Ativos
app.get('/api/eventos', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM eventos WHERE ativo = true ORDER BY data_evento ASC');
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar eventos:', err);
    res.status(500).json({ error: 'Erro ao buscar eventos no banco de dados' });
  }
});

app.get('/api/admin/pedidos', autenticarAdmin, async (req, res) => {
  try {
    // Garante que seja uma matriz válida, mesmo se for nula no JWT
    const eventosPermitidos = (req.user.eventos && req.user.eventos[0] !== null) ? req.user.eventos : [];

    if (eventosPermitidos.length === 0) {
      // Se não tiver nenhum evento associado, retorna lista vazia sem dar erro
      return res.json([]);
    }

    const queryText = `
      SELECT p.id, p.created_at, p.nome_comprador, p.cpf_comprador, p.whatsapp, p.valor_total, p.status,
             e.titulo as evento_titulo, i.codigo_hash 
      FROM pedidos p
      JOIN eventos e ON e.id = p.evento_id
      LEFT JOIN ingressos i ON i.pedido_id = p.id
      WHERE p.evento_id = ANY($1::uuid[])
      ORDER BY p.created_at DESC;
    `;
    const { rows } = await db.query(queryText, [eventosPermitidos]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});
// -----------------------------------------------------------------------------
// 3. ROTAS ADMINISTRATIVAS PROTEGIDAS
// -----------------------------------------------------------------------------

// Listar Pedidos Filtrados pelos Eventos do Organizador Logado
app.get('/api/admin/pedidos', autenticarAdmin, async (req, res) => {
  try {
    const eventosPermitidos = req.user.eventos || [];

    const queryText = `
      SELECT p.id, p.created_at, p.nome_comprador, p.cpf_comprador, p.whatsapp, p.valor_total, p.status,
             e.titulo as evento_titulo, i.codigo_hash 
      FROM pedidos p
      JOIN eventos e ON e.id = p.evento_id
      LEFT JOIN ingressos i ON i.pedido_id = p.id
      WHERE p.evento_id = ANY($1::uuid[])
      ORDER BY p.created_at DESC;
    `;
    const { rows } = await db.query(queryText, [eventosPermitidos]);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// Aprovar PIX Manualmente e Gerar Ingresso
app.post('/api/admin/pedidos/:id/aprovar', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  const { confirmado_por } = req.body;

  try {
    const updatePedidoQuery = `
      UPDATE pedidos 
      SET status = 'APROVADO', confirmado_por = $1, confirmado_em = CURRENT_TIMESTAMP
      WHERE id = $2 AND status = 'PENDENTE'
      RETURNING *;
    `;
    const pedidoResult = await db.query(updatePedidoQuery, [confirmado_por || req.user.email, id]);

    if (pedidoResult.rows.length === 0) {
      return res.status(400).json({ error: 'Pedido não encontrado ou já foi processado' });
    }

    const pedido = pedidoResult.rows[0];
    const codigoHash = crypto.randomUUID();

    const insertIngressoQuery = `
      INSERT INTO ingressos (pedido_id, codigo_hash, status_uso)
      VALUES ($1, $2, 'DISPONIVEL')
      RETURNING *;
    `;
    const ingressoResult = await db.query(insertIngressoQuery, [pedido.id, codigoHash]);

    res.json({
      message: 'PIX aprovado com sucesso! Ingresso e QR Code gerados.',
      pedido: pedido,
      ingresso: ingressoResult.rows[0]
    });
  } catch (err) {
    console.error('Erro ao aprovar PIX:', err);
    res.status(500).json({ error: 'Erro ao processar aprovação de pagamento' });
  }
});

// -----------------------------------------------------------------------------
// 4. ROTA DA PORTARIA (VALIDAÇÃO DE ENTRADA)
// -----------------------------------------------------------------------------

app.post('/api/portaria/validar', async (req, res) => {
  const { codigo_hash, cpf_comprador, validado_por } = req.body;

  if (!codigo_hash && !cpf_comprador) {
    return res.status(400).json({ status: 'ERRO', message: 'Informe o QR Code ou o CPF.' });
  }

  try {
    let queryText = '';
    let params = [];

    if (codigo_hash) {
      queryText = `
        SELECT i.*, p.nome_comprador, p.cpf_comprador, p.status as status_pedido, e.titulo as evento_titulo
        FROM ingressos i
        JOIN pedidos p ON p.id = i.pedido_id
        JOIN eventos e ON e.id = p.evento_id
        WHERE i.codigo_hash = $1;
      `;
      params = [codigo_hash];
    } else {
      queryText = `
        SELECT i.*, p.nome_comprador, p.cpf_comprador, p.status as status_pedido, e.titulo as evento_titulo
        FROM ingressos i
        JOIN pedidos p ON p.id = i.pedido_id
        JOIN eventos e ON e.id = p.evento_id
        WHERE p.cpf_comprador = $1 AND p.status = 'APROVADO';
      `;
      params = [cpf_comprador];
    }

    const { rows } = await db.query(queryText, params);

    if (rows.length === 0) {
      return res.status(404).json({
        status: 'INVALIDO',
        message: 'Ingresso não encontrado ou pagamento não aprovado!'
      });
    }

    const ingresso = rows[0];

    if (ingresso.status_uso === 'UTILIZADO') {
      return res.status(400).json({
        status: 'JA_UTILIZADO',
        message: `ATENÇÃO: Ingresso JÁ UTILIZADO em ${new Date(ingresso.utilizado_em).toLocaleString('pt-BR')}!`,
        participante: ingresso.nome_comprador,
        evento: ingresso.evento_titulo
      });
    }

    const updateQuery = `
      UPDATE ingressos 
      SET status_uso = 'UTILIZADO', utilizado_em = CURRENT_TIMESTAMP, validado_por = $1
      WHERE id = $2
      RETURNING *;
    `;
    await db.query(updateQuery, [validado_por || 'Portaria', ingresso.id]);

    return res.json({
      status: 'SUCESSO',
      message: 'ENTRADA LIBERADA!',
      participante: ingresso.nome_comprador,
      cpf: ingresso.cpf_comprador,
      evento: ingresso.evento_titulo
    });

  } catch (err) {
    console.error('Erro na validação da portaria:', err);
    res.status(500).json({ status: 'ERRO', message: 'Erro interno ao validar ingresso.' });
  }
});

// Inicialização do Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});