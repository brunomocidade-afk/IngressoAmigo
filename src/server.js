const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const jwt = require('jsonwebtoken');
const { enviarTokenEmail } = require('./mailer');
const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_ingresso_amigo';

// 1. SOLICITAR TOKEN
app.post('/api/auth/solicitar-token', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });

  try {
    // Verifica se o e-mail está cadastrado na tabela de organizadores
    const orgRes = await db.query('SELECT * FROM organizadores WHERE email = $1 AND ativo = true', [email.toLowerCase().trim()]);
    if (orgRes.rows.length === 0) {
      return res.status(403).json({ error: 'E-mail não autorizado como organizador.' });
    }

    // Gerar token aleatório de 6 dígitos
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const expiraEm = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Salvar token no banco
    await db.query(
      'INSERT INTO tokens_acesso (email, token, expira_em) VALUES ($1, $2, $3)',
      [email.toLowerCase().trim(), token, expiraEm]
    );

    // Enviar por e-mail
    await enviarTokenEmail(email, token);

    res.json({ message: 'Código de acesso enviado para o seu e-mail!' });
  } catch (err) {
    console.error('Erro ao enviar e-mail com token:', err);
    res.status(500).json({ error: 'Erro ao enviar e-mail. Verifique as configurações SMTP.' });
  }
});

// 2. VALIDAR TOKEN E GERAR SESSÃO (JWT)
app.post('/api/auth/validar-token', async (req, res) => {
  const { email, token } = req.body;

  try {
    const tokenRes = await db.query(
      'SELECT * FROM tokens_acesso WHERE email = $1 AND token = $2 AND usado = false AND expira_em > NOW() ORDER BY created_at DESC LIMIT 1',
      [email.toLowerCase().trim(), token]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(401).json({ error: 'Código inválido ou expirado.' });
    }

    // Marcar token como usado
    await db.query('UPDATE tokens_acesso SET usado = true WHERE id = $1', [tokenRes.rows[0].id]);

    // Buscar dados do organizador e seus eventos permitidos
    const orgRes = await db.query(`
      SELECT o.id, o.nome, o.email, array_agg(oe.evento_id) as eventos_permitidos
      FROM organizadores o
      LEFT JOIN organizadores_eventos oe ON oe.organizador_id = o.id
      WHERE o.email = $1
      GROUP BY o.id
    `, [email.toLowerCase().trim()]);

    const organizador = orgRes.rows[0];

    // Gerar JWT válido por 8 horas
    const sessionToken = jwt.sign(
      { id: organizador.id, email: organizador.email, eventos: organizador.eventos_permitidos },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token: sessionToken, nome: organizador.nome });
  } catch (err) {
    console.error('Erro ao validar token:', err);
    res.status(500).json({ error: 'Erro ao validar código.' });
  }
});

// Servir arquivos estáticos (HTML/CSS/JS) da pasta 'public'
app.use(express.static(path.join(__dirname, '../public')));

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'API Online', timestamp: new Date() });
});

// 2. Listar Eventos Ativos (Visão do Comprador)
app.get('/api/eventos', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM eventos WHERE ativo = true ORDER BY data_evento ASC');
    res.json(rows);
  } catch (err) {
    console.error('Erro na consulta:', err);
    res.status(500).json({ error: 'Erro ao buscar eventos no banco de dados' });
  }
});

// 3. Criar Pedido Pendente (Comprador envia CPF/Nome e recebe os dados do PIX)
app.post('/api/pedidos', async (req, res) => {
  const { evento_id, cpf_comprador, nome_comprador, whatsapp, valor_total } = req.body;

  if (!evento_id || !cpf_comprador || !nome_comprador || !valor_total) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes (evento_id, cpf, nome, valor)' });
  }

  try {
    const queryText = `
      INSERT INTO pedidos (evento_id, cpf_comprador, nome_comprador, whatsapp, valor_total, status)
      VALUES ($1, $2, $3, $4, $5, 'PENDENTE')
      RETURNING *;
    `;
    const values = [evento_id, cpf_comprador, nome_comprador, whatsapp, valor_total];
    const { rows } = await db.query(queryText, values);

    res.status(201).json({
      message: 'Pedido registrado com sucesso! Aguardando confirmação do PIX.',
      pedido: rows[0]
    });
  } catch (err) {
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao registrar pedido' });
  }
});

