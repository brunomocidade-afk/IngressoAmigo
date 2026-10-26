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

// RELATÓRIO DE VENDAS POR EVENTO (PROTEGIDO POR JWT)
app.get('/api/admin/relatorio', autenticarAdmin, async (req, res) => {
  const { evento_id, status_pix } = req.query;

  try {
    const eventosPermitidos = req.user.eventos || [];

    if (eventosPermitidos.length === 0) {
      return res.json({ resumo: {}, pedidos: [] });
    }

    // Se nenhum evento específico for selecionado, usa o primeiro permitido
    const idEventoAlvo = evento_id || eventosPermitidos[0];

    // 1. Buscar informações e limites do evento
    const eventoRes = await db.query(
      'SELECT id, titulo, valor_ingresso, limite_ingressos, chave_pix FROM eventos WHERE id = $1',
      [idEventoAlvo]
    );

    if (eventoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evento não encontrado.' });
    }

    const evento = eventoRes.rows[0];

    // 2. Montar filtro por status de pagamento do PIX
    let filtroStatus = '';
    let params = [idEventoAlvo];

    if (status_pix === 'APROVADO') {
      filtroStatus = " AND p.status = 'APROVADO'";
    } else if (status_pix === 'PENDENTE') {
      filtroStatus = " AND p.status = 'PENDENTE'";
    }

    // 3. Consultar pedidos do evento
    const queryPedidos = `
      SELECT p.id, p.created_at, p.nome_comprador, p.cpf_comprador, p.whatsapp, p.valor_total, p.status,
             p.confirmado_por, p.confirmado_em
      FROM pedidos p
      WHERE p.evento_id = $1 ${filtroStatus}
      ORDER BY p.created_at DESC;
    `;
    const { rows: pedidos } = await db.query(queryPedidos, params);

    // 4. Calcular métricas consolidadas
    const queryTotais = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'APROVADO') as total_aprovados,
        COUNT(*) FILTER (WHERE status = 'PENDENTE') as total_pendentes,
        COALESCE(SUM(valor_total) FILTER (WHERE status = 'APROVADO'), 0) as receita_aprovada,
        COALESCE(SUM(valor_total) FILTER (WHERE status = 'PENDENTE'), 0) as receita_pendente
      FROM pedidos 
      WHERE evento_id = $1;
    `;
    const { rows: totais } = await db.query(queryTotais, [idEventoAlvo]);
    const metricas = totais[0];

    const totalAprovados = parseInt(metricas.total_aprovados) || 0;
    const limiteIngressos = evento.limite_ingressos || 0;
    const totalDisponiveis = Math.max(0, limiteIngressos - totalAprovados);

    res.json({
      evento: {
        titulo: evento.titulo,
        valor_ingresso: evento.valor_ingresso,
        limite_ingressos: limiteIngressos,
        total_disponiveis: totalDisponiveis
      },
      resumo: {
        total_aprovados: totalAprovados,
        total_pendentes: parseInt(metricas.total_pendentes) || 0,
        receita_aprovada: parseFloat(metricas.receita_aprovada),
        receita_pendente: parseFloat(metricas.receita_pendente)
      },
      pedidos: pedidos
    });

  } catch (err) {
    console.error('Erro ao gerar relatório:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório de vendas.' });
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

// 3. Criar Pedido Pendente (Comprador envia CPF/Nome e recebe os dados do PIX)
app.post('/api/pedidos', async (req, res) => {
  const { evento_id, cpf_comprador, nome_comprador, whatsapp, valor_total } = req.body;

  if (!evento_id || !cpf_comprador || !nome_comprador) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes (evento_id, cpf, nome)' });
  }

  try {
    let valorFinal = parseFloat(valor_total);

    // Se o valor_total não veio do frontend, busca direto do evento no banco
    if (isNaN(valorFinal) || !valorFinal) {
      const eventoRes = await db.query('SELECT valor_ingresso FROM eventos WHERE id = $1', [evento_id]);
      if (eventoRes.rows.length > 0 && eventoRes.rows[0].valor_ingresso) {
        valorFinal = parseFloat(eventoRes.rows[0].valor_ingresso);
      } else {
        valorFinal = 0.00; // Valor padrão caso não cadastrado
      }
    }

    const queryText = `
      INSERT INTO pedidos (evento_id, cpf_comprador, nome_comprador, whatsapp, valor_total, status)
      VALUES ($1, $2, $3, $4, $5, 'PENDENTE')
      RETURNING *;
    `;
    const values = [evento_id, cpf_comprador, nome_comprador, whatsapp, valorFinal];
    const { rows } = await db.query(queryText, values);

    res.status(201).json({
      message: 'Pedido registrado com sucesso! Aguardando confirmação do PIX.',
      pedido: rows[0]
    });
  } catch (err) {
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao registrar pedido no banco de dados.' });
  }
});
// -----------------------------------------------------------------------------
// 3. ROTAS ADMINISTRATIVAS PROTEGIDAS
// -----------------------------------------------------------------------------

// CADASTRAR NOVO EVENTO E VINCULAR AO ORGANIZADOR LOGADO
app.post('/api/admin/eventos', autenticarAdmin, async (req, res) => {
  const { titulo, descricao, data_evento, valor_ingresso, local_evento, chave_pix } = req.body;

  if (!titulo || !data_evento || !valor_ingresso || !chave_pix) {
    return res.status(400).json({ error: 'Campos obrigatórios: título, data, valor e chave PIX.' });
  }

  try {
    // 1. Inserir o novo evento no banco
    const queryEvento = `
      INSERT INTO eventos (titulo, descricao, data_evento, valor_ingresso, local_evento, chave_pix, ativo)
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING *;
    `;
    const valuesEvento = [titulo, descricao, data_evento, valor_ingresso, local_evento, chave_pix];
    const { rows: eventosCriados } = await db.query(queryEvento, valuesEvento);
    const novoEvento = eventosCriados[0];

    // 2. Vincular automaticamente o novo evento ao organizador logado
    const queryVinculo = `
      INSERT INTO organizadores_eventos (organizador_id, evento_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING;
    `;
    await db.query(queryVinculo, [req.user.id, novoEvento.id]);

    res.status(201).json({
      message: 'Evento cadastrado e vinculado com sucesso!',
      evento: novoEvento
    });

  } catch (err) {
    console.error('Erro ao cadastrar evento:', err);
    res.status(500).json({ error: 'Erro ao cadastrar novo evento no banco de dados.' });
  }
});

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