const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

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
app.get('/api/admin/pedidos', async (req, res) => {
  try {
    const queryText = `
      SELECT p.*, e.titulo as evento_titulo 
      FROM pedidos p
      JOIN eventos e ON e.id = p.evento_id
      ORDER BY p.created_at DESC;
    `;
    const { rows } = await db.query(queryText);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

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