// 4. Listar Pedidos para Painel Admin (Financeiro)
function autenticarAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acesso não autorizado. Faça login.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Sessão expirada. Faça login novamente.' });
    req.user = user;
    next();
  });
}

// Aplicar na rota de busca de pedidos:
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

/*app.get('/api/admin/pedidos', async (req, res) => {
  try {
    const queryText = `
      SELECT p.id, p.created_at, p.nome_comprador, p.cpf_comprador, p.whatsapp, p.valor_total, p.status,
             e.titulo as evento_titulo, i.codigo_hash 
      FROM pedidos p
      JOIN eventos e ON e.id = p.evento_id
      LEFT JOIN ingressos i ON i.pedido_id = p.id
      ORDER BY p.created_at DESC;
    `;
    const { rows } = await db.query(queryText);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
}); */

// 5. Aprovar PIX Manualmente e Gerar Ingresso com QR Code Hash (Financeiro)
app.post('/api/admin/pedidos/:id/aprovar', async (req, res) => {
  const { id } = req.params; // ID do pedido
  const { confirmado_por } = req.body; // Nome do operador voluntário

  try {
    // A. Atualizar o status do pedido para APROVADO
    const updatePedidoQuery = `
      UPDATE pedidos 
      SET status = 'APROVADO', confirmado_por = $1, confirmado_em = CURRENT_TIMESTAMP
      WHERE id = $2 AND status = 'PENDENTE'
      RETURNING *;
    `;
    const pedidoResult = await db.query(updatePedidoQuery, [confirmado_por || 'Operador Admin', id]);

    if (pedidoResult.rows.length === 0) {
      return res.status(400).json({ error: 'Pedido não encontrado ou já foi processado' });
    }

    const pedido = pedidoResult.rows[0];

    // B. Gerar Hash Único para o QR Code do Ingresso
    const codigoHash = crypto.randomUUID(); // Gera um UUIDv4 único e seguro

    // C. Inserir o Ingresso na Tabela de Ingressos
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

// 6. Validar Ingresso na Portaria (Leitura de QR Code ou Busca por CPF)
app.post('/api/portaria/validar', async (req, res) => {
  const { codigo_hash, cpf_comprador, validado_por } = req.body;

  if (!codigo_hash && !cpf_comprador) {
    return res.status(400).json({ status: 'ERRO', message: 'Informe o QR Code ou o CPF.' });
  }

  try {
    let queryText = '';
    let params = [];

    if (codigo_hash) {
      // Busca pelo Hash do QR Code
      queryText = `
        SELECT i.*, p.nome_comprador, p.cpf_comprador, p.status as status_pedido, e.titulo as evento_titulo
        FROM ingressos i
        JOIN pedidos p ON p.id = i.pedido_id
        JOIN eventos e ON e.id = p.evento_id
        WHERE i.codigo_hash = $1;
      `;
      params = [codigo_hash];
    } else {
      // Busca manual alternativa por CPF na portaria
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

    // Verificar se já foi utilizado anteriormente
    if (ingresso.status_uso === 'UTILIZADO') {
      return res.status(400).json({
        status: 'JA_UTILIZADO',
        message: `ATENÇÃO: Ingresso JÁ UTILIZADO em ${new Date(ingresso.utilizado_em).toLocaleString('pt-BR')}!`,
        participante: ingresso.nome_comprador,
        evento: ingresso.evento_titulo
      });
    }

    // Se estiver disponível, marca como UTILIZADO no banco de dados
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